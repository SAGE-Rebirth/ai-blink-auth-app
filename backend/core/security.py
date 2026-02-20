"""
security.py — JWT access + refresh token creation/verification, admin guard.
"""
import logging
from typing import Union, Any
from datetime import datetime, timedelta
from jose import jwt, JWTError
from fastapi import Depends, HTTPException, status, Header
from fastapi.security import OAuth2PasswordBearer
from core.config import settings
from core.database import db

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"
ACCESS_TOKEN_TYPE = "access"
REFRESH_TOKEN_TYPE = "refresh"

# tokenUrl is set to the face verification endpoint as semantic equivalent
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/verify-face")


# ---------------------------------------------------------------------------
# Token Creation
# ---------------------------------------------------------------------------

def create_access_token(subject: Union[str, Any]) -> str:
    """Create a short-lived JWT access token (default: 15 minutes)."""
    expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"exp": expire, "sub": str(subject), "type": ACCESS_TOKEN_TYPE}
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
    logger.debug("Access token created for subject: %s, expires: %s", subject, expire)
    return token


def create_refresh_token(subject: Union[str, Any]) -> str:
    """Create a long-lived JWT refresh token (default: 7 days)."""
    expire = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"exp": expire, "sub": str(subject), "type": REFRESH_TOKEN_TYPE}
    token = jwt.encode(payload, settings.effective_refresh_secret, algorithm=ALGORITHM)
    logger.debug("Refresh token created for subject: %s, expires: %s", subject, expire)
    return token


def decode_refresh_token(token: str) -> str:
    """
    Decode and validate a refresh token.
    Returns the phone (subject) or raises 401.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired refresh token.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.effective_refresh_secret, algorithms=[ALGORITHM])
        phone: str = payload.get("sub")
        token_type: str = payload.get("type")
        if phone is None or token_type != REFRESH_TOKEN_TYPE:
            raise credentials_exception
        return phone
    except JWTError as e:
        logger.warning("Refresh token decode failed: %s", e)
        raise credentials_exception


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

async def get_current_user(token: str = Depends(oauth2_scheme)):
    """FastAPI dependency: validates a JWT access token and returns the user document."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired session. Please log in again.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        phone: str = payload.get("sub")
        token_type: str = payload.get("type")
        if phone is None or token_type != ACCESS_TOKEN_TYPE:
            raise credentials_exception
    except JWTError as e:
        logger.warning("Access token decode failed: %s", e)
        raise credentials_exception

    db_conn = db.get_db()
    if db_conn is None:
        raise HTTPException(status_code=503, detail="Database unavailable.")

    user = db_conn[settings.COLLECTION_NAME].find_one({"phone": phone})
    if user is None:
        raise credentials_exception
    return user


def verify_admin_secret(x_admin_secret: str = Header(default="")):
    """FastAPI dependency for admin-only endpoints. Validates the X-Admin-Secret header."""
    if not settings.ADMIN_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin access is not configured on this server.",
        )
    if x_admin_secret != settings.ADMIN_SECRET:
        logger.warning("Admin access denied — invalid secret provided")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid admin secret.",
        )
