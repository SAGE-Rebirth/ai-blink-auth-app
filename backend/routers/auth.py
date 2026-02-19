from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends
from pydantic import BaseModel
from typing import List
import numpy as np
import cv2
import base64
from deepface import DeepFace
from datetime import datetime, timedelta
from core.database import db
from core.config import settings
from core.security import create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["Authentication"])

class UserRegister(BaseModel):
    name: str
    phone: str
    masked_id: str
    images: List[str] # base64 strings

class UserVerify(BaseModel):
    phone: str
    image: str # base64 string

def decode_image(img_b64):
    if "," in img_b64:
        img_b64 = img_b64.split(",")[1]
    
    img_bytes = base64.b64decode(img_b64)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    return img

@router.post("/register")
async def register(user: UserRegister):
    try:
        embeddings = []
        
        # Ensure deepface model is downloaded/loaded (this might be slow on first run)
        # We process each image to get embeddings
        for img_b64 in user.images:
            # Decode base64 image
            img = decode_image(img_b64)
            
            if img is None:
                continue

            # Generate embedding
            try:
                result = DeepFace.represent(img_path=img, model_name=settings.DEEPFACE_MODEL, enforce_detection=False)
                if result:
                    embeddings.append(result[0]["embedding"])
            except Exception as e:
                print(f"DeepFace error for image: {e}")
                continue

        if not embeddings:
            raise HTTPException(status_code=400, detail="No faces detected in the provided images")

        user_data = {
            "name": user.name,
            "phone": user.phone,
            "masked_id": user.masked_id,
            "embeddings": embeddings,
            "model": settings.DEEPFACE_MODEL,
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow()
        }

        if db.client:
           # Check for existing user to avoid duplicates
           if db.get_db()[settings.COLLECTION_NAME].find_one({"phone": user.phone}):
               raise HTTPException(status_code=400, detail="User with this phone number already exists")
               
           db.get_db()[settings.COLLECTION_NAME].insert_one(user_data)
        else:
           raise HTTPException(status_code=500, detail="Database not connected")
        
        return {"status": "registered", "message": "User registered successfully"}

    except HTTPException:
        raise
    except Exception as e:
        print(f"Registration error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/verify-face")
async def verify_face(data: UserVerify):
    try:
        # 1. Fetch user by phone
        user = db.get_db()[settings.COLLECTION_NAME].find_one({"phone": data.phone})
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        # 2. Decode live image
        img = decode_image(data.image)
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image")

        # 3. Generate embedding for live image
        live_embedding = []
        try:
            result = DeepFace.represent(img_path=img, model_name=settings.DEEPFACE_MODEL, enforce_detection=False)
            if result:
                live_embedding = result[0]["embedding"]
        except Exception as e:
             raise HTTPException(status_code=400, detail=f"Face detection failed: {str(e)}")

        if not live_embedding:
            raise HTTPException(status_code=400, detail="No face detected in live image")

        # 4. Compare with stored embeddings (Cosine Similarity)
        # Cosine Distance = 1 - Cosine Similarity
        # We want Distance < Threshold (0.4)
        
        # Calculate minimum distance to any of the stored embeddings
        min_distance = 1.0
        
        for stored_emb in user["embeddings"]:
            # Manual Cosine Distance
            # dist = 1 - (A . B) / (||A|| * ||B||)
            # DeepFace embeddings are usually normalized, but let's be safe
            
            a = np.array(live_embedding)
            b = np.array(stored_emb)
            
            dot = np.dot(a, b)
            norm_a = np.linalg.norm(a)
            norm_b = np.linalg.norm(b)
            
            cosine = dot / (norm_a * norm_b)
            distance = 1 - cosine
            
            if distance < min_distance:
                min_distance = distance

        print(f"Verification Distance: {min_distance}")

        if min_distance < 0.4:
            # 5. Success -> Generate Token
            access_token = create_access_token(subject=user["phone"])
            return {
                "verified": True,
                "confidence_score": float(1 - min_distance), 
                "access_token": access_token,
                "user": {
                    "name": user["name"],
                    "masked_id": user["masked_id"]
                }
            }
        else:
            return {
                "verified": False,
                "confidence_score": float(1 - min_distance),
                "message": "Authentication Failed: User face does not match stored ID."
            }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Verification error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/check-user")
async def check_user(data: UserVerify):
    # Reusing UserVerify model since it has 'phone' field
    user = db.get_db()[settings.COLLECTION_NAME].find_one({"phone": data.phone})
    if user:
        return {"exists": True, "name": user["name"]}
    raise HTTPException(status_code=404, detail="User not found")

