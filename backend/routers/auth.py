"""
auth.py — Authentication & admin router.

Improvements applied in this version:
  #2  Async face processing — DeepFace runs in a thread-pool executor so the event
      loop is never blocked during heavy CPU work.
  #3  Image size guard — base64 strings are rejected before decoding if they exceed
      MAX_IMAGE_SIZE_MB (configured in config.py).
  #4  slowapi rate limiting on /auth/verify-face (5 / minute per IP, persisted in Redis).
      Fallback: in-memory limiter is used if Redis is unavailable.
  #5  Refresh token system — /auth/refresh returns a new access token from a valid
      refresh token, so users stay logged in without re-scanning their face.
  #8  Structured logging throughout (no print() calls).
"""
import asyncio
import base64
import concurrent.futures
import logging
import math
import re
from datetime import datetime
from typing import List, Optional

import cv2
import numpy as np
from deepface import DeepFace
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, validator

from core.config import settings
from core.database import db
from core.security import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    get_current_user,
    verify_admin_secret,
)
from core.limiter import limiter  # shared limiter from core/limiter.py (avoids circular import)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])

# ---------------------------------------------------------------------------
# Dedicated thread pool — avoids contention with the default OS executor.
# 2 workers is enough: DeepFace is CPU-bound, more threads won't help on a
# single CPU and will just cause context-switching overhead.
# ---------------------------------------------------------------------------
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
# max_workers=1: TensorFlow's global graph is NOT thread-safe.
# Running two DeepFace calls simultaneously causes "Retval[0] already set".
# A single worker serialises all calls while still keeping the event loop free.


# ---------------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------------
class UserRegister(BaseModel):
    name: str
    phone: str
    masked_id: str
    images: List[str]  # base64 strings

    @validator("name")
    def name_must_be_valid(cls, v):
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @validator("phone")
    def phone_must_be_valid(cls, v):
        v = v.strip()
        if not re.match(r"^\+?\d{7,15}$", v):
            raise ValueError("Invalid phone number format (7–15 digits).")
        return v

    @validator("images")
    def images_must_have_three(cls, v):
        if len(v) < 3:
            raise ValueError("Exactly 3 face images are required for registration.")
        return v


class CheckUserPayload(BaseModel):
    phone: str


class UserVerify(BaseModel):
    phone: str
    image: str  # base64 string


class RefreshPayload(BaseModel):
    refresh_token: str


class UserUpdate(BaseModel):
    name: Optional[str] = None
    masked_id: Optional[str] = None


class UserFaceUpdate(BaseModel):
    images: List[str]

    @validator("images")
    def images_must_have_three(cls, v):
        if len(v) < 3:
            raise ValueError("Exactly 3 face images are required.")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _decode_image(img_b64: str, max_side: int = 640):
    """
    Decode a base64 image to an OpenCV Mat and resize to max_side px.
    Smaller images = much faster DeepFace processing.
    Includes image size guard.
    """
    raw = img_b64.split(",", 1)[1] if "," in img_b64 else img_b64
    if len(raw) > settings.max_b64_chars:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Image exceeds the {settings.MAX_IMAGE_SIZE_MB:.0f} MB size limit.",
        )
    try:
        img_bytes = base64.b64decode(raw)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        # ── Resize to speed up DeepFace (keep aspect ratio) ──────
        h, w = img.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / max(h, w)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        return img
    except Exception as e:
        logger.warning("Image decode failed: %s", e)
        return None


# ── #2 Async DeepFace helpers ────────────────────────────────────────────────

async def _async_represent(img) -> list:
    """
    Run DeepFace.represent() in a dedicated thread pool (single worker to keep
    TensorFlow's global graph safe). Uses opencv detector — ~3-5x faster than
    the default retinaface/mtcnn backends.
    """
    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(
        _executor,
        lambda: DeepFace.represent(
            img_path=img,
            model_name=settings.DEEPFACE_MODEL,
            detector_backend="opencv",
            enforce_detection=False,
        ),
    )
    return results


async def _get_embeddings(images_b64: List[str]) -> List[list]:
    """Convert a list of base64 images to face embeddings asynchronously."""
    tasks = []
    imgs = []
    for img_b64 in images_b64:
        img = _decode_image(img_b64)
        if img is not None:
            imgs.append(img)

    if not imgs:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid images could be decoded.",
        )

    results = await asyncio.gather(*[_async_represent(img) for img in imgs])
    embeddings = []
    for r in results:
        if r:
            embeddings.append(r[0]["embedding"])

    if not embeddings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No faces could be detected in the provided images. Use better lighting.",
        )
    logger.info("Extracted %d embedding(s) from %d image(s)", len(embeddings), len(imgs))
    return embeddings


