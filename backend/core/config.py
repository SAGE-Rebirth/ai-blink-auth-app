"""
config.py — Pydantic v2 Settings with full type coercion and .env auto-loading.
Replaces manual os.getenv() calls with a proper, validated settings model.
"""
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Database
    MONGO_URL: str = "mongodb://localhost:27017"
    DB_NAME: str = "ai_blink_db"
    COLLECTION_NAME: str  # Required — no default (raises if missing)

    # Auth
    SECRET_KEY: str          # Required — no default (raises if missing)
    REFRESH_SECRET_KEY: str = ""  # Used for refresh tokens; falls back to SECRET_KEY
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15        # Short-lived access token
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7           # Long-lived refresh token

    # Admin
    ADMIN_SECRET: str = ""

    # Face recognition
    DEEPFACE_MODEL: str = "ArcFace"
    FACE_DISTANCE_THRESHOLD: float = 0.40
    MAX_IMAGE_SIZE_MB: float = 5.0              # Guard: reject base64 images bigger than this

    # Rate limiter (slowapi / Redis)
    RATE_LIMIT_ENABLED: bool = True
    REDIS_URL: str = "redis://localhost:6379"
    RATE_LIMIT_FACE_VERIFY: str = "5/minute"    # format expected by slowapi

    @field_validator("COLLECTION_NAME")
    @classmethod
    def collection_must_be_set(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("COLLECTION_NAME must not be empty.")
        return v.strip()

    @field_validator("SECRET_KEY")
    @classmethod
    def secret_key_must_be_set(cls, v: str) -> str:
        if not v or len(v) < 16:
            raise ValueError("SECRET_KEY must be at least 16 characters long.")
        return v

    @property
    def effective_refresh_secret(self) -> str:
        """Falls back to SECRET_KEY when REFRESH_SECRET_KEY is not provided."""
        return self.REFRESH_SECRET_KEY or self.SECRET_KEY

    @property
    def max_b64_chars(self) -> int:
        """Maximum base64 string length for an image (with ~37% base64 overhead)."""
        return int(self.MAX_IMAGE_SIZE_MB * 1024 * 1024 * 1.37)


settings = Settings()
