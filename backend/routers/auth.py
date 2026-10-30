"""
auth.py — Authentication & admin router.

Face pipeline lives in core/face.py (MTCNN detection + InceptionResnetV1
embeddings, pure PyTorch). Liveness lives in core/liveness.py. This module is
routes, policy and persistence only.

Security model
--------------
  * Login is a two-step handshake: fetch a single-use challenge, then submit a
    three-frame blink bundle quoting it. The server re-derives liveness from the
    pixels — the browser's EAR check is a usability aid, never a control.
  * Frame hashes are remembered, so a bundle cannot be replayed under a fresh
    challenge.
  * Failed attempts lock the *account* for a cooling-off period, on top of the
    per-IP rate limit, so an attacker cannot simply rotate source addresses.
  * First registered user becomes admin; admins manage roles from there.

Blocking work
-------------
pymongo is synchronous, so every database call is pushed to the threadpool
rather than run on the event loop. The face models have their own single-worker
executor inside core/face.py.
"""
import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from core import challenges, face, liveness, mesh, pad
from core.config import settings
from core.database import db
from core.limiter import limiter
from core.security import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    get_current_user,
    require_admin,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])

TOTAL_REGISTRATION_IMAGES = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class UserRegister(BaseModel):
    name: str
    phone: str
    masked_id: str
    images: List[str] = Field(..., description="Base64 JPEG frames, one per capture pose")

    @field_validator("name")
    @classmethod
    def name_must_be_valid(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @field_validator("phone")
    @classmethod
    def phone_must_be_valid(cls, v: str) -> str:
        v = v.strip()
        if not re.match(r"^\+?\d{7,15}$", v):
            raise ValueError("Invalid phone number format (7-15 digits).")
        return v

    @field_validator("images")
    @classmethod
    def images_must_have_three(cls, v: List[str]) -> List[str]:
        if len(v) != TOTAL_REGISTRATION_IMAGES:
            raise ValueError(f"Exactly {TOTAL_REGISTRATION_IMAGES} face images are required.")
        return v


class CheckUserPayload(BaseModel):
    phone: str


class ChallengePayload(BaseModel):
    phone: str


class LivenessFrame(BaseModel):
    """One frame of a blink bundle."""
    phase: str
    t_ms: float
    image: str
    ear: Optional[float] = None   # client-measured, logged for tuning, never trusted

    @field_validator("phase")
    @classmethod
    def phase_must_be_known(cls, v: str) -> str:
        known = v in liveness.REQUIRED_PHASES or v == pad.BASELINE_PHASE or (
            v.startswith(pad.ILLUMINATION_PHASE_PREFIX)
            and v[len(pad.ILLUMINATION_PHASE_PREFIX):].isdigit()
        )
        if not known:
            raise ValueError(f"Unknown frame phase '{v}'.")
        return v


class UserVerify(BaseModel):
    phone: str
    challenge_id: Optional[str] = None
    frames: Optional[List[LivenessFrame]] = None
    # Single-frame fallback. Only honoured when REQUIRE_LIVENESS is False.
    image: Optional[str] = None


class RefreshPayload(BaseModel):
    refresh_token: str


class UserUpdate(BaseModel):
    name: Optional[str] = None
    masked_id: Optional[str] = None


class UserFaceUpdate(BaseModel):
    images: List[str]

    @field_validator("images")
    @classmethod
    def images_must_have_three(cls, v: List[str]) -> List[str]:
        if len(v) != TOTAL_REGISTRATION_IMAGES:
            raise ValueError(f"Exactly {TOTAL_REGISTRATION_IMAGES} face images are required.")
        return v


# ---------------------------------------------------------------------------
# Persistence helpers — every pymongo call goes through the threadpool
# ---------------------------------------------------------------------------
def _collection():
    conn = db.get_db()
    if conn is None:
        raise HTTPException(status_code=503, detail="Database is unavailable.")
    return conn[settings.COLLECTION_NAME]


async def _find_one(query: dict, projection: Optional[dict] = None):
    col = _collection()
    return await run_in_threadpool(col.find_one, query, projection)


async def _update_one(query: dict, update: dict):
    col = _collection()
    return await run_in_threadpool(col.update_one, query, update)


async def mesh_detect(img_bgr):
    """Run the face mesh off the event loop."""
    return await run_in_threadpool(mesh.detect_mesh_sync, img_bgr)


# ---------------------------------------------------------------------------
# Embedding extraction with quality gates
# ---------------------------------------------------------------------------
async def _embed_enrollment_images(
    images_b64: List[str],
) -> Tuple[List[List[float]], List[float]]:
    """
    Turn enrolment images into (per-image embeddings, centroid template),
    refusing anything that would make a weak or poisoned template.

    Note there is deliberately no horizontal-flip augmentation here. Mirroring
    every image doubles the number of vectors a login is compared against, and
    since verification takes the *best* match, that directly doubles the chance
    of a false accept — while adding almost no genuine information, because a
    mirrored frontal face embeds nearly identically to the original. Real pose
    coverage comes from the three guided capture angles instead.
    """
    decoded = []
    for idx, img_b64 in enumerate(images_b64, start=1):
        try:
            img = face.decode_image(img_b64)
        except face.ImageTooLarge as e:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e))
        if img is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Image {idx} could not be read. Please retake it.",
            )
        decoded.append(img)

    results = await asyncio.gather(*[face.detect_and_embed(img) for img in decoded])

    embeddings: List[List[float]] = []
    for idx, (img, (det, emb)) in enumerate(zip(decoded, results), start=1):
        if det is None or emb is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"No face found in image {idx}. Use better lighting and face the camera.",
            )
        if det.n_faces > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Image {idx} contains more than one face. Make sure you are alone in frame.",
            )
        frame_width = img.shape[1]
        if det.width / frame_width < settings.MIN_FACE_WIDTH_FRAC:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"You are too far from the camera in image {idx}. Move closer and retake it.",
            )
        sharp = face.sharpness(img)
        if sharp < settings.REGISTRATION_MIN_SHARPNESS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Image {idx} is too blurry (sharpness {sharp:.0f}). Hold still and retake it.",
            )
        embeddings.append(emb)

    # Every image must be the same person. This is the anti-poisoning guard:
    # if one capture caught a bystander, that vector would otherwise be stored
    # and verification could match against *it* instead of the account owner.
    agreement = face.self_consistency(embeddings)
    if agreement < settings.self_similarity_threshold:
        logger.warning("Enrolment rejected: self-consistency %.3f below threshold", agreement)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The captures do not all look like the same person. Make sure nobody else is "
                   "in the frame, then retake all three.",
        )

    # ...but they must not be the *same frame* three times, or the template
    # will not generalise beyond that one instant.
    pair_sims = [
        face.cosine_similarity(embeddings[i], embeddings[j])
        for i in range(len(embeddings))
        for j in range(i + 1, len(embeddings))
    ]
    if pair_sims and min(pair_sims) > settings.REGISTRATION_MAX_PAIR_SIMILARITY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="All three captures look identical. Follow the on-screen pose prompts so your "
                   "face is recorded from slightly different angles.",
        )

    template = face.centroid(embeddings)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not build a face template from these captures. Please retake them.",
        )

    logger.info(
        "Enrolment accepted: %d embeddings, self-consistency=%.3f, pairwise min=%.3f max=%.3f",
        len(embeddings), agreement,
        min(pair_sims) if pair_sims else 1.0,
        max(pair_sims) if pair_sims else 1.0,
    )
    return embeddings, template


