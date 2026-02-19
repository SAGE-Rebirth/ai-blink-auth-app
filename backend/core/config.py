import os
from pathlib import Path
from dotenv import load_dotenv

# Explicitly load .env file from the backend directory
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

class Settings:
    MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
    DB_NAME = os.getenv("DB_NAME", "ai_blink_verification")
    DEEPFACE_MODEL = "ArcFace"
    SECRET_KEY = os.getenv("SECRET_KEY", "995a52c1cd204053b3ca51336a6ebcc0a32f66cb63ff8160d1f0cf70bb3a5652")
    ACCESS_TOKEN_EXPIRE_MINUTES = 30
    COLLECTION_NAME = os.getenv("COLLECTION_NAME")

    if not COLLECTION_NAME:
        raise ValueError("COLLECTION_NAME not set in .env file. Cannot start application.")

settings = Settings()
