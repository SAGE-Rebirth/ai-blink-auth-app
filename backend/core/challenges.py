"""
core/challenges.py — One-shot liveness challenges and replay defence.

A login now costs the client a round trip *before* it may submit any frames:

    POST /auth/challenge  →  { challenge_id, nonce, action, expires_in }
    POST /auth/verify-face with that challenge_id + the captured bundle

The challenge is bound to one phone number, expires in seconds, and is consumed
atomically on first use. That gives us two things a bare image upload cannot:

  * **Freshness** — a bundle captured last week is useless, because the
    challenge it would have to quote is long gone.
  * **Single use** — replaying a bundle that *did* work once fails the second
    time, since the consume is a findOneAndUpdate on an unused document.

Separately, every frame's hash is remembered for REPLAY_CACHE_MINUTES, so an
attacker who grabs a fresh challenge cannot re-submit images they captured
under an older one.

Both collections are TTL-indexed, so MongoDB expires the rows itself and
nothing has to be swept in application code.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from pymongo.errors import DuplicateKeyError

from core import pad
from core.config import settings
from core.database import db

logger = logging.getLogger(__name__)

CHALLENGE_COLLECTION = "liveness_challenges"
REPLAY_COLLECTION = "seen_frames"

# The only action currently issued. Kept as a field so a future "blink twice"
# or "blink, then turn left" can be added without changing the wire format.
ACTION_BLINK = "blink"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _collection(name: str):
    conn = db.get_db()
    if conn is None:
        raise RuntimeError("Database is unavailable.")
    return conn[name]


# ---------------------------------------------------------------------------
# Challenge lifecycle
# ---------------------------------------------------------------------------
def issue(phone: str) -> dict:
    """
    Create a fresh single-use challenge for `phone`.

    The illumination sequence is generated here and stored server-side. It is
    returned to the client because the client has to display it — but it is
    unpredictable until this moment, which is the whole point: a recording made
    earlier cannot have responded to colours chosen now.
    """
    ttl = settings.LIVENESS_CHALLENGE_TTL_SECONDS
    sequence = pad.generate_sequence() if settings.PAD_ENABLED else []
    doc = {
        "_id": secrets.token_urlsafe(24),
        "nonce": secrets.token_urlsafe(16),
        "phone": phone,
        "action": ACTION_BLINK,
        "illumination": sequence,
        "used": False,
        "created_at": _now(),
        "expires_at": _now() + timedelta(seconds=ttl),
    }
    _collection(CHALLENGE_COLLECTION).insert_one(doc)
    return {
        "challenge_id": doc["_id"],
        "nonce": doc["nonce"],
        "action": doc["action"],
        "expires_in": ttl,
        "illumination": [
            {"name": name, "hex": pad.hex_colour(name)} for name in sequence
        ],
        "flash_ms": settings.PAD_FLASH_MS,
    }


def consume(challenge_id: str, phone: str) -> Optional[dict]:
    """
    Atomically claim a challenge. Returns the document on success, or None when
    it does not exist, belongs to another phone, has expired, or was already
    used — the caller cannot tell these apart, and neither can an attacker.
    """
    if not challenge_id:
        return None
    return _collection(CHALLENGE_COLLECTION).find_one_and_update(
        {
            "_id": challenge_id,
            "phone": phone,
            "used": False,
            "expires_at": {"$gt": _now()},
        },
        {"$set": {"used": True, "used_at": _now()}},
    )


# ---------------------------------------------------------------------------
# Replay defence
# ---------------------------------------------------------------------------
def remember_frames(phone: str, fingerprints: List[str]) -> bool:
    """
    Record frame hashes as seen. Returns False if *any* of them was already
    submitted for this phone inside the replay window — i.e. this is a replay.

    Inserts happen one by one so a collision can be attributed; the unique
    index on (phone, fingerprint) is what actually enforces it, which keeps the
    check race-free across workers.
    """
    col = _collection(REPLAY_COLLECTION)
    expires_at = _now() + timedelta(minutes=settings.REPLAY_CACHE_MINUTES)
    for fp in fingerprints:
        try:
            col.insert_one(
                {"phone": phone, "fingerprint": fp, "created_at": _now(), "expires_at": expires_at}
            )
        except DuplicateKeyError:
            logger.warning("Replayed frame rejected for phone=%s", phone)
            return False
    return True
