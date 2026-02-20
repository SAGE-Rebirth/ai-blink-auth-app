"""
core/limiter.py — Shared slowapi Limiter instance with Redis→memory fallback.

On startup, this module probes Redis. If Redis is unavailable, it falls back to
in-memory storage (single-worker only, resets on restart) so the app still runs.
"""
import logging
from slowapi import Limiter
from slowapi.util import get_remote_address
from core.config import settings

logger = logging.getLogger(__name__)


def _make_limiter() -> Limiter:
    """Try Redis; if unreachable fall back to in-memory storage."""
    storage_uri = settings.REDIS_URL
    try:
        import redis as _redis
        r = _redis.from_url(storage_uri, socket_connect_timeout=2)
        r.ping()
        logger.info("Rate limiter: using Redis backend at %s", storage_uri)
    except Exception as exc:
        logger.warning(
            "Rate limiter: Redis unavailable (%s). Falling back to in-memory storage "
            "(limits reset on restart, single-worker only).",
            exc,
        )
        storage_uri = "memory://"

    return Limiter(
        key_func=get_remote_address,
        default_limits=[],
        storage_uri=storage_uri,
    )


limiter = _make_limiter()
