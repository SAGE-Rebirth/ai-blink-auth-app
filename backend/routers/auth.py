"""
auth.py — Authentication & admin router (PyTorch / facenet-pytorch edition).

Key design decisions:
  - Face recognition: facenet-pytorch (MTCNN detection + InceptionResnetV1 embeddings)
    - Pure PyTorch, no TensorFlow dependency, ~3× faster on CPU
  - Role system: first registered user → admin, all subsequent → user
    - Admins can promote any user to admin via PUT /auth/admin/promote/{phone}
  - Admin endpoints protected by JWT role check (require_admin dependency)
  - Horizontal-flip augmentation: each registration image is also stored mirrored
    → stores up to 6 embeddings from 3 images — improves side-face match rate
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
import torch
from facenet_pytorch import MTCNN, InceptionResnetV1
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, validator

from core.config import settings
from core.database import db
from core.security import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    get_current_user,
    require_admin,
    verify_admin_secret,
)
from core.limiter import limiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])

# ---------------------------------------------------------------------------
# facenet-pytorch model initialisation (done once at import time)
# CPU mode — works on any machine without a GPU.
# ---------------------------------------------------------------------------
_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
logger.info("Face recognition running on device: %s", _device)

_mtcnn = MTCNN(
    image_size=160,
    margin=20,
    min_face_size=40,
    thresholds=[0.6, 0.7, 0.7],
    factor=0.709,
    post_process=True,
    device=_device,
    keep_all=False,
)

_resnet = InceptionResnetV1(pretrained="vggface2").eval().to(_device)

# Single-worker executor — PyTorch models are not thread-safe under concurrent calls.
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)


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
    """Decode a base64 image to an OpenCV Mat and resize to max_side px."""
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
        h, w = img.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / max(h, w)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        return img
    except Exception as e:
        logger.warning("Image decode failed: %s", e)
        return None


def _cv2_to_pil(img_bgr) -> Image.Image:
    """Convert OpenCV BGR image to PIL RGB image."""
    return Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))


def _get_embedding_sync(img_bgr) -> Optional[list]:
    """
    Run MTCNN face detection + InceptionResnetV1 embedding synchronously.
    Called inside thread pool executor — must be thread-safe (single worker).
    Returns embedding list or None if no face detected.
    """
    pil_img = _cv2_to_pil(img_bgr)
    face_tensor = _mtcnn(pil_img)   # returns (3,160,160) tensor or None
    if face_tensor is None:
        return None
    with torch.no_grad():
        embedding = _resnet(face_tensor.unsqueeze(0).to(_device))
    return embedding.cpu().numpy().flatten().tolist()


async def _async_embed(img_bgr) -> Optional[list]:
    """Run face embedding in the dedicated thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, _get_embedding_sync, img_bgr)


async def _get_embeddings(images_b64: List[str]) -> List[list]:
    """
    Convert a list of base64 images to face embeddings.
    Each image is also processed horizontally mirrored (flip augmentation)
    so that side-face angles are robustly covered from both directions.
    """
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

    # Original + horizontally mirrored versions
    all_imgs = []
    for img in imgs:
        all_imgs.append(img)
        all_imgs.append(cv2.flip(img, 1))

    results = await asyncio.gather(*[_async_embed(img) for img in all_imgs])
    embeddings = [r for r in results if r is not None]

    if not embeddings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No faces could be detected in the provided images. Use better lighting.",
        )
    logger.info(
        "Extracted %d embedding(s) from %d image(s) (incl. flip augmentation)",
        len(embeddings), len(imgs),
    )
    return embeddings


def _cosine_similarity(a: list, b: list) -> float:
    """Cosine similarity in [0,1]. Returns 0.0 (worst) on bad vectors."""
    a_arr, b_arr = np.array(a, dtype=np.float64), np.array(b, dtype=np.float64)
    if not np.all(np.isfinite(a_arr)) or not np.all(np.isfinite(b_arr)):
        return 0.0
    na, nb = np.linalg.norm(a_arr), np.linalg.norm(b_arr)
    if na == 0 or nb == 0:
        return 0.0
    sim = float(np.dot(a_arr, b_arr) / (na * nb))
    return sim if math.isfinite(sim) else 0.0


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
    """
    Register a new user with face embeddings from 3 blink-captured images.
    The very first user registered (when the collection is empty) is granted
    the 'admin' role; all subsequent registrations receive 'user' role.
    """
    col = _get_collection()

    if col.find_one({"phone": user.phone}):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this phone number is already registered.",
        )

    # ── First-user-is-admin logic ─────────────────────────────────
    is_first_user = col.count_documents({}) == 0
    role = "admin" if is_first_user else "user"

    embeddings = await _get_embeddings(user.images)

    user_data = {
        "name": user.name.strip(),
        "phone": user.phone.strip(),
        "masked_id": user.masked_id.strip(),
        "role": role,
        "embeddings": embeddings,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }
    col.insert_one(user_data)
    logger.info("New user registered: phone=%s role=%s", user.phone, role)
    return {
        "status": "registered",
        "role": role,
        "message": f"Welcome, {user.name.strip()}! Registration successful."
        + (" You are the first user and have been granted admin access." if is_first_user else ""),
    }


@router.post("/check-user")
async def check_user(payload: CheckUserPayload):
    """Check if a user with the given phone number exists (no auth required)."""
    col = _get_collection()
    user = col.find_one({"phone": payload.phone.strip()}, {"name": 1, "role": 1})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No account found for this phone number.",
        )
    return {"exists": True, "name": user["name"], "role": user.get("role", "user")}


