"""
core/face.py — face detection and identity embeddings.

Two backends, selected by FACE_ENGINE:

  arcface  (default)  insightface buffalo_l — SCRFD detection + ArcFace
                      (w600k_r50) embeddings, ONNX, CPU-friendly.
  facenet  (legacy)   facenet-pytorch — MTCNN + InceptionResnetV1 / vggface2.

Why the default changed
-----------------------
Measured on LFW with 3-image centroid templates (tools/calibrate.py), padded so
both detectors see the same margin around the face:

                        facenet/vggface2      ArcFace/buffalo_l
    separation (d)               5.52                    9.51
    impostor max                0.726                   0.293
    genuine min                 0.621                   0.385
    threshold for 0 FAR    0.726 -> 5.62% FRR    0.293 -> 0.00% FRR

The decisive difference is that the facenet distributions *overlap* — its worst
impostor (0.726) scores above its weakest genuine pair (0.621), so no threshold
exists that rejects every stranger without also rejecting real users. ArcFace
leaves a clean gap between 0.293 and 0.385, which is what makes a confident
operating point possible at all.

Templates are not portable between backends. The two networks embed into
different spaces, so a similarity computed across them is meaningless — not
merely inaccurate. Every stored template therefore records the engine that
produced it, and a mismatch forces re-enrolment rather than being scored
anyway. See `template_engine_matches`.

Both backends run on a single-worker executor: the models are not safe to call
concurrently, and serialising them here keeps that guarantee in one place.
"""
import asyncio
import base64
import concurrent.futures
import hashlib
import logging
import math
import threading
from dataclasses import dataclass
from typing import List, Optional, Tuple

import cv2
import numpy as np

from core.config import settings

logger = logging.getLogger(__name__)

ARCFACE = "arcface"
FACENET = "facenet"
ENGINE = settings.FACE_ENGINE.strip().lower()
if ENGINE not in (ARCFACE, FACENET):
    raise ValueError(f"FACE_ENGINE must be '{ARCFACE}' or '{FACENET}', got '{ENGINE}'.")

# Reported on /health and in logs; the old code exposed a torch device here.
DEVICE = "cpu"

_lock = threading.Lock()
_backend = None


def _load_backend():
    """Build the selected backend once, on first use."""
    global _backend
    if _backend is not None:
        return _backend
    with _lock:
        if _backend is not None:
            return _backend
        if ENGINE == ARCFACE:
            from insightface.app import FaceAnalysis

            app = FaceAnalysis(
                name=settings.ARCFACE_MODEL,
                providers=["CPUExecutionProvider"],
                # Detection and recognition only. The age/gender and 68-point
                # landmark models in the pack are unused here, and loading them
                # costs memory and startup time for nothing.
                allowed_modules=["detection", "recognition"],
            )
            app.prepare(ctx_id=-1, det_size=(640, 640))
            _backend = app
            logger.info("Face engine: insightface %s (SCRFD + ArcFace)", settings.ARCFACE_MODEL)
        else:
            import torch
            from facenet_pytorch import MTCNN, InceptionResnetV1

            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            mtcnn = MTCNN(
                image_size=160, margin=20, min_face_size=80,
                thresholds=[0.6, 0.7, 0.7], factor=0.709,
                post_process=True, device=device, keep_all=True,
            )
            resnet = InceptionResnetV1(pretrained="vggface2").eval().to(device)
            _backend = (mtcnn, resnet, device)
            logger.info("Face engine: facenet-pytorch on %s (legacy)", device)
    return _backend


def warm_up() -> None:
    """Load the models now rather than on the first user's login."""
    _load_backend()


# Single worker — serialises all model access.
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="face")


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------
class ImageTooLarge(ValueError):
    """Raised when a base64 payload exceeds the configured size limit."""


