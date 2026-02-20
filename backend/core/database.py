"""
database.py — MongoDB connection manager with structured logging and automatic indexes.
"""
import logging
from pymongo import MongoClient, ASCENDING
from pymongo.errors import OperationFailure
from core.config import settings

logger = logging.getLogger(__name__)


class Database:
    client: MongoClient = None

    def connect(self):
        try:
            self.client = MongoClient(
                settings.MONGO_URL,
                serverSelectionTimeoutMS=5000,
                connectTimeoutMS=5000,
                socketTimeoutMS=10000,
            )
            # Fail fast — verify the connection is actually alive
            self.client.admin.command("ping")
            logger.info("Successfully connected to MongoDB at %s", settings.MONGO_URL)
            self._ensure_indexes()
        except Exception as e:
            logger.error("Could not connect to MongoDB: %s", e)
            self.client = None

    def _ensure_indexes(self):
        """Create necessary indexes on startup. Idempotent — safe to call multiple times."""
        if self.client is None:
            return
        try:
            col = self.client[settings.DB_NAME][settings.COLLECTION_NAME]

            # Unique index on phone — makes all user lookups O(log n)
            col.create_index([("phone", ASCENDING)], unique=True, background=True)

            # Index on created_at — useful for admin sorting
            col.create_index([("created_at", ASCENDING)], background=True)

            logger.info(
                "Indexes ensured on collection '%s.%s'",
                settings.DB_NAME,
                settings.COLLECTION_NAME,
            )
        except OperationFailure as e:
            logger.warning("Could not create indexes: %s", e)

    def get_db(self):
        if self.client:
            return self.client[settings.DB_NAME]
        logger.warning("Database client is not connected; returning None")
        return None

    def close(self):
        if self.client:
            self.client.close()
            logger.info("MongoDB connection closed")


db = Database()
