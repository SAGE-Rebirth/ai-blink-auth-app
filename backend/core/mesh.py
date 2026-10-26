"""
core/mesh.py — server-side 478-point face mesh (MediaPipe FaceLandmarker).

Why this exists
---------------
Liveness used to be judged by comparing *pixels* in the eye region against a
control region. That was fragile: the patches were contrast-normalised, and the
nose bridge is a low-texture area, so dividing by its small standard deviation
amplified sensor noise into a large "control delta". In a busy room with
ordinary head drift the control delta rivalled the eye delta and the ratio
collapsed — genuine blinks were rejected with "the whole frame changed".

The robust way to ask "did the eyes close" is geometry, not brightness. The mesh
gives eyelid contours directly, so we compute the Eye Aspect Ratio the same way
the browser does — but on the server, where it cannot be forged.

    EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)

EAR is a ratio of distances within the eye, so it is invariant to lighting,
exposure, camera distance and image scale. Those were precisely the things that
broke the pixel approach.

A note on identity
------------------
The mesh is *not* used for face matching, and deliberately so. Measured on 200
LFW pairs, a scale- and rotation-normalised mesh signature separates genuine
from impostor pairs with only ~60% accuracy (Cohen's d ≈ 0.24) — barely better
than chance — because MediaPipe fits a canonical template that regresses toward
a generic face and discards much of what makes an individual distinctive. The
CNN embedding in core/face.py is far stronger on the same data. So the mesh
answers "are these eyes open or shut", and the embedding answers "is this the
same person". See tools/calibrate.py to reproduce both numbers.
"""
import logging
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = MODEL_DIR / "face_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)

# Eyelid contours, ordered p1..p6 for the EAR formula. Same indices the browser
# uses in utils/faceMesh.js, so client and server measure the same quantity.
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]

_landmarker = None
# MediaPipe's FaceLandmarker is not safe to call concurrently.
_lock = threading.Lock()


def ensure_model() -> Path:
    """Download the landmarker model on first use (~3.6 MB). Idempotent."""
    if MODEL_PATH.exists():
        return MODEL_PATH
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading face landmarker model to %s …", MODEL_PATH)
    tmp = MODEL_PATH.with_suffix(".part")
    urllib.request.urlopen(MODEL_URL, timeout=60)  # fail fast on no network
    urllib.request.urlretrieve(MODEL_URL, tmp)
    tmp.replace(MODEL_PATH)
    logger.info("Face landmarker model ready.")
    return MODEL_PATH


def _get_landmarker():
    global _landmarker
    if _landmarker is None:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        ensure_model()
        options = vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=2,          # detect a second face so we can refuse the frame
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        )
        _landmarker = vision.FaceLandmarker.create_from_options(options)
        logger.info("MediaPipe FaceLandmarker initialised.")
    return _landmarker


@dataclass
class Mesh:
    """One detected face mesh, in pixel coordinates."""
    points: np.ndarray     # (478, 3)
    n_faces: int
    width: float
    height: float
    center: tuple

    @property
    def ear(self) -> float:
        """Average Eye Aspect Ratio across both eyes."""
        return (eye_aspect_ratio(self.points, LEFT_EYE)
                + eye_aspect_ratio(self.points, RIGHT_EYE)) / 2.0


def eye_aspect_ratio(points: np.ndarray, indices) -> float:
    """
    EAR for one eye: vertical lid separation over horizontal eye width.

    Because it is a ratio of distances measured inside the same eye, it does not
    move with lighting, exposure or how close the user is sitting — which is
    what makes it a far steadier blink signal than any pixel comparison.
    """
    p = points[indices][:, :2]
    horizontal = float(np.linalg.norm(p[0] - p[3]))
    if horizontal <= 1e-6:
        return 0.0
    vertical = float(np.linalg.norm(p[1] - p[5])) + float(np.linalg.norm(p[2] - p[4]))
    return vertical / (2.0 * horizontal)


# Interior skin patches, away from eyes, mouth, hair and the face outline —
# the places where illumination lands on plain diffuse skin.
SKIN_LANDMARKS = (50, 280, 151, 10, 205, 425)


def skin_color(img_bgr: np.ndarray, mesh: "Mesh") -> Optional[np.ndarray]:
    """
    Median BGR of several small skin patches, as float in 0..1.

    The median (rather than the mean) keeps a stray specular highlight — a
    glasses glint, a bright pixel of glare — from dragging the reading.
    """
    h, w = img_bgr.shape[:2]
    side = max(4.0, mesh.width * 0.08)
    half = int(round(side / 2))

    samples = []
    for idx in SKIN_LANDMARKS:
        if idx >= len(mesh.points):
            continue
        cx, cy = int(round(mesh.points[idx][0])), int(round(mesh.points[idx][1]))
        x1, y1 = max(0, cx - half), max(0, cy - half)
        x2, y2 = min(w, cx + half), min(h, cy + half)
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue
        patch = img_bgr[y1:y2, x1:x2].reshape(-1, 3)
        samples.append(np.median(patch, axis=0))

    if not samples:
        return None
    return np.median(np.asarray(samples, dtype=np.float64), axis=0) / 255.0


def detect_mesh_sync(img_bgr: np.ndarray) -> Optional[Mesh]:
    """Detect the largest face's mesh. Returns None when there is no face."""
    import mediapipe as mp

    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    with _lock:
        result = _get_landmarker().detect(mp_image)

    if not result.face_landmarks:
        return None

    h, w = img_bgr.shape[:2]
    # Pick the largest face by landmark spread, consistent with core/face.py.
    best, best_area = None, -1.0
    for face_landmarks in result.face_landmarks:
        pts = np.array([[p.x * w, p.y * h, p.z * w] for p in face_landmarks], dtype=np.float64)
        span_x = pts[:, 0].max() - pts[:, 0].min()
        span_y = pts[:, 1].max() - pts[:, 1].min()
        if span_x * span_y > best_area:
            best, best_area = pts, span_x * span_y

    span_x = best[:, 0].max() - best[:, 0].min()
    span_y = best[:, 1].max() - best[:, 1].min()
    return Mesh(
        points=best,
        n_faces=len(result.face_landmarks),
        width=float(span_x),
        height=float(span_y),
        center=(float(best[:, 0].mean()), float(best[:, 1].mean())),
    )