@router.get("/admin/users")
async def get_all_users(): 
    # In a real app, protect this with ADMIN role check
    users = []
    try:
        # Debug: Check exact collection count
        count = db.get_db()[settings.COLLECTION_NAME].count_documents({})
        print(f"Admin: count_documents({{}}) says {count}")
        
        cursor = db.get_db()[settings.COLLECTION_NAME].find({})
        user_list = list(cursor)
        print(f"Admin: Found {len(user_list)} users in cursor list.")
        
        if len(user_list) > 0:
            print(f"Sample user keys: {user_list[0].keys()}")

        for user in user_list:
            users.append({
                "name": user.get("name", "Unknown"),
                "phone": user.get("phone", "N/A"),
                "masked_id": user.get("masked_id", "N/A"),
                "created_at": user.get("created_at")
            })
        return users
    except Exception as e:
        print(f"Admin fetch error: {e}")
        return []

@router.get("/profile")
async def get_profile(current_user: dict = Depends(get_current_user)):
    print(f"Profile fetch for: {current_user.get('phone')}")
    print(f"User Data Keys: {current_user.keys()}")
    return {
        "name": current_user.get("name"),
        "phone": current_user.get("phone"),
        "masked_id": current_user.get("masked_id"),
        "created_at": current_user.get("created_at"),
        "model": current_user.get("model")
    }

class UserUpdate(BaseModel):
    name: str = None
    masked_id: str = None

class UserFaceUpdate(BaseModel):
    images: List[str]

@router.put("/profile/face")
async def update_face(data: UserFaceUpdate, current_user: dict = Depends(get_current_user)):
    try:
        embeddings = []
        
        if not data.images:
            raise HTTPException(status_code=400, detail="No images provided")

        # Process each image to get embeddings
        for img_b64 in data.images:
            # Decode base64 image
            img = decode_image(img_b64)
            
            if img is None:
                continue

            # Generate embedding
            try:
                result = DeepFace.represent(img_path=img, model_name=settings.DEEPFACE_MODEL, enforce_detection=False)
                if result:
                    embeddings.append(result[0]["embedding"])
            except Exception as e:
                print(f"DeepFace error for image: {e}")
                continue

        if not embeddings:
            raise HTTPException(status_code=400, detail="No faces detected in the provided images")

        db.get_db()[settings.COLLECTION_NAME].update_one(
            {"phone": current_user["phone"]},
            {"$set": {
                "embeddings": embeddings,
                "model": settings.DEEPFACE_MODEL,
                "updated_at": datetime.utcnow()
            }}
        )
        
        return {"status": "success", "message": "Face ID updated successfully"}

    except HTTPException:
        raise
    except Exception as e:
        print(f"Face update error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update face ID")

@router.put("/profile")
async def update_profile(data: UserUpdate, current_user: dict = Depends(get_current_user)):
    try:
        update_data = {k: v for k, v in data.dict().items() if v is not None}
        
        if not update_data:
             raise HTTPException(status_code=400, detail="No data provided to update")
             
        update_data["updated_at"] = datetime.utcnow()
        
        db.get_db()[settings.COLLECTION_NAME].update_one(
            {"phone": current_user["phone"]},
            {"$set": update_data}
        )
        
        return {"status": "success", "message": "Profile updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Update error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update profile")

@router.delete("/profile")
async def delete_profile(current_user: dict = Depends(get_current_user)):
    try:
        result = db.get_db()[settings.COLLECTION_NAME].delete_one({"phone": current_user["phone"]})
        
        if result.deleted_count == 1:
            return {"status": "success", "message": "Account deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="User not found")
            
    except HTTPException:
        raise
    except Exception as e:
        print(f"Delete error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete account")

@router.delete("/admin/users/{phone}")
async def delete_user_admin(phone: str):
    # In a real app, protect this with ADMIN role check
    try:
        # Delete ALL users with this phone number to clean up duplicates
        result = db.get_db()[settings.COLLECTION_NAME].delete_many({"phone": phone})
        
        if result.deleted_count > 0:
            return {"status": "success", "message": f"User deleted successfully ({result.deleted_count} records removed)"}
            
        raise HTTPException(status_code=404, detail="User not found")
        
    except HTTPException:
        raise 
    except Exception as e:
        print(f"Admin delete error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete user")

@router.put("/admin/users/{phone}")
async def update_user_admin(phone: str, data: UserUpdate):
    # In a real app, protect this with ADMIN role check
    try:
        update_data = {k: v for k, v in data.dict().items() if v is not None}
        if not update_data:
             raise HTTPException(status_code=400, detail="No data provided to update")
             
        update_data["updated_at"] = datetime.utcnow()
        
        result = db.get_db()[settings.COLLECTION_NAME].update_one(
            {"phone": phone},
            {"$set": update_data}
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="User not found")
            
        return {"status": "success", "message": "User updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Admin update error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update user")