def image_fingerprint(img_b64: str) -> str:
    """Stable hash of the raw (pre-decode) image payload — used for replay detection."""
    raw = img_b64.split(",", 1)[1] if "," in img_b64 else img_b64
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def decode_image(img_b64: str, max_side: int = 640) -> Optional[np.ndarray]:
    """
    Decode a base64 (optionally data-URI) image into a BGR OpenCV array,
    downscaled so its longest side is at most `max_side`.

    Returns None when the payload is not a decodable image.
    Raises ImageTooLarge when the payload exceeds the configured limit.
    """
    raw = img_b64.split(",", 1)[1] if "," in img_b64 else img_b64
    if len(raw) > settings.max_b64_chars:
        raise ImageTooLarge(
            f"Image exceeds the {settings.MAX_IMAGE_SIZE_MB:.0f} MB size limit."
        )
    try:
        nparr = np.frombuffer(base64.b64decode(raw), np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        h, w = img.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / max(h, w)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        return img
    except Exception as e:  # noqa: BLE001 — any decode failure is "not an image"
        logger.warning("Image decode failed: %s", e)
        return None


def sharpness(img_bgr: np.ndarray) -> float:
    """Variance of the Laplacian — a standard blur score. Higher is sharper."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
@dataclass
class Detection:
    """One detected face: pixel-space box, confidence, and the 5 MTCNN landmarks."""
    box: np.ndarray        # (4,)   x1, y1, x2, y2
    prob: float
    points: np.ndarray     # (5,2)  left_eye, right_eye, nose, mouth_left, mouth_right
    n_faces: int           # how many faces were in the frame overall

    @property
    def width(self) -> float:
        return float(self.box[2] - self.box[0])

    @property
    def height(self) -> float:
        return float(self.box[3] - self.box[1])

    @property
    def center(self) -> Tuple[float, float]:
        return (float(self.box[0] + self.box[2]) / 2.0, float(self.box[1] + self.box[3]) / 2.0)


def _unit(vec: np.ndarray) -> Optional[List[float]]:
    arr = np.asarray(vec, dtype=np.float64).flatten()
    norm = np.linalg.norm(arr)
    if norm == 0 or not np.isfinite(norm):
        return None
    return (arr / norm).tolist()


def _arcface_faces(img_bgr: np.ndarray):
    """All faces SCRFD found, largest first."""
    faces = _load_backend().get(img_bgr)
    if not faces:
        return []
    return sorted(
        faces,
        key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
        reverse=True,
    )


def _arcface_detection(face, n_faces: int) -> Detection:
    return Detection(
        box=np.asarray(face.bbox, dtype=np.float64),
        prob=float(getattr(face, "det_score", 0.0)),
        # SCRFD returns the same 5 points MTCNN did: eyes, nose, mouth corners.
        points=np.asarray(face.kps, dtype=np.float64),
        n_faces=n_faces,
    )


def _detect_and_embed_sync(img_bgr: np.ndarray) -> Tuple[Optional[Detection], Optional[List[float]]]:
    """
    Detect the largest face and embed it in one pass.

    One pass matters: the embedding needs the detector's landmarks to align the
    crop, so detecting separately would run the detector twice per frame.
    """
    if ENGINE == ARCFACE:
        faces = _arcface_faces(img_bgr)
        if not faces:
            return None, None
        best = faces[0]
        det = _arcface_detection(best, len(faces))
        return det, _unit(best.embedding)

    # ── legacy facenet path ──
    import torch
    from facenet_pytorch.models.utils.detect_face import extract_face
    from PIL import Image

    mtcnn, resnet, device = _load_backend()
    pil = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
    boxes, probs, points = mtcnn.detect(pil, landmarks=True)
    if boxes is None or len(boxes) == 0:
        return None, None
    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
    i = int(np.argmax(areas))
    det = Detection(
        box=np.asarray(boxes[i], dtype=np.float64),
        prob=float(probs[i]) if probs is not None else 0.0,
        points=np.asarray(points[i], dtype=np.float64),
        n_faces=len(boxes),
    )
    tensor = extract_face(pil, det.box, image_size=160, margin=20)
    if tensor is None:
        return det, None
    tensor = (tensor - 127.5) / 128.0        # fixed_image_standardization
    with torch.no_grad():
        vec = resnet(tensor.unsqueeze(0).to(device))
    return det, _unit(vec.cpu().numpy())


def _detect_sync(img_bgr: np.ndarray) -> Optional[Detection]:
    """Detect the largest face without embedding it."""
    if ENGINE == ARCFACE:
        faces = _arcface_faces(img_bgr)
        return _arcface_detection(faces[0], len(faces)) if faces else None
    return _detect_and_embed_sync(img_bgr)[0]


def _embed_sync(img_bgr: np.ndarray) -> Optional[List[float]]:
    """L2-normalised embedding of the largest face, or None if there is none."""
    return _detect_and_embed_sync(img_bgr)[1]


# ---------------------------------------------------------------------------
# Async wrappers — all model work is funnelled through the single worker
# ---------------------------------------------------------------------------
async def detect(img_bgr: np.ndarray) -> Optional[Detection]:
    return await asyncio.get_running_loop().run_in_executor(_executor, _detect_sync, img_bgr)


async def embed(img_bgr: np.ndarray) -> Optional[List[float]]:
    return await asyncio.get_running_loop().run_in_executor(_executor, _embed_sync, img_bgr)


async def detect_and_embed(img_bgr: np.ndarray) -> Tuple[Optional[Detection], Optional[List[float]]]:
    return await asyncio.get_running_loop().run_in_executor(
        _executor, _detect_and_embed_sync, img_bgr
    )


# ---------------------------------------------------------------------------
# Similarity
# ---------------------------------------------------------------------------
def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Cosine similarity, clamped to [-1, 1]. Returns 0.0 on degenerate input."""
    a_arr = np.asarray(a, dtype=np.float64)
    b_arr = np.asarray(b, dtype=np.float64)
    if a_arr.shape != b_arr.shape or a_arr.size == 0:
        return 0.0
    if not np.all(np.isfinite(a_arr)) or not np.all(np.isfinite(b_arr)):
        return 0.0
    na, nb = np.linalg.norm(a_arr), np.linalg.norm(b_arr)
    if na == 0 or nb == 0:
        return 0.0
    sim = float(np.dot(a_arr, b_arr) / (na * nb))
    if not math.isfinite(sim):
        return 0.0
    return max(-1.0, min(1.0, sim))


def centroid(embeddings: List[List[float]]) -> Optional[List[float]]:
    """
    The L2-normalised mean of a set of embeddings — the enrolled template.

    Averaging first and comparing once is the whole point: it cancels the
    per-frame noise in any single capture, and a probe has to resemble the
    person *as a whole* rather than just their single most flattering frame.
    """
    if not embeddings:
        return None
    arr = np.asarray(embeddings, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[0] == 0:
        return None
    mean = arr.mean(axis=0)
    norm = np.linalg.norm(mean)
    if norm == 0 or not np.isfinite(norm):
        return None
    return (mean / norm).tolist()


def template_similarity(live: List[float], template: List[float]) -> float:
    """Similarity between a live embedding and an enrolled centroid."""
    return cosine_similarity(live, template)


def self_consistency(embeddings: List[List[float]]) -> float:
    """
    Lowest similarity between any enrolled embedding and the centroid of the set.

    This is the guard against a poisoned template. If a second person is caught
    in frame during enrolment, one stored vector belongs to them — and because
    verification would otherwise be free to match *that* vector, the stranger
    authenticates. Measured on LFW, one wrong vector in three pushes the false
    accept rate from 0.1% to 3.0%. Catching it at enrolment is the fix.
    """
    c = centroid(embeddings)
    if c is None or len(embeddings) < 2:
        return 1.0
    return min(cosine_similarity(e, c) for e in embeddings)


def robust_centroid(
    embeddings: List[List[float]], min_agreement: float
) -> Tuple[Optional[List[float]], int]:
    """
    Build a template, discarding vectors that disagree with the majority.

    Returns (template, n_discarded).

    Accounts enrolled before the anti-poisoning guards existed may already hold
    a stranger's embedding — from a bystander caught in frame, or a frame where
    the detector locked onto the wrong face. Rebuilding the centroid from only
    the agreeing vectors disarms that at verification time, rather than locking
    the rightful owner out of the account they need in order to re-enrol.
    """
    if not embeddings:
        return None, 0
    c = centroid(embeddings)
    if c is None:
        return None, 0
    if len(embeddings) < 3:
        # Too few to tell an outlier from a genuine pose; use them as they are.
        return c, 0

    agreements = [cosine_similarity(e, c) for e in embeddings]
    inliers = [e for e, a in zip(embeddings, agreements) if a >= min_agreement]
    discarded = len(embeddings) - len(inliers)
    if not inliers:
        return c, 0
    if discarded == 0:
        return c, 0
    return centroid(inliers), discarded


def template_engine_matches(stored_engine: Optional[str]) -> bool:
    """
    Whether a stored template was produced by the engine now running.

    Untagged templates predate engine tagging, and every one of those was made
    by facenet — so they are treated as facenet rather than assumed compatible.
    Scoring a template from the other backend would not be merely less accurate;
    the two networks embed into unrelated spaces, so the number would be noise.
    """
    return (stored_engine or FACENET) == ENGINE


def best_similarity(live: List[float], stored: List[List[float]]) -> float:
    """
    Highest similarity between a live embedding and any single stored vector.

    Retained only for scoring legacy templates enrolled before centroids were
    stored. Prefer template_similarity: taking the maximum is the most
    permissive aggregator there is, so a single bad stored vector is enough to
    let a stranger through.
    """
    if not stored:
        return 0.0
    return max(cosine_similarity(live, s) for s in stored)