def _resolve_template(user: dict) -> Tuple[Optional[List[float]], int]:
    """
    Get the centroid template for an account, as (template, n_discarded).

    Accounts enrolled by this version carry a stored `template`. Older ones only
    have a list of `embeddings` — possibly including mirrored copies from the
    old flip augmentation, and possibly a bystander's face, since nothing
    checked for that at the time. For those we rebuild the centroid and drop any
    vector that disagrees with the majority, which disarms a poisoned template
    without locking the rightful owner out of the account they need in order to
    re-enrol.
    """
    template = user.get("template")
    if template:
        return template, 0
    stored = user.get("embeddings") or []
    if not stored:
        return None, 0
    return face.robust_centroid(stored, settings.self_similarity_threshold)


# ---------------------------------------------------------------------------
# Account lockout
# ---------------------------------------------------------------------------
def _lock_state(user: dict) -> Optional[int]:
    """Seconds remaining on an active lockout, or None when not locked."""
    # Disabled for development. Any lockout already written to a user document
    # is ignored too, so flipping the flag unblocks existing accounts without
    # anyone having to clear the field by hand.
    if not settings.LOCKOUT_ENABLED:
        return None
    locked_until = user.get("locked_until")
    if not locked_until:
        return None
    if locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=timezone.utc)
    remaining = (locked_until - _now()).total_seconds()
    return int(remaining) if remaining > 0 else None


