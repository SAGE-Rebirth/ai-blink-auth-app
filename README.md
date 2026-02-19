# AI Blink Verification Platform

A secure, biometric authentication system that uses facial recognition and liveness detection (blink) to verify user identity. Built with React, FastAPI, and DeepFace.

## Features

- **Biometric Registration**: Capture 3 face angles to create a robust face embedding.
- **Liveness Detection**: Client-side blink detection using MediaPipe ensures the user is real and present.
- **Face Verification**: Server-side DeepFace (ArcFace model) comparison for high-accuracy identity verification.
- **Admin Dashboard**: View, edit, and delete registered users.
- **User Profile**: Update personal details, re-capture face ID, or delete account.
- **Security**: JWT-based authentication and protected routes.

## Prerequisites

Before starting, ensure you have the following installed:

- **Node.js** (v18 or higher)
- **Python** (v3.9 or higher)
- **MongoDB** (Local or Atlas) - *Ensure it is running!*

## Setup & Installation

### 1. Clone the Repository
```bash
git clone <repository-url>
cd ai-blink-verification
```

### 2. Backend Setup
Navigate to the `backend` directory and set up the Python environment.

**Mac/Linux:**
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Windows:**
```bash
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
```

**Environment Variables:**
Create a `.env` file in the `backend` folder:
```env
MONGO_URL=mongodb://localhost:27017  # or your Atlas URL
DB_NAME=ai_blink_db
SECRET_KEY=your_super_secret_key_here
ACCESS_TOKEN_EXPIRE_MINUTES=30
DEEPFACE_MODEL=ArcFace
```

**Run the Backend:**
```bash
uvicorn main:app --reload
```
*The API will be available at `http://localhost:8000`*

### 3. Frontend Setup
Open a new terminal, navigate to the `frontend` directory.

```bash
cd frontend
npm install
npm run dev
```
*The App will be available at `http://localhost:5173`*

## Usage

1.  **Register**: Go to `Register`, enter details, and capture your face 3 times.
2.  **Login**: Enter your registered phone number.
3.  **Blink**: Follow the on-screen prompt to blink. This captures a frame for verification.
4.  **Admin**: Click the `Admin` tab to manage users.
- **Profile**: Once logged in, you can update your details or face ID.

## API Endpoints

### Authentication & User Management

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/register` | Register a new user with face embeddings | No |
| `POST` | `/auth/check-user` | Check if a user exists by phone number | No |
| `POST` | `/auth/verify-face` | Verify user identity via face blink | No |
| `GET` | `/auth/profile` | Get current user's profile details | Yes |
| `PUT` | `/auth/profile` | Update user profile (name, masked ID) | Yes |
| `PUT` | `/auth/profile/face` | Update user's Face ID (re-capture) | Yes |
| `DELETE` | `/auth/profile` | Delete current user's account | Yes |

### Administration

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/auth/admin/users` | List all registered users | No* |
| `PUT` | `/auth/admin/users/{phone}` | Update a specific user by phone | No* |
| `DELETE` | `/auth/admin/users/{phone}`| Delete a specific user by phone | No* |

*\*Note: Admin endpoints currently do not enforce role-based access control for demonstration purposes.*

## Performance
- **Latency Logging**: The backend logs the processing time for every request in the server console (e.g., `Time: 120ms`).

## Dependencies
Major libraries used in this project:

**Backend:**
- `fastapi`: Web framework
- `deepface`: Face recognition and analysis
- `pymongo`: MongoDB driver
- `python-jose`: JWT token handling
- `opencv-python-headless`: Image processing

**Frontend:**
- `react`: UI library
- `vite`: Build tool
- `@mediapipe/face_mesh`: Face landmark detection (for blinks)
- `react-webcam`: Camera handling
- `axios`: API requests
