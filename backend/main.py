from fastapi import FastAPI, Request
import time
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from core.database import db
from routers import auth

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    db.connect()
    yield
    # Shutdown
    db.close()


tags_metadata = [
    {
        "name": "Authentication",
        "description": "Operations for user registration, login, and profile management.",
    },
]

app = FastAPI(
    title="AI Blink Verification API",
    description="API for biometric authentication using facial recognition and liveness detection.",
    version="1.0.0",
    openapi_tags=tags_metadata,
    lifespan=lifespan
)

@app.middleware("http")
async def log_latency(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = (time.time() - start_time) * 1000
    print(f"Path: {request.url.path} | Method: {request.method} | Time: {process_time:.2f}ms")
    return response

# CORS middleware to allow requests from the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite default port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)

@app.get("/")
async def root():
    return {"message": "Welcome to the AI Blink Verification API"}