async def _record_failure(user: dict) -> Optional[int]:
    """
    Count a failed verification. Returns the lockout duration in seconds when
    this failure tripped the limit, otherwise None.

    The counter resets once the window lapses, so occasional misses by a genuine
    user (bad light, a missed blink) never accumulate into a lockout.
    """
    if not settings.LOCKOUT_ENABLED:
        return None

    phone = user["phone"]
    first_failed = user.get("first_failed_at")
    if first_failed is not None and first_failed.tzinfo is None:
        first_failed = first_failed.replace(tzinfo=timezone.utc)

    window = timedelta(minutes=settings.FAILED_ATTEMPT_WINDOW_MINUTES)
    within_window = first_failed is not None and (_now() - first_failed) < window
    attempts = (user.get("failed_attempts", 0) + 1) if within_window else 1

    update: Dict[str, Any] = {
        "failed_attempts": attempts,
        "first_failed_at": first_failed if within_window else _now(),
        "last_failed_at": _now(),
    }
    locked_for = None
    if attempts >= settings.MAX_FAILED_ATTEMPTS:
        update["locked_until"] = _now() + timedelta(minutes=settings.LOCKOUT_MINUTES)
        update["failed_attempts"] = 0
        update["first_failed_at"] = None
        locked_for = settings.LOCKOUT_MINUTES * 60
        logger.warning("Account locked for %s after %d failed attempts", phone, attempts)

    await _update_one({"phone": phone}, {"$set": update})
    return locked_for


async def _clear_failures(phone: str) -> None:
    await _update_one(
        {"phone": phone},
        {"$set": {"failed_attempts": 0, "first_failed_at": None, "locked_until": None}},
    )


# ---------------------------------------------------------------------------
# Routes — Public
# ---------------------------------------------------------------------------
@router.post("/register", status_code=status.HTTP_201_CREATED)
@limiter.limit(settings.RATE_LIMIT_REGISTER)
async def register(request: Request, user: UserRegister):
    """
    Register a new user from three guided face captures.

    The first user registered (when the collection is empty) is granted the
    'admin' role; everyone after that is a plain user.
    """
    col = _collection()

    if await _find_one({"phone": user.phone}, {"_id": 1}):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this phone number is already registered.",
        )

    is_first_user = await run_in_threadpool(col.count_documents, {}) == 0
    role = "admin" if is_first_user else "user"

    embeddings, template = await _embed_enrollment_images(user.images)

    now = _now()
    user_data = {
        "name": user.name.strip(),
        "phone": user.phone.strip(),
        "masked_id": user.masked_id.strip(),
        "role": role,
        "embeddings": embeddings,
        "template": template,
        # Which network produced these vectors. Templates are not comparable
        # across engines, so this decides whether they can be scored at all.
        "engine": face.ENGINE,
        "failed_attempts": 0,
        "first_failed_at": None,
        "locked_until": None,
        "created_at": now,
        "updated_at": now,
    }
    await run_in_threadpool(col.insert_one, user_data)
    logger.info("New user registered: phone=%s role=%s", user.phone, role)
    return {
        "status": "registered",
        "role": role,
        "message": f"Welcome, {user.name.strip()}! Registration successful."
        + (" You are the first user and have been granted admin access." if is_first_user else ""),
    }


