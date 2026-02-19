# Technical Documentation

## Technology Stack

| Component | Technology | Description |
|-----------|------------|-------------|
| **Frontend** | React (Vite) | FAST SPA with Hot Module Replacement. |
| **Computer Vision** | MediaPipe FaceMesh | Runs in-browser for real-time blink/liveness detection. |
| **Backend** | FastAPI | High-performance Python web framework (Async). |
| **Face Recognition** | DeepFace (ArcFace) | State-of-the-art model for generating 512-d face embeddings. |
| **Database** | MongoDB | Document store for flexible user schemas and embedding arrays. |
| **Auth** | JWT (JSON Web Token) | Stateless authentication mechanism. |

## Configuration & Security

1.  **Strict Collection Enforcement**:
    -   The application enforces the use of `COLLECTION_NAME` defined in the `.env` file.
    -   It explicitly refuses to start if this configuration is missing, preventing accidental data writes to default collections (e.g., "users").

2.  **Frontend Startup Logic**:
    -   The application is designed to always load the **Landing Page** (Login/Register) at the root URL (`/`).
    -   Automatic authentication (via `localStorage` token) is restricted to the `/profile` route.
    -   This ensures users always have access to navigation options upon launch, even if a session persists.

## Architecture Overview
## Architecture Overview

1.  **User Registration**:
    - User submits 3 images.
    - Backend uses **DeepFace** (ArcFace model) to generate vector embeddings for each image.
    - Embeddings are stored in MongoDB along with user metadata.

2.  **Liveness Detection (Client-Side)**:
    - **MediaPipe FaceMesh** tracks 468 landmarks on the user's face in real-time.
    - We calculate the **EAR (Eye Aspect Ratio)** to detect blinks.
    - `EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)`
    - If a blink is detected, a frame is captured and sent to the server.

3.  **Verification (Server-Side)**:
    - Server receives the captured frame.
    - Generates a fresh embedding from the frame.
    - Calculates **Cosine Similarity** between the live embedding and stored embeddings.
    - If the *minimum distance* < 0.4 (Threshold), the user is verified.

## API Reference

### Authentication
- `POST /auth/register`: Register new user.
- `POST /auth/check-user`: Check if phone number exists.
- `POST /auth/verify-face`: Verify blink capture against stored face.

### Profile & Admin
- `GET /auth/profile`: Get current user details.
- `PUT /auth/profile`: Update user details.
- `PUT /auth/profile/face`: Update face embeddings (requires 3 new images).
- `DELETE /auth/profile`: Delete own account.
- `GET /auth/admin/users`: List all particular users.
- `DELETE /auth/admin/users/{phone}`: Admin delete user.
- `PUT /auth/admin/users/{phone}`: Admin update user.

## Folder Structure

```
ai-blink-verification/
├── backend/
│   ├── core/
│   │   ├── config.py       # Configuration settings
│   │   ├── database.py     # MongoDB connection logic
│   │   └── security.py     # JWT & Hashing utils
│   ├── routers/
│   │   └── auth.py         # All API routes
│   └── main.py             # App entry & Middleware
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── BlinkDetector.jsx  # MediaPipe logic
    │   │   ├── Login.jsx          # Auth flow
    │   │   ├── Profile.jsx        # User dashboard
    │   │   └── AdminDashboard.jsx # Admin tools
    │   ├── services/
    │   │   └── api.js             # Axios configuration
    │   └── App.jsx                # Routing & Layout
```
