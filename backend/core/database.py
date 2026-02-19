from pymongo import MongoClient
from core.config import settings

class Database:
    client: MongoClient = None

    def connect(self):
        try:
            # serverSelectionTimeoutMS=5000 ensures we fail fast (5s) if IP is not whitelisted or URL is wrong
            self.client = MongoClient(settings.MONGO_URL, serverSelectionTimeoutMS=5000)
            
            # Trigger a command to verify connection
            self.client.admin.command('ping')
            print("INFO:     Successfully connected to MongoDB Database")
        except Exception as e:
            print(f"ERROR:    Could not connect to MongoDB: {e}")
            self.client = None

    def get_db(self):
        if self.client:
            return self.client[settings.DB_NAME]
        print("WARNING:  Database client is not connected")
        return None

    def close(self):
        if self.client:
            self.client.close()
            print("Closed MongoDB connection")

db = Database()