@router.post("/check-user")
@limiter.limit(settings.RATE_LIMIT_CHECK_USER)
async def check_user(request: Request, payload: CheckUserPayload):
    """Check whether an account exists for a phone number."""
    user = await _find_one({"phone": payload.phone.strip()}, {"name": 1, "role": 1, "locked_until": 1})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No account found for this phone number.",
        )
    locked_for = _lock_state(user)
    if locked_for:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {max(1, locked_for // 60)} minute(s).",
        )
    return {"exists": True, "name": user["name"], "role": user.get("role", "user")}


@router.post("/challenge")
@limiter.limit(settings.RATE_LIMIT_CHALLENGE)
async def create_challenge(request: Request, payload: ChallengePayload):
    """
    Issue a single-use liveness challenge. The client must quote the returned
    `challenge_id` when it submits the captured blink bundle, which is what
    makes a bundle fresh and non-replayable.
    """
    phone = payload.phone.strip()
    user = await _find_one({"phone": phone}, {"locked_until": 1})
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    locked_for = _lock_state(user)
    if locked_for:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {max(1, locked_for // 60)} minute(s).",
        )

    challenge = await run_in_threadpool(challenges.issue, phone)
    logger.info("Challenge issued for phone=%s id=%s", phone, challenge["challenge_id"])
    return challenge


async def _verify_bundle(phone: str, data: UserVerify) -> tuple[List[List[float]], dict]:
    """
    Validate a blink bundle and return (embeddings of the two open frames,
    liveness metrics). Raises HTTPException with a user-facing reason on failure.
    """
    frames = data.frames or []
    phases = {f.phase for f in frames}
    if not set(liveness.REQUIRED_PHASES).issubset(phases):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Incomplete capture. Please look at the camera and blink once.",
        )

    # The challenge is consumed before any expensive work, so a flood of bogus
    # bundles costs an attacker a database round trip rather than several
    # model inferences each.
    claimed = await run_in_threadpool(challenges.consume, data.challenge_id or "", phone)
    if claimed is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This verification attempt has expired. Please try again.",
        )

    # The sequence comes from the stored challenge, never from the request — the
    # client must not get to choose which colours it is graded against.
    sequence = claimed.get("illumination") or []
    if sequence:
        missing = [p for p in pad.illumination_phases(len(sequence)) if p not in phases]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The screen-lighting check did not complete. Please try again.",
            )

    fingerprints = [face.image_fingerprint(f.image) for f in frames]
    if len(set(fingerprints)) != len(fingerprints):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The captured frames are identical. Please blink again in front of the camera.",
        )
    fresh = await run_in_threadpool(challenges.remember_frames, phone, fingerprints)
    if not fresh:
        logger.warning("Replay attempt rejected for phone=%s", phone)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="These frames were already submitted. Please capture a new blink.",
        )

    by_phase = {f.phase: f for f in frames}
    images = {}
    for phase, frame in by_phase.items():
        try:
            img = face.decode_image(frame.image)
        except face.ImageTooLarge as e:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e))
        if img is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or corrupt image data."
            )
        images[phase] = img

    # Two detectors, each doing what it is actually good at:
    #   * the 478-point mesh, on all three frames, to measure eye closure
    #     geometrically (core/mesh.py explains why not pixels);
    #   * MTCNN + the embedding network, on the two open frames only, for identity.
    # The open frames are detected and embedded in a single pass, so a login
    # costs three mesh passes and two MTCNN passes rather than re-running either.
    open_phases = (liveness.PHASE_OPEN_BEFORE, liveness.PHASE_OPEN_AFTER)
    illum_phases = pad.illumination_phases(len(sequence)) if sequence else []
    ordered = list(liveness.REQUIRED_PHASES) + illum_phases

    mesh_list, open_results = await asyncio.gather(
        asyncio.gather(*[mesh_detect(images[p]) for p in ordered]),
        asyncio.gather(*[face.detect_and_embed(images[p]) for p in open_phases]),
    )

    all_meshes = dict(zip(ordered, mesh_list))
    meshes = {p: all_meshes[p] for p in liveness.REQUIRED_PHASES}
    if any(m is None for m in meshes.values()):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No face detected in the captured frames. Make sure your face is fully visible.",
        )

    embeddings_by_phase = {phase: emb for phase, (_, emb) in zip(open_phases, open_results)}

    timings = {f.phase: f.t_ms for f in frames}
    result = liveness.analyse_blink(meshes, timings)
    logger.info(
        "liveness phone=%s passed=%s %s client_ear=%s",
        phone,
        result.passed,
        " ".join(f"{k}={v}" for k, v in result.metrics.items()),
        {f.phase: f.ear for f in frames},
    )
    if not result.passed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.reason,
            headers={"X-Liveness-Failed": "1"},
        )

    metrics = dict(result.metrics)

    # ── Presentation attack detection ─────────────────────────────────────
    # Blink says the eyes closed. This says a real face was physically in front
    # of the camera, which is what a replayed video fails.
    if sequence:
        if any(all_meshes.get(p) is None for p in illum_phases):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Your face was not visible during the screen-lighting check. "
                       "Keep looking at the screen and try again.",
                headers={"X-Liveness-Failed": "1"},
            )
        if any(all_meshes[p].n_faces > 1 for p in illum_phases):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="More than one face is visible. Make sure you are alone in the frame.",
                headers={"X-Liveness-Failed": "1"},
            )

        skin = {
            p: mesh.skin_color(images[p], all_meshes[p]) for p in illum_phases
        }
        baseline_skin = skin.get(pad.BASELINE_PHASE)
        if baseline_skin is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Could not read your skin tone during the lighting check. Try again.",
                headers={"X-Liveness-Failed": "1"},
            )
        pad_result = pad.analyse_illumination(skin, baseline_skin, sequence)
        metrics.update(pad_result.metrics)
        logger.info(
            "pad phone=%s passed=%s sequence=%s %s",
            phone, pad_result.passed, ",".join(sequence),
            " ".join(f"{k}={v}" for k, v in pad_result.metrics.items()),
        )
        if not pad_result.passed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=pad_result.reason,
                headers={"X-Liveness-Failed": "1"},
            )

        # Corroborating passive signal. Logged, not gated — it needs calibrating
        # against real capture hardware before anything depends on it.
        try:
            m = all_meshes[liveness.PHASE_OPEN_BEFORE]
            box = (int(m.center[0] - m.width / 2), int(m.center[1] - m.height / 2),
                   int(m.center[0] + m.width / 2), int(m.center[1] + m.height / 2))
            metrics["screen_artifact"] = round(
                pad.screen_artifact_score(images[liveness.PHASE_OPEN_BEFORE], box), 4
            )
        except Exception as exc:  # noqa: BLE001 — a diagnostic must never fail a login
            logger.debug("screen artifact score failed: %s", exc)

    # Identity is measured on the two open-eye frames only — a half-closed eye
    # shifts the embedding and would drag the score down for no good reason.
    usable = [e for e in embeddings_by_phase.values() if e is not None]
    if not usable:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not read your face clearly. Improve the lighting and try again.",
        )
    return usable, metrics


