"""
main.py — FastAPI application entry point.

Improvements applied:
  #6 facenet-pytorch model warm-up in lifespan startup
  #4 Redis-backed rate limiting via slowapi
  #9 Security headers middleware
     (HSTS, X-Content-Type-Options, X-Frame-Options, etc.)
  #8 Structured JSON-friendly logging instead of print()
"""
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from core.limiter import limiter

from core.database import db
from core.config import settings
from routers import auth

# ---------------------------------------------------------------------------
# Logging — structured, named loggers everywhere
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1️⃣  Connect to MongoDB and create indexes
    db.connect()

    # 2️⃣  facenet-pytorch warm-up — triggers weight download on first run (one-time, ~90 MB)
    logger.info("Warming up the face engine …")
    try:
        from core import face
        face.warm_up()
        logger.info("Face engine ready: %s", face.ENGINE)
    except Exception as exc:
        logger.warning("Face engine warm-up failed (non-fatal): %s", exc)

    # The mesh powers the liveness check. Fetch its model now (~3.6 MB, once)
    # so the first user to log in does not wait for a download.
    try:
        from core import mesh
        mesh.ensure_model()
        logger.info("Face landmarker model ready at %s", mesh.MODEL_PATH)
    except Exception as exc:
        logger.error(
            "Face landmarker model unavailable (%s). Liveness checks will fail until "
            "backend/models/face_landmarker.task can be downloaded.", exc,
        )

    for flag, message in (
        (settings.LOCKOUT_ENABLED, "Account lockout is disabled — brute-force attempts are unlimited."),
        (settings.RATE_LIMIT_ENABLED, "Rate limiting is disabled."),
    ):
        if not flag:
            logger.warning("DEVELOPMENT SETTING: %s Do not deploy this way.", message)

    if not settings.REQUIRE_LIVENESS:
        logger.warning(
            "REQUIRE_LIVENESS is disabled. /auth/verify-face will accept a single frame, "
            "which means a photograph is enough to log in. Do not run this way in production."
        )

    yield

    # Shutdown
    db.close()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
tags_metadata = [
    {
        "name": "Authentication",
        "description": "Operations for user registration, face verification, and profile management.",
    },
    {
        "name": "Admin",
        "description": "Admin-only endpoints. Require JWT with role=admin.",
    },
]

app = FastAPI(
    title="AI Blink Verification API",
    description="Biometric authentication using facial recognition and liveness detection.",
    version="3.0.0",
    openapi_tags=tags_metadata,
    lifespan=lifespan,
)

# Attach limiter to app state so slowapi can find it
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# ---------------------------------------------------------------------------
# Security Headers Middleware (#9)
# ---------------------------------------------------------------------------
_SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; script-src 'self'",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(self)",
}


@app.middleware("http")
async def set_secure_headers(request: Request, call_next):
    response = await call_next(request)
    for header, value in _SECURITY_HEADERS.items():
        response.headers[header] = value
    # Remove the server name to avoid fingerprinting
    try:
        del response.headers["server"]
    except KeyError:
        pass
    return response


# ---------------------------------------------------------------------------
# Latency Logging Middleware (#8)
# ---------------------------------------------------------------------------
@app.middleware("http")
async def log_latency(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "method=%s path=%s status=%s latency=%.2fms",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Admin-Secret"],
)


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(auth.router)


# ---------------------------------------------------------------------------
# Root Endpoints
# ---------------------------------------------------------------------------
@app.get("/", tags=["Health"])
async def root():
    return {"message": "AI Blink Verification API v3.0", "docs": "/docs"}


@app.get("/health", tags=["Health"])
async def health():
    from core import face as face_mod, liveness

    db_conn = db.get_db()
    return {
        "status": "ok" if db_conn is not None else "degraded",
        "db_connected": db_conn is not None,
        "face_engine": face_mod.ENGINE,
        "face_model": (
            f"insightface {settings.ARCFACE_MODEL} (SCRFD + ArcFace)"
            if face_mod.ENGINE == "arcface"
            else "facenet-pytorch (InceptionResnetV1 / vggface2)"
        ),
        "liveness_model": "mediapipe FaceLandmarker (478-point mesh, geometric EAR)",
        "match_threshold": settings.match_threshold,
        "liveness_required": settings.REQUIRE_LIVENESS,
        # Surfaced so the thresholds can be read back while calibrating
        # against real captures — see core/liveness.py.
        "liveness_thresholds": liveness.describe_thresholds(),
        "version": "4.0.0",
    }