@router.post("/verify-face")
@limiter.limit(settings.RATE_LIMIT_FACE_VERIFY)
async def verify_face(request: Request, data: UserVerify):
    """
    Verify a user's identity using a live blink-captured frame.
    Returns access token, refresh token, and user role on success.
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

    try:
        live_embedding = await _async_embed(img)
        if live_embedding is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No face detected in the captured frame. Ensure your face is visible.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Face embedding error for phone=%s: %s", phone, e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Face processing failed: {str(e)}",
        )

    # Compare against all stored embeddings — take the best match
    max_similarity = max(
        _cosine_similarity(live_embedding, stored_emb)
        for stored_emb in user["embeddings"]
    )
    if not math.isfinite(max_similarity):
        max_similarity = 0.0

    confidence = round(max(0.0, min(1.0, float(max_similarity))), 4)
    role = user.get("role", "user")
    logger.info(
        "Verification [%s]: similarity=%.4f threshold=%.2f result=%s role=%s",
        phone, max_similarity, settings.FACENET_THRESHOLD,
        "PASS" if max_similarity >= settings.FACENET_THRESHOLD else "FAIL",
        role,
    )

    if max_similarity >= settings.FACENET_THRESHOLD:
        access_token = create_access_token(subject=phone)
        refresh_token = create_refresh_token(subject=phone)
        return {
            "verified": True,
            "confidence_score": confidence,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
            "role": role,
            "user": {
                "name": user["name"],
                "masked_id": user["masked_id"],
                "role": role,
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
    """Issue a new access token using a valid refresh token."""
    phone = decode_refresh_token(payload.refresh_token)
    col = _get_collection()
    user = col.find_one({"phone": phone}, {"name": 1})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists.",
        )
    new_access_token = create_access_token(subject=phone)
    logger.info("Access token refreshed for phone=%s", phone)
    return {"access_token": new_access_token, "token_type": "bearer"}


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
        "role": current_user.get("role", "user"),
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
    logger.info("Profile updated for phone=%s", current_user["phone"])
    return {"status": "success", "message": "Profile updated successfully."}


@router.put("/profile/face")
async def update_face(data: UserFaceUpdate, current_user: dict = Depends(get_current_user)):
    """Re-enroll the authenticated user's face with 3 new images."""
    embeddings = await _get_embeddings(data.images)
    col = _get_collection()
    col.update_one(
        {"phone": current_user["phone"]},
        {"$set": {"embeddings": embeddings, "updated_at": datetime.utcnow()}},
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
# Routes — Admin (require JWT role=admin)
# ---------------------------------------------------------------------------

@router.get("/admin/users", tags=["Admin"])
async def admin_get_all_users(admin: dict = Depends(require_admin)):
    """List all registered users. Requires admin role."""
    col = _get_collection()
    users = []
    for user in col.find({}, {"embeddings": 0, "_id": 0}).sort("created_at", -1):
        users.append({
            "name": user.get("name", "Unknown"),
            "phone": user.get("phone", "N/A"),
            "masked_id": user.get("masked_id", "N/A"),
            "role": user.get("role", "user"),
            "created_at": user.get("created_at"),
            "updated_at": user.get("updated_at"),
        })
    logger.info("Admin [%s] listed %d users", admin["phone"], len(users))
    return users


@router.put("/admin/promote/{phone}", tags=["Admin"])
async def admin_promote_user(phone: str, admin: dict = Depends(require_admin)):
    """Promote a user to admin role. Requires admin role."""
    col = _get_collection()
    result = col.update_one(
        {"phone": phone},
        {"$set": {"role": "admin", "updated_at": datetime.utcnow()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] promoted user %s to admin", admin["phone"], phone)
    return {"status": "success", "message": f"{phone} has been promoted to admin."}


@router.put("/admin/demote/{phone}", tags=["Admin"])
async def admin_demote_user(phone: str, admin: dict = Depends(require_admin)):
    """Demote an admin back to user role. Requires admin role."""
    if phone == admin["phone"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot demote yourself.",
        )
    col = _get_collection()
    result = col.update_one(
        {"phone": phone},
        {"$set": {"role": "user", "updated_at": datetime.utcnow()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] demoted user %s to user", admin["phone"], phone)
    return {"status": "success", "message": f"{phone} has been demoted to user."}


@router.put("/admin/users/{phone}", tags=["Admin"])
async def admin_update_user(phone: str, data: UserUpdate, admin: dict = Depends(require_admin)):
    """Admin: Update a user's name or masked ID."""
    update_data = {k: v.strip() for k, v in data.dict().items() if v is not None and v.strip()}
    if not update_data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid fields provided.")
    update_data["updated_at"] = datetime.utcnow()
    col = _get_collection()
    result = col.update_one({"phone": phone}, {"$set": update_data})
    if result.matched_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] updated user phone=%s", admin["phone"], phone)
    return {"status": "success", "message": "User updated successfully."}


@router.delete("/admin/users/{phone}", tags=["Admin"])
async def admin_delete_user(phone: str, admin: dict = Depends(require_admin)):
    """Admin: Delete a user by phone."""
    if phone == admin["phone"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account from the admin panel.",
        )
    col = _get_collection()
    result = col.delete_many({"phone": phone})
    if result.deleted_count == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    logger.info("Admin [%s] deleted %d record(s) for phone=%s", admin["phone"], result.deleted_count, phone)
    return {"status": "success", "message": f"Deleted {result.deleted_count} record(s) for {phone}."}