@router.post("/verify-face")
@limiter.limit(settings.RATE_LIMIT_FACE_VERIFY)
async def verify_face(request: Request, data: UserVerify):
    """
    Verify identity from a live blink bundle and issue tokens on success.

    Expects `challenge_id` plus three frames (open_before / closed /
    open_after). When REQUIRE_LIVENESS is False the endpoint also accepts a bare
    `image` — that path is for local debugging only and is not secure, since a
    photograph satisfies it.
    """
    phone = data.phone.strip()

    user = await _find_one({"phone": phone})
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    locked_for = _lock_state(user)
    if locked_for:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {max(1, locked_for // 60)} minute(s).",
        )

    metrics: dict = {}
    if settings.REQUIRE_LIVENESS or data.frames:
        try:
            live_embeddings, metrics = await _verify_bundle(phone, data)
        except HTTPException as exc:
            # A failed liveness check is still a failed attempt — otherwise the
            # lockout could be sidestepped by always failing at this stage.
            if exc.status_code == status.HTTP_400_BAD_REQUEST:
                await _record_failure(user)
            raise
    else:
        logger.warning("REQUIRE_LIVENESS is disabled — accepting a single frame for phone=%s", phone)
        if not data.image:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No image supplied.")
        try:
            img = face.decode_image(data.image)
        except face.ImageTooLarge as e:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e))
        if img is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or corrupt image data."
            )
        emb = await face.embed(img)
        if emb is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No face detected in the captured frame.",
            )
        live_embeddings = [emb]

    if not face.template_engine_matches(user.get("engine")):
        logger.warning(
            "phone=%s has a template from the '%s' engine while '%s' is running; refusing to "
            "score across engines.", phone, user.get("engine") or "facenet", face.ENGINE,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Your Face ID was created with an older recognition model and needs to be "
                   "set up again. Please re-register your face.",
        )

    template, discarded = _resolve_template(user)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No face template is enrolled for this account. Please re-register your face.",
        )
    if discarded:
        logger.warning(
            "phone=%s has a legacy template with %d disagreeing embedding(s); they were excluded. "
            "This account should re-enrol its face.",
            phone, discarded,
        )

    # Each live frame is compared against the enrolled centroid, never against
    # whichever single stored vector happens to match best. Taking the maximum
    # over stored vectors is the most permissive aggregator available: measured
    # on LFW, one wrong vector in a three-image template takes the false accept
    # rate from 0.1% to 3.0%, and lets a stranger score as high as 0.86.
    per_frame = [face.template_similarity(e, template) for e in live_embeddings]
    mean_similarity = float(np.mean(per_frame))
    min_similarity = float(np.min(per_frame))

    threshold = settings.match_threshold
    # Both open frames must match, not just their average — one fluke frame
    # should never be enough to carry a login on its own.
    passed = (
        mean_similarity >= threshold
        and min_similarity >= threshold - settings.FACENET_FRAME_MARGIN
    )

    confidence = round(max(0.0, min(1.0, mean_similarity)), 4)
    role = user.get("role", "user")
    logger.info(
        "verify phone=%s frames=%s mean=%.4f min=%.4f threshold=%.2f discarded=%d result=%s role=%s",
        phone,
        [round(p, 4) for p in per_frame],
        mean_similarity,
        min_similarity,
        threshold,
        discarded,
        "PASS" if passed else "FAIL",
        role,
    )

    if not passed:
        locked_for = await _record_failure(user)
        body = {
            "verified": False,
            "confidence_score": confidence,
            "message": (
                f"Too many failed attempts. Try again in {settings.LOCKOUT_MINUTES} minute(s)."
                if locked_for
                else "Face does not match. Please try again in better lighting."
            ),
            "locked_for_seconds": locked_for,
        }
        if settings.LIVENESS_DEBUG:
            body["debug"] = {"per_frame": per_frame, "liveness": metrics}
        return body

    await _clear_failures(phone)
    body = {
        "verified": True,
        "confidence_score": confidence,
        "access_token": create_access_token(subject=phone),
        "refresh_token": create_refresh_token(subject=phone),
        "token_type": "bearer",
        "role": role,
        "user": {"name": user["name"], "masked_id": user["masked_id"], "role": role},
    }
    if settings.LIVENESS_DEBUG:
        body["debug"] = {"per_frame": per_frame, "liveness": metrics}
    return body