def _cosine_distance(a: list, b: list) -> float:
    """1 - cosine_similarity. Returns 1.0 (worst) if vectors are zero or non-finite."""
    a_arr, b_arr = np.array(a, dtype=np.float64), np.array(b, dtype=np.float64)
    # Guard against NaN/Inf coming from DeepFace on bad frames
    if not np.all(np.isfinite(a_arr)) or not np.all(np.isfinite(b_arr)):
        return 1.0
    na, nb = np.linalg.norm(a_arr), np.linalg.norm(b_arr)
    if na == 0 or nb == 0:
        return 1.0
    dist = float(1.0 - np.dot(a_arr, b_arr) / (na * nb))
    return dist if math.isfinite(dist) else 1.0


def _get_collection():
    db_conn = db.get_db()
    if db_conn is None:
        raise HTTPException(status_code=503, detail="Database is unavailable.")
    return db_conn[settings.COLLECTION_NAME]


# ---------------------------------------------------------------------------
# Routes — Public
# ---------------------------------------------------------------------------

@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(user: UserRegister):
    """Register a new user with face embeddings from 3 blink-captured images."""
    col = _get_collection()

    if col.find_one({"phone": user.phone}):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this phone number is already registered.",
        )

    embeddings = await _get_embeddings(user.images)

    user_data = {
        "name": user.name.strip(),
        "phone": user.phone.strip(),
        "masked_id": user.masked_id.strip(),
        "embeddings": embeddings,
        "model": settings.DEEPFACE_MODEL,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }
    col.insert_one(user_data)
    logger.info("New user registered: phone=%s", user.phone)
    return {"status": "registered", "message": f"Welcome, {user.name.strip()}! Registration successful."}


@router.post("/check-user")
async def check_user(payload: CheckUserPayload):
    """Check if a user with the given phone number exists (no auth required)."""
    col = _get_collection()
    user = col.find_one({"phone": payload.phone.strip()}, {"name": 1})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No account found for this phone number.",
        )
    return {"exists": True, "name": user["name"]}


@router.post("/verify-face")
@limiter.limit(settings.RATE_LIMIT_FACE_VERIFY)  # #4 slowapi rate limit (5/min per IP)
async def verify_face(request: Request, data: UserVerify):
    """
    Verify a user's identity using a live blink-captured frame.
    Returns both an access token (short-lived) and a refresh token (long-lived).
    """
    phone = data.phone.strip()

    col = _get_collection()
    user = col.find_one({"phone": phone})
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    img = _decode_image(data.image)
    if img is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or corrupt image data."
        )

    # ── #2 Async DeepFace processing ────────────────────────────
    try:
        result = await _async_represent(img)
        if not result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No face detected in the captured frame. Ensure your face is visible.",
            )
        live_embedding = result[0]["embedding"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("DeepFace processing error for phone=%s: %s", phone, e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Face processing failed: {str(e)}",
        )

    # Compare against all stored embeddings
    min_distance = min(
        _cosine_distance(live_embedding, stored_emb)
        for stored_emb in user["embeddings"]
    )
    # Clamp to valid range — guards against any residual NaN/Inf before JSON serialisation
    if not math.isfinite(min_distance):
        min_distance = 1.0
    confidence = round(max(0.0, min(1.0, float(1.0 - min_distance))), 4)
    logger.info(
        "Verification [%s]: distance=%.4f threshold=%.2f result=%s",
        phone, min_distance, settings.FACE_DISTANCE_THRESHOLD,
        "PASS" if min_distance < settings.FACE_DISTANCE_THRESHOLD else "FAIL",
    )

    if min_distance < settings.FACE_DISTANCE_THRESHOLD:
        # ── #5 Issue both access + refresh tokens ────────────────
        access_token = create_access_token(subject=phone)
        refresh_token = create_refresh_token(subject=phone)
        return {
            "verified": True,
            "confidence_score": confidence,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
            "user": {
                "name": user["name"],
                "masked_id": user["masked_id"],
            },
        }
    else:
        return {
            "verified": False,
            "confidence_score": confidence,
            "message": "Face does not match. Please try again in better lighting.",
        }


@router.post("/refresh")
async def refresh_access_token(payload: RefreshPayload):
    """
    Issue a new access token using a valid refresh token.
    Allows users to stay logged in beyond the 15-minute access token window
    without needing to re-scan their face.
    """
    phone = decode_refresh_token(payload.refresh_token)

    # Verify the user still exists in the database
    col = _get_collection()
    user = col.find_one({"phone": phone}, {"name": 1})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists.",
        )

    new_access_token = create_access_token(subject=phone)
    logger.info("Access token refreshed for phone=%s", phone)
    return {
        "access_token": new_access_token,
        "token_type": "bearer",
    }


