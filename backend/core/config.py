"""
config.py — Pydantic v2 Settings with full type coercion and .env auto-loading.
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

    # Admin (legacy header — kept for backwards compat, not used for new JWT-role auth)
    ADMIN_SECRET: str = ""

    # ── Face recognition ──────────────────────────────────────────────────
    # 'arcface' = insightface buffalo_l (SCRFD + ArcFace w600k_r50), the default.
    # 'facenet' = the legacy facenet-pytorch pipeline, kept for comparison.
    # Templates are NOT portable between the two; switching forces re-enrolment.
    FACE_ENGINE: str = "arcface"
    ARCFACE_MODEL: str = "buffalo_l"

    # ── Legacy facenet notes ──────────────────────────────────────────────
    # Cosine similarity between a live embedding and the enrolled *centroid*.
    # The usable range differs per engine, so there is one threshold each and
    # `match_threshold` picks the right one.
    #
    # ArcFace, measured on LFW with 3-image templates (tools/calibrate.py):
    # genuine min 0.385, impostor max 0.293 — a clean gap. 0.40 sits above every
    # impostor in that set while costing ~0.65% false rejects.
    ARCFACE_THRESHOLD: float = 0.40
    # facenet, same protocol: genuine min 0.621, impostor max 0.726. The
    # distributions overlap, so this value is a compromise, not a clean cut.
    FACENET_THRESHOLD: float = 0.60
    # Second, softer gate: with a 3-frame bundle both open frames must match, and
    # their *mean* similarity must clear the main threshold, while neither frame
    # may fall below (threshold - this margin). One lucky frame is not enough.
    FACENET_FRAME_MARGIN: float = 0.06
    # Registration quality: reject a template whose images are all near-identical,
    # since it generalises badly. 1.0 disables the check.
    REGISTRATION_MAX_PAIR_SIMILARITY: float = 0.995
    # …and reject one that is internally inconsistent. A stored vector that
    # disagrees with the rest is usually a second person caught in frame, and a
    # template poisoned that way is what lets strangers authenticate.
    # Measured per engine (tools/calibrate.py). For ArcFace, clean 3-image
    # templates bottom out at 0.689 agreement while templates poisoned with a
    # stranger top out at 0.597 — 0.65 sits in that gap and catches 100% of
    # poisoned sets while rejecting none of the clean ones.
    ARCFACE_MIN_SELF_SIMILARITY: float = 0.65
    # Legacy path, carried forward rather than re-measured.
    FACENET_MIN_SELF_SIMILARITY: float = 0.62
    # Variance of the Laplacian — below this the frame is too blurry to enrol.
    REGISTRATION_MIN_SHARPNESS: float = 45.0
    # Detected face width as a fraction of frame width; below this the user is
    # too far from the camera for a reliable template.
    MIN_FACE_WIDTH_FRAC: float = 0.18
    MAX_IMAGE_SIZE_MB: float = 5.0    # Guard: reject base64 images bigger than this

    # ── Liveness (server-side blink verification) ─────────────────────────
    # See core/liveness.py for what each metric means and how to calibrate.
    REQUIRE_LIVENESS: bool = True          # False downgrades to single-frame (INSECURE)
    LIVENESS_DEBUG: bool = False           # echo measured metrics in API responses
    LIVENESS_CHALLENGE_TTL_SECONDS: int = 60
    # Blink is judged from mesh geometry (Eye Aspect Ratio), not pixels.
    # The main test is relative — the eye must close by this fraction of the
    # user's own open baseline — because resting EAR varies widely by eye shape.
    LIVENESS_MIN_EAR_DROP: float = 0.28    # genuine blinks drop 40–80%
    # Floor for "the open frames really are open". Set from measurement: at 0.13
    # this gated ~9% of genuinely open-eyed faces, at 0.08 it gates ~3%. It is a
    # sanity bound only — the real test is the relative drop above.
    LIVENESS_MIN_OPEN_EAR: float = 0.08
    LIVENESS_MAX_CLOSED_EAR: float = 0.21  # absolute ceiling on the closed frame
    LIVENESS_MIN_BLINK_MS: float = 60.0
    LIVENESS_MAX_BLINK_MS: float = 1500.0
    LIVENESS_MAX_SIZE_SPREAD: float = 0.35    # face size drift across the bundle
    LIVENESS_MAX_CENTER_SHIFT: float = 0.45   # face centre drift, in face widths
    REPLAY_CACHE_MINUTES: int = 15            # remember submitted frame hashes this long

    # ── Presentation Attack Detection (core/pad.py) ───────────────────────
    # The active illumination challenge: the screen flashes a random colour
    # sequence and the server checks the skin responded in that order. This is
    # what stops a phone playing a video of the user from authenticating.
    PAD_ENABLED: bool = True
    # Length 5 over three primaries, no consecutive repeats -> 3 x 2^4 = 48
    # possible sequences. Longer costs flashing time; see PAD_FLASH_MS.
    PAD_SEQUENCE_LENGTH: int = 5
    # Per frame: how closely the skin response must point at the emitted primary,
    # and how far that must beat the closest other primary. Measured in
    # simulation (tests/test_pad.py): a genuine response scores 1.000 with a
    # margin of 1.000 across skin tones, dropping to 0.797 / 0.335 under a
    # camera correcting 60% of the colour cast. A response to a different
    # primary scores at or below 0.
    PAD_MIN_SCORE: float = 0.45
    PAD_MIN_MARGIN: float = 0.25
    # How long each colour is displayed. Kept at 400 ms so the sequence runs at
    # 2.5 flashes per second, below the 3 Hz threshold in WCAG 2.3.1 for
    # photosensitive seizure risk. Do not lower this without reading that
    # guideline — full-screen colour flashing is a real accessibility hazard.
    PAD_FLASH_MS: int = 400

    # ── Account lockout (per phone, complements the per-IP rate limit) ────
    # Turn OFF only for development. With this disabled an attacker can make
    # unlimited verification attempts against a known phone number, which is
    # exactly the brute-force the lockout exists to stop. Re-enable before any
    # real deployment.
    LOCKOUT_ENABLED: bool = True
    MAX_FAILED_ATTEMPTS: int = 5
    LOCKOUT_MINUTES: int = 15
    FAILED_ATTEMPT_WINDOW_MINUTES: int = 15

    # Rate limiter (slowapi / Redis)
    RATE_LIMIT_ENABLED: bool = True
    REDIS_URL: str = "redis://localhost:6379"
    RATE_LIMIT_FACE_VERIFY: str = "5/minute"    # format expected by slowapi
    RATE_LIMIT_CHALLENGE: str = "20/minute"
    RATE_LIMIT_CHECK_USER: str = "10/minute"
    RATE_LIMIT_REGISTER: str = "5/hour"

    # ── CORS ──────────────────────────────────────────────────────────────
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"

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
    def match_threshold(self) -> float:
        """The similarity threshold for whichever face engine is configured."""
        return (
            self.ARCFACE_THRESHOLD
            if self.FACE_ENGINE.strip().lower() == "arcface"
            else self.FACENET_THRESHOLD
        )

    @property
    def self_similarity_threshold(self) -> float:
        """How much an enrolled vector must agree with the rest of its template."""
        return (
            self.ARCFACE_MIN_SELF_SIMILARITY
            if self.FACE_ENGINE.strip().lower() == "arcface"
            else self.FACENET_MIN_SELF_SIMILARITY
        )

    @property
    def cors_origin_list(self) -> list[str]:
        """CORS_ORIGINS parsed from its comma-separated .env form."""
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def max_b64_chars(self) -> int:
        """Maximum base64 string length for an image (with ~37% base64 overhead)."""
        return int(self.MAX_IMAGE_SIZE_MB * 1024 * 1024 * 1.37)


settings = Settings()