@router.post("/refresh")
async def refresh_access_token(payload: RefreshPayload):
    """Issue a new access token from a valid refresh token."""
    phone = decode_refresh_token(payload.refresh_token)
    user = await _find_one({"phone": phone}, {"name": 1})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User no longer exists."
        )
    logger.info("Access token refreshed for phone=%s", phone)
    return {"access_token": create_access_token(subject=phone), "token_type": "bearer"}


# ---------------------------------------------------------------------------
# Routes — Authenticated user
# ---------------------------------------------------------------------------
@router.get("/profile")
async def get_profile(current_user: dict = Depends(get_current_user)):
    """Get the authenticated user's profile."""
    return {
        "name": current_user.get("name"),
        "phone": current_user.get("phone"),
        "masked_id": current_user.get("masked_id"),
        "role": current_user.get("role", "user"),
        "created_at": current_user.get("created_at"),
        "updated_at": current_user.get("updated_at"),
    }


@router.put("/profile")
async def update_profile(data: UserUpdate, current_user: dict = Depends(get_current_user)):
    """Update the authenticated user's name or masked ID."""
    update_data = {k: v.strip() for k, v in data.model_dump().items() if v is not None and v.strip()}
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No valid fields provided to update."
        )
    update_data["updated_at"] = _now()
    await _update_one({"phone": current_user["phone"]}, {"$set": update_data})
    logger.info("Profile updated for phone=%s", current_user["phone"])
    return {"status": "success", "message": "Profile updated successfully."}


@router.put("/profile/face")
async def update_face(data: UserFaceUpdate, current_user: dict = Depends(get_current_user)):
    """Re-enrol the authenticated user's face from three new captures."""
    embeddings, template = await _embed_enrollment_images(data.images)
    await _update_one(
        {"phone": current_user["phone"]},
        {"$set": {"embeddings": embeddings, "template": template,
                  "engine": face.ENGINE, "updated_at": _now()}},
    )
    logger.info("Face ID updated for phone=%s", current_user["phone"])
    return {"status": "success", "message": "Face ID updated successfully."}