# ---------------------------------------------------------------------------
# Routes — Authenticated User (require JWT)
# ---------------------------------------------------------------------------

@router.get("/profile")
async def get_profile(current_user: dict = Depends(get_current_user)):
    """Get the authenticated user's profile."""
    return {
        "name": current_user.get("name"),
        "phone": current_user.get("phone"),
        "masked_id": current_user.get("masked_id"),
        "model": current_user.get("model"),
        "created_at": current_user.get("created_at"),
        "updated_at": current_user.get("updated_at"),
    }


@router.put("/profile")
async def update_profile(data: UserUpdate, current_user: dict = Depends(get_current_user)):
    """Update the authenticated user's name or masked ID."""
    update_data = {k: v.strip() for k, v in data.dict().items() if v is not None and v.strip()}
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid fields provided to update.",
        )
    update_data["updated_at"] = datetime.utcnow()
    col = _get_collection()
    col.update_one({"phone": current_user["phone"]}, {"$set": update_data})
    logger.info("Profile updated for phone=%s, fields=%s", current_user["phone"], list(update_data.keys()))
    return {"status": "success", "message": "Profile updated successfully."}


@router.put("/profile/face")
async def update_face(data: UserFaceUpdate, current_user: dict = Depends(get_current_user)):
    """Re-enroll the authenticated user's face with 3 new images."""
    embeddings = await _get_embeddings(data.images)
    col = _get_collection()
    col.update_one(
        {"phone": current_user["phone"]},
        {
            "$set": {
                "embeddings": embeddings,
                "model": settings.DEEPFACE_MODEL,
                "updated_at": datetime.utcnow(),
            }
        },
    )
    logger.info("Face ID updated for phone=%s", current_user["phone"])
    return {"status": "success", "message": "Face ID updated successfully."}


@router.delete("/profile")
async def delete_profile(current_user: dict = Depends(get_current_user)):
    """Delete the authenticated user's own account."""
    col = _get_collection()
    result = col.delete_one({"phone": current_user["phone"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Account deleted for phone=%s", current_user["phone"])
    return {"status": "success", "message": "Account deleted successfully."}


# ---------------------------------------------------------------------------
# Routes — Admin (require X-Admin-Secret header)
# ---------------------------------------------------------------------------

@router.get("/admin/users", tags=["Admin"], dependencies=[Depends(verify_admin_secret)])
async def admin_get_all_users():
    """List all registered users. Requires X-Admin-Secret header."""
    col = _get_collection()
    users = []
    for user in col.find({}, {"embeddings": 0, "_id": 0}).sort("created_at", -1):
        users.append({
            "name": user.get("name", "Unknown"),
            "phone": user.get("phone", "N/A"),
            "masked_id": user.get("masked_id", "N/A"),
            "model": user.get("model", "N/A"),
            "created_at": user.get("created_at"),
            "updated_at": user.get("updated_at"),
        })
    logger.info("Admin listed %d users", len(users))
    return users


@router.put("/admin/users/{phone}", tags=["Admin"], dependencies=[Depends(verify_admin_secret)])
async def admin_update_user(phone: str, data: UserUpdate):
    """Admin: Update a user by phone. Requires X-Admin-Secret header."""
    update_data = {k: v.strip() for k, v in data.dict().items() if v is not None and v.strip()}
    if not update_data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid fields provided.")
    update_data["updated_at"] = datetime.utcnow()
    col = _get_collection()
    result = col.update_one({"phone": phone}, {"$set": update_data})
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin updated user phone=%s fields=%s", phone, list(update_data.keys()))
    return {"status": "success", "message": "User updated successfully."}


@router.delete("/admin/users/{phone}", tags=["Admin"], dependencies=[Depends(verify_admin_secret)])
async def admin_delete_user(phone: str):
    """Admin: Delete a user by phone. Requires X-Admin-Secret header."""
    col = _get_collection()
    result = col.delete_many({"phone": phone})
    if result.deleted_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin deleted %d record(s) for phone=%s", result.deleted_count, phone)
    return {"status": "success", "message": f"Deleted {result.deleted_count} record(s) for {phone}."}
