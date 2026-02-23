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
from fastapi.responses import JSONResponse
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
    logger.info("Warming up facenet-pytorch (MTCNN + InceptionResnetV1) …")
    try:
        from routers.auth import _mtcnn, _resnet  # noqa: F401 — import triggers model init
        logger.info("facenet-pytorch models ready (device: %s).", next(_resnet.parameters()).device)
    except Exception as exc:
        logger.warning("facenet-pytorch warm-up failed (non-fatal): %s", exc)

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
    allow_origins=["http://localhost:5173"],
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
    db_conn = db.get_db()
    return {
        "status": "ok" if db_conn is not None else "degraded",
        "db_connected": db_conn is not None,
        "face_model": "facenet-pytorch (InceptionResnetV1 / vggface2)",
        "facenet_threshold": settings.FACENET_THRESHOLD,
        "version": "4.0.0",
    }