@router.delete("/profile")
async def delete_profile(current_user: dict = Depends(get_current_user)):
    """Delete the authenticated user's own account."""
    col = _collection()
    if current_user.get("role") == "admin":
        admin_count = await run_in_threadpool(col.count_documents, {"role": "admin"})
        if admin_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete account — you are the only admin. "
                       "Promote another user to admin first.",
            )
    result = await run_in_threadpool(col.delete_one, {"phone": current_user["phone"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Account deleted for phone=%s", current_user["phone"])
    return {"status": "success", "message": "Account deleted successfully."}


# ---------------------------------------------------------------------------
# Routes — Admin
# ---------------------------------------------------------------------------
def _list_users_sync(col) -> List[dict]:
    users = []
    for user in col.find({}, {"embeddings": 0, "_id": 0}).sort("created_at", -1):
        users.append({
            "name": user.get("name", "Unknown"),
            "phone": user.get("phone", "N/A"),
            "masked_id": user.get("masked_id", "N/A"),
            "role": user.get("role", "user"),
            "created_at": user.get("created_at"),
            "updated_at": user.get("updated_at"),
            # Surfaced so an admin can see who is locked out and clear it,
            # rather than the user's only option being to wait it out.
            "locked": _lock_state(user) is not None,
            # Templates from a previous engine cannot be scored; these users
            # must re-enrol before they can sign in again.
            "engine": user.get("engine") or "facenet",
            "needs_reenrollment": not face.template_engine_matches(user.get("engine")),
        })
    return users


@router.get("/admin/users", tags=["Admin"])
async def admin_get_all_users(admin: dict = Depends(require_admin)):
    """List all registered users. Requires admin role."""
    users = await run_in_threadpool(_list_users_sync, _collection())
    logger.info("Admin [%s] listed %d users", admin["phone"], len(users))
    return users


@router.put("/admin/promote/{phone}", tags=["Admin"])
async def admin_promote_user(phone: str, admin: dict = Depends(require_admin)):
    """Promote a user to admin role."""
    result = await _update_one({"phone": phone}, {"$set": {"role": "admin", "updated_at": _now()}})
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] promoted user %s to admin", admin["phone"], phone)
    return {"status": "success", "message": f"{phone} has been promoted to admin."}


@router.put("/admin/demote/{phone}", tags=["Admin"])
async def admin_demote_user(phone: str, admin: dict = Depends(require_admin)):
    """Demote an admin back to user role."""
    if phone == admin["phone"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot demote yourself."
        )
    result = await _update_one({"phone": phone}, {"$set": {"role": "user", "updated_at": _now()}})
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] demoted user %s to user", admin["phone"], phone)
    return {"status": "success", "message": f"{phone} has been demoted to user."}


@router.put("/admin/unlock/{phone}", tags=["Admin"])
async def admin_unlock_user(phone: str, admin: dict = Depends(require_admin)):
    """Clear a lockout so the user can attempt face verification again."""
    result = await _update_one(
        {"phone": phone},
        {"$set": {"locked_until": None, "failed_attempts": 0, "first_failed_at": None,
                  "updated_at": _now()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] unlocked account %s", admin["phone"], phone)
    return {"status": "success", "message": f"{phone} has been unlocked."}


@router.put("/admin/users/{phone}", tags=["Admin"])
async def admin_update_user(phone: str, data: UserUpdate, admin: dict = Depends(require_admin)):
    """Admin: update a user's name or masked ID."""
    update_data = {k: v.strip() for k, v in data.model_dump().items() if v is not None and v.strip()}
    if not update_data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid fields provided.")
    update_data["updated_at"] = _now()
    result = await _update_one({"phone": phone}, {"$set": update_data})
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] updated user phone=%s", admin["phone"], phone)
    return {"status": "success", "message": "User updated successfully."}


@router.delete("/admin/users/{phone}", tags=["Admin"])
async def admin_delete_user(phone: str, admin: dict = Depends(require_admin)):
    """Admin: delete a user by phone."""
    if phone == admin["phone"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account from the admin panel.",
        )
    col = _collection()
    target_user = await _find_one({"phone": phone}, {"role": 1})
    if target_user and target_user.get("role") == "admin":
        admin_count = await run_in_threadpool(col.count_documents, {"role": "admin"})
        if admin_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete the only admin. Promote another user to admin first.",
            )
    result = await run_in_threadpool(col.delete_many, {"phone": phone})
    if result.deleted_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] deleted %d record(s) for phone=%s",
                admin["phone"], result.deleted_count, phone)
    return {"status": "success", "message": f"Deleted {result.deleted_count} record(s) for {phone}."}
