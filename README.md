<h1>AI Blink Verification System</h1>

<p>
A full-stack biometric authentication system that uses <b>facial recognition</b> and <b>liveness detection</b> (blink capture) to verify user identity, preventing spoofing attacks. Built with a <b>FastAPI</b> backend and a <b>React + Vite</b> frontend.
</p>

---

<h2>Table of Contents</h2>

<ul>
  <li><a href="#overview">Overview</a></li>
  <li><a href="#architecture">Architecture</a></li>
  <li><a href="#backend">Backend</a></li>
  <li><a href="#frontend">Frontend</a></li>
  <li><a href="#security">Security</a></li>
  <li><a href="#setup">Setup &amp; Installation</a></li>
  <li><a href="#environment">Environment Variables</a></li>
  <li><a href="#api">API Reference</a></li>
  <li><a href="#changelog">Full Changelog</a></li>
</ul>

---

<h2 id="overview">Overview</h2>

<p>
The AI Blink Verification System allows users to register and authenticate using only their face.

<b>Registration</b> walks the user through three guided poses (centre, slight left, slight right). Each shot is only taken once a live quality gate passes — one face in frame, correctly framed and level, sharp, well lit, eyes open, and the head actually pointing where the step asks. The frames are converted to 512-d embeddings with <b>insightface</b> (SCRFD detection + ArcFace w600k_r50) and stored as a centroid template.

<b>Login</b> is a two-step handshake. The client requests a single-use liveness challenge, then captures a three-frame bundle around one blink — <code>open_before</code>, <code>closed</code>, <code>open_after</code> — and submits it quoting that challenge. The server runs its own face mesh over the three frames and confirms the eyes really closed, then compares the two open frames against the enrolled template. A verified match returns a short-lived <b>JWT access token</b> and a long-lived <b>refresh token</b>.

<blockquote>
<b>Why the bundle?</b> Blink detection in the browser proves nothing to the server — a single-image endpoint accepts a photograph POSTed straight to the API, camera or no camera. The client-side EAR check is a usability aid that tells the user when to blink; the security control is the server-side analysis in <code>backend/core/liveness.py</code>.
</blockquote>
</p>

---

<h2 id="architecture">Architecture</h2>

```
Ai blink system/
├── backend/
│   ├── core/
│   │   ├── config.py          # Pydantic v2 settings (env-validated)
│   │   ├── database.py        # MongoDB manager with auto-indexes + TTL indexes
│   │   ├── face.py            # SCRFD + ArcFace (or legacy facenet), centroid templates
│   │   ├── mesh.py            # MediaPipe FaceLandmarker (478 points), geometric EAR
│   │   ├── liveness.py        # server-side blink verification
│   │   ├── pad.py             # presentation attack detection (illumination challenge)
│   │   ├── challenges.py      # single-use challenges + replay defence
│   │   ├── limiter.py         # slowapi rate limiter (Redis + memory fallback)
│   │   └── security.py        # JWT access & refresh token logic
│   ├── routers/
│   │   └── auth.py            # All auth & admin endpoints
│   ├── tools/calibrate.py     # measures thresholds against the LFW benchmark
│   ├── tests/                 # pytest suite (no DB or camera required)
│   ├── main.py                # FastAPI app, middleware, lifespan
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    └── src/
        ├── components/
        │   ├── AuthLayout.jsx      # responsive shells (Narrow / Hero / Split)
        │   ├── PhotosensitivityNotice.jsx  # consent before the colour flash
        │   ├── CameraStage.jsx     # shared camera surface + error states
        │   ├── FaceEnroll.jsx      # guided, quality-gated enrolment capture
        │   ├── BlinkGate.jsx       # blink-bundle capture for login
        │   ├── Login.jsx
        │   ├── RegistrationForm.jsx
        │   ├── Profile.jsx
        │   ├── AdminDashboard.jsx
        │   └── ConfirmDialog.jsx
        ├── hooks/
        │   └── useFaceTracker.js   # one camera + FaceMesh session per screen
        ├── context/
        │   └── AuthContext.js
        ├── services/
        │   └── api.js
        ├── utils/
        │   ├── faceMesh.js         # EAR, head pose, framing
        │   ├── frameQuality.js     # sharpness / brightness / contrast
        │   ├── enrollSteps.js      # the three guided poses
        │   └── overlay.js          # canvas overlay drawing
        ├── App.jsx
        ├── App.css
        └── index.css
```

---

<h2 id="backend">Backend</h2>

<h2>Technology Stack</h2>

| Package | Purpose |
|---|---|
| `fastapi` | HTTP API framework |
| `uvicorn[standard]` | ASGI server |
| `deepface` | Facial embedding extraction (ArcFace) |
| `pymongo` | MongoDB driver |
| `pydantic-settings` | Pydantic v2 validated configuration |
| `python-jose[cryptography]` | JWT encoding and decoding |
| `slowapi` | Request rate limiting |
| `redis` | Redis client for persistent rate limiting |
| `opencv-python-headless` | Image decoding |
| `numpy` | Cosine distance computation |
| `python-dotenv` | `.env` file loading |

<h2>Configuration — <code>core/config.py</code></h2>

<p>
Migrated from manual <code>os.getenv()</code> calls to <b>Pydantic v2 <code>BaseSettings</code></b>. The settings class provides:
</p>

<ul>
  <li>Automatic <code>.env</code> file loading with type coercion</li>
  <li>Field validators that reject startup if <code>SECRET_KEY</code> is shorter than 16 characters or if <code>COLLECTION_NAME</code> is blank</li>
  <li>Computed properties: <code>effective_refresh_secret</code> (falls back to <code>SECRET_KEY</code>) and <code>max_b64_chars</code> (image size limit in base64 characters)</li>
  <li>New fields: <code>REFRESH_SECRET_KEY</code>, <code>REFRESH_TOKEN_EXPIRE_DAYS</code>, <code>FACE_DISTANCE_THRESHOLD</code>, <code>MAX_IMAGE_SIZE_MB</code>, <code>REDIS_URL</code>, <code>RATE_LIMIT_FACE_VERIFY</code></li>
</ul>

<h2>Database — <code>core/database.py</code></h2>

<ul>
  <li>All <code>print()</code> statements replaced with <b>structured named loggers</b></li>
  <li>Added <code>_ensure_indexes()</code>: runs on startup and creates a <b>unique index on <code>phone</code></b> and an ascending index on <code>created_at</code>, making every user lookup O(log n)</li>
  <li>Added <code>socketTimeoutMS</code> and <code>connectTimeoutMS</code> for a more robust connection</li>
</ul>

<h2>Security — <code>core/security.py</code></h2>

<ul>
  <li>Introduced a <b>refresh token system</b>: <code>create_refresh_token()</code> and <code>decode_refresh_token()</code></li>
  <li>Both token types carry a <code>type</code> claim (<code>"access"</code> or <code>"refresh"</code>) to prevent cross-use</li>
  <li>Access tokens expire in <b>15 minutes</b> (configurable); refresh tokens expire in <b>7 days</b> (configurable)</li>
  <li>Replaced all <code>print()</code> calls with structured logging</li>
</ul>

<h2>Rate Limiter — <code>core/limiter.py</code></h2>

<ul>
  <li>Uses <b>slowapi</b> with a <b>Redis backend</b> for rate limiting that persists across server restarts and multiple workers</li>
  <li>On startup, Redis is probed with a <b>2-second connect timeout</b>. If Redis is unavailable, the limiter falls back to <b>in-memory storage</b> automatically and logs a warning — the server continues to operate normally</li>
  <li>Extracted into its own module (<code>core/limiter.py</code>) to avoid circular imports between <code>main.py</code> and <code>routers/auth.py</code></li>
</ul>

<h2>Main Application — <code>main.py</code></h2>

<ul>
  <li><b>Structured logging</b>: configured globally with timestamped, level-prefixed format. No <code>print()</code> statements remain</li>
  <li><b>DeepFace model warm-up</b>: <code>DeepFace.build_model()</code> is called during the lifespan startup event, so the model is downloaded and initialised before any request arrives, eliminating cold-start lag</li>
  <li><b>Security headers middleware</b>: every response receives the following headers automatically:
    <ul>
      <li><code>Strict-Transport-Security</code>: enforces HTTPS for one year</li>
      <li><code>X-Frame-Options: DENY</code>: prevents clickjacking</li>
      <li><code>X-Content-Type-Options: nosniff</code>: prevents MIME sniffing</li>
      <li><code>Referrer-Policy: no-referrer</code></li>
      <li><code>Cache-Control: no-store</code></li>
      <li><code>Content-Security-Policy</code>: restricts resource origins</li>
      <li><code>Permissions-Policy</code>: locks down geolocation and microphone; permits camera for self</li>
      <li><code>Server</code> header is removed to prevent fingerprinting</li>
    </ul>
  </li>
  <li>CORS updated to explicitly allow <code>X-Admin-Secret</code> header</li>
  <li>API version bumped to <b>v3.0.0</b></li>
</ul>

<h2>Auth Router — <code>routers/auth.py</code></h2>

<ul>
  <li><b>Async DeepFace processing</b>: all calls to <code>DeepFace.represent()</code> run in a thread-pool executor via <code>asyncio.get_event_loop().run_in_executor()</code>. Multiple images are processed concurrently using <code>asyncio.gather()</code>, so the event loop is never blocked during CPU-intensive work</li>
  <li><b>Image size guard</b>: base64 payload strings are checked against <code>MAX_IMAGE_SIZE_MB</code> before decoding. Images that exceed the limit receive a <code>413 Request Entity Too Large</code> response immediately</li>
  <li><b>slowapi rate limit</b> on <code>POST /auth/verify-face</code>: 5 requests per minute per IP address (configurable via <code>RATE_LIMIT_FACE_VERIFY</code>)</li>
  <li><b>Refresh token endpoint</b>: <code>POST /auth/refresh</code> accepts a valid refresh token and returns a new access token, allowing users to stay logged in without re-scanning their face</li>
  <li><code>POST /auth/verify-face</code> now returns both <code>access_token</code> and <code>refresh_token</code> on success</li>
  <li>Face distance threshold is configurable via <code>FACE_DISTANCE_THRESHOLD</code> in <code>.env</code></li>
  <li>All <code>print()</code> calls replaced with structured logging</li>
  <li>Admin endpoints protected by <code>verify_admin_secret</code> dependency (<code>X-Admin-Secret</code> header)</li>
</ul>

---

<h2 id="frontend">Frontend</h2>

<h2>Authentication State — <code>App.jsx</code></h2>

<ul>
  <li>Introduced <b><code>AuthContext</code></b>: authentication state is derived globally from <code>localStorage</code> and exposed via a <code>useAuth()</code> hook, eliminating prop drilling across all components</li>
  <li>Listens for the <code>auth:logout</code> custom event (dispatched by the 401 interceptor) to automatically redirect the user to the login page</li>
  <li><code>handleLogout()</code> uses the new <code>clearTokens()</code> helper to remove both the access and refresh tokens</li>
</ul>

<h2>API Service — <code>services/api.js</code></h2>

<ul>
  <li>Added <b>token storage helpers</b>: <code>storeTokens({ access_token, refresh_token })</code> and <code>clearTokens()</code></li>
  <li><b>Silent token refresh</b>: the 401 response interceptor now attempts to use the stored refresh token to obtain a new access token before giving up. Parallel requests that fail during a refresh are queued and retried once the new token is issued. Only if the refresh itself fails does the interceptor clear tokens and fire <code>auth:logout</code></li>
</ul>

<h2>BlinkDetector — <code>components/BlinkDetector.jsx</code></h2>

<ul>
  <li><b>Memory leak fix</b>: <code>camera.stop()</code> and <code>faceMesh.close()</code> are called in the <code>useEffect</code> cleanup function</li>
  <li><b>Stale closure fix</b>: blink detection logic is held in a <code>useRef</code> to always access the latest state</li>
  <li><b>Blink cooldown</b>: a 1,200 ms cooldown prevents rapid double-detections</li>
  <li>Visual EAR (Eye Aspect Ratio) meter drawn on the canvas overlay</li>
</ul>

<h2>RegistrationForm — <code>components/RegistrationForm.jsx</code></h2>

<ul>
  <li><b>Race condition fix</b>: the captured images list is held in a <code>useRef</code> rather than state, preventing stale closures from capturing more than three images</li>
  <li>Phone number format validated against a regex (<code>/^\+?\d{7,15}$/</code>) before submission</li>
  <li>Uses <code>storeTokens()</code> to save both tokens on successful registration</li>
</ul>

<h2>Login — <code>components/Login.jsx</code></h2>

<ul>
  <li>Uses <code>AuthContext</code> (no prop drilling)</li>
  <li><b>Double-submission guard</b>: a <code>verifying</code> ref prevents a second face verification being triggered by rapid consecutive blinks</li>
  <li>Structured alert state (<code>{ type, text }</code>) replaces fragile string matching for success and error messages</li>
  <li>Calls <code>storeTokens()</code> on success so both the access and refresh tokens are persisted</li>
</ul>

<h2>Profile — <code>components/Profile.jsx</code></h2>

<ul>
  <li><code>handleLogout</code> removed from <code>useEffect</code> dependencies, preventing spurious re-fetches on every render</li>
  <li><code>window.confirm()</code> replaced with the <b><code>ConfirmDialog</code></b> modal component</li>
  <li>Errors displayed via the <code>getErrorMessage()</code> helper for consistent formatting</li>
</ul>

<h2>AdminDashboard — <code>components/AdminDashboard.jsx</code></h2>

<ul>
  <li>Removed invalid <code>&lt;style jsx&gt;</code> tag (caused a runtime error in Vite)</li>
  <li>Added an <b>admin secret authentication gate</b>: the secret is validated against the backend before any user data is displayed</li>
  <li><code>window.alert()</code> and <code>window.confirm()</code> replaced with <code>ConfirmDialog</code> and structured alert state</li>
  <li>Admin secret forwarded as the <code>X-Admin-Secret</code> header on all admin API calls</li>
</ul>

<h2>ConfirmDialog — <code>components/ConfirmDialog.jsx</code></h2>

<p>
New component that replaces all browser-native <code>window.confirm()</code> calls. Features an animated modal with a backdrop click to dismiss and optional danger styling.
</p>

<h2>Design System — <code>index.css</code> &amp; <code>App.css</code></h2>

<ul>
  <li>Complete dark theme with CSS custom properties for colours, radii, and shadows</li>
  <li><b>Google Fonts (Inter)</b> loaded for all body text</li>
  <li>Glassmorphism cards, smooth gradient background, and micro-animations throughout</li>
  <li>Removed the <code>prefers-color-scheme: light</code> media query that was overriding the dark theme</li>
  <li>Premium component styles: glassmorphic nav, button variants, focus-glow inputs, webcam overlay, progress dots, admin table, modal backdrop, and fully responsive breakpoints</li>
</ul>

---

<h2 id="security">Security Summary</h2>

| Measure | Detail |
|---|---|
| <b>JWT Access Tokens</b> | Short-lived (15 min). Type claim prevents cross-use with refresh tokens |
| <b>JWT Refresh Tokens</b> | Long-lived (7 days). Stored in <code>localStorage</code>; silently exchanged by the 401 interceptor |
| <b>Secret Key Enforcement</b> | Application refuses to start if <code>SECRET_KEY</code> is absent or fewer than 16 characters |
| <b>Admin Endpoints</b> | Protected by a JWT <code>role=admin</code> check (<code>require_admin</code>) |
| <b>Server-side liveness</b> | A blink is verified from the server's own 478-point face mesh, not trusted from the browser. The eye must close by a fraction of the user's own resting Eye Aspect Ratio — see <code>core/liveness.py</code> |
| <b>ArcFace recognition</b> | Measured on LFW at 0.00% false accepts / 0.87% false rejects, against 0.08% / 2.08% for the previous engine. More importantly its genuine and impostor scores do not overlap, so a clean operating point exists |
| <b>Anti-spoofing (PAD)</b> | The screen flashes a randomised sequence of primaries and the server checks the skin responded to each one. A display emits its own light instead of reflecting ours, so a phone replaying a video of the user cannot pass — see <code>core/pad.py</code> |
| <b>Centroid templates</b> | Verification scores against the enrolled centroid, never the best-matching stored vector. Measured, that is ~25x more resistant to a template containing a stranger's face |
| <b>Enrolment poisoning guard</b> | An enrolment set is refused if any capture disagrees with the rest — which is what a bystander caught in frame looks like |
| <b>Single-use challenges</b> | Every login quotes a challenge that expires in seconds and is consumed atomically, so a captured bundle cannot be replayed |
| <b>Frame replay cache</b> | Submitted frame hashes are remembered per account, so recycled pixels fail even under a fresh challenge |
| <b>Account lockout</b> | 5 failed attempts locks the account for 15 minutes — this survives an attacker rotating IPs, which the rate limit alone does not |
| <b>Enrolment quality gates</b> | Registration refuses blurry, distant, multi-face, or near-identical image sets |
| <b>Rate Limiting</b> | 5 face verification attempts per minute per IP; Redis-backed with in-memory fallback |
| <b>Image Size Guard</b> | Base64 payloads exceeding <code>MAX_IMAGE_SIZE_MB</code> are rejected before decoding |
| <b>Security Headers</b> | HSTS, X-Frame-Options, CSP, XCTO, Referrer-Policy, Permissions-Policy on every response |
| <b>CORS</b> | Restricted to the origins in <code>CORS_ORIGINS</code> with explicit methods and headers |
| <b>MongoDB Indexes</b> | Unique index on <code>phone</code> enforces data integrity and speeds up all lookups |

---

<h2 id="setup">Setup &amp; Installation</h2>

<h2>Prerequisites</h2>

<ul>
  <li>Python 3.10 or higher</li>
  <li>Node.js 18 or higher</li>
  <li>MongoDB (running locally or a cloud URI)</li>
  <li>A webcam, and the app served over <code>https://</code> or <code>localhost</code> — browsers refuse camera access otherwise</li>
  <li>~280 MB of ArcFace models, downloaded automatically on first run into <code>~/.insightface/models/</code></li>
  <li>Redis (optional — the app falls back to in-memory rate limiting if unavailable)</li>
</ul>

<h2>Backend</h2>

```bash
cd backend

# Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate   # Windows
# source venv/bin/activate  # macOS / Linux

# Install dependencies
pip install -r requirements.txt

# Copy and configure environment variables
copy .env.example .env
# Edit .env and fill in all required values (see below)

# Start the server
uvicorn main:app --reload
```

<h2>Frontend</h2>

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at `http://localhost:5173`.

---

<h2 id="environment">Environment Variables</h2>

<p>Copy <code>backend/.env.example</code> to <code>backend/.env</code> and set the following values.</p>

<h2>Required</h2>

| Variable | Description |
|---|---|
| <code>COLLECTION_NAME</code> | MongoDB collection for user data (e.g. <code>users_v2</code>) |
| <code>SECRET_KEY</code> | JWT signing secret — must be at least 16 characters. Generate with: <code>python -c "import secrets; print(secrets.token_hex(32))"</code> |

<h2>Recommended</h2>

| Variable | Default | Description |
|---|---|---|
| <code>REFRESH_SECRET_KEY</code> | Falls back to <code>SECRET_KEY</code> | Separate signing secret for refresh tokens |
| <code>ADMIN_SECRET</code> | *(empty — disables admin endpoints)* | Password for <code>X-Admin-Secret</code> header |
| <code>MONGO_URL</code> | <code>mongodb://localhost:27017</code> | MongoDB connection string |
| <code>DB_NAME</code> | <code>ai_blink_db</code> | MongoDB database name |

<h2>Optional</h2>

| Variable | Default | Description |
|---|---|---|
| <code>ACCESS_TOKEN_EXPIRE_MINUTES</code> | <code>15</code> | Access token lifetime in minutes |
| <code>REFRESH_TOKEN_EXPIRE_DAYS</code> | <code>7</code> | Refresh token lifetime in days |
| <code>DEEPFACE_MODEL</code> | <code>ArcFace</code> | DeepFace face recognition model |
| <code>FACE_DISTANCE_THRESHOLD</code> | <code>0.40</code> | Cosine distance threshold for a match (lower = stricter) |
| <code>MAX_IMAGE_SIZE_MB</code> | <code>5.0</code> | Maximum image payload size in megabytes |
| <code>REDIS_URL</code> | <code>redis://localhost:6379</code> | Redis connection URI for rate limiting |
| <code>RATE_LIMIT_FACE_VERIFY</code> | <code>5/minute</code> | Rate limit for the face verification endpoint |

---

<h2 id="api">API Reference</h2>

<p>Full interactive documentation is available at <code>http://localhost:8000/docs</code> when the server is running.</p>

<h2>Public Endpoints</h2>

| Method | Path | Description |
|---|---|---|
| <code>POST</code> | <code>/auth/register</code> | Register a new user with name, phone, and 3 face images |
| <code>POST</code> | <code>/auth/check-user</code> | Check whether a phone number is registered |
| <code>POST</code> | <code>/auth/challenge</code> | Issue a single-use liveness challenge (required before verifying) |
| <code>POST</code> | <code>/auth/verify-face</code> | Verify a blink bundle and receive access + refresh tokens |
| <code>POST</code> | <code>/auth/refresh</code> | Exchange a refresh token for a new access token |
| <code>GET</code> | <code>/health</code> | Server and database health check |

<h2>Authenticated Endpoints (Bearer Token Required)</h2>

| Method | Path | Description |
|---|---|---|
| <code>GET</code> | <code>/auth/profile</code> | Retrieve the authenticated user's profile |
| <code>PUT</code> | <code>/auth/profile</code> | Update name or masked ID |
| <code>PUT</code> | <code>/auth/profile/face</code> | Re-enrol face with 3 new images |
| <code>DELETE</code> | <code>/auth/profile</code> | Delete the authenticated user's own account |

<h2>Admin Endpoints (Bearer Token with <code>role=admin</code>)</h2>

| Method | Path | Description |
|---|---|---|
| <code>GET</code> | <code>/auth/admin/users</code> | List all registered users |
| <code>PUT</code> | <code>/auth/admin/users/{phone}</code> | Update any user by phone number |
| <code>DELETE</code> | <code>/auth/admin/users/{phone}</code> | Delete any user by phone number |
| <code>PUT</code> | <code>/auth/admin/promote/{phone}</code> | Grant a user the admin role |
| <code>PUT</code> | <code>/auth/admin/demote/{phone}</code> | Revoke a user's admin role |
| <code>PUT</code> | <code>/auth/admin/unlock/{phone}</code> | Clear a lockout after repeated failed attempts |

<h2>Login Flow</h2>

<p>Verification takes two calls. The challenge expires in seconds and is consumed on first use, so fetch it immediately before submitting.</p>

```http
POST /auth/challenge
{ "phone": "9876543210" }

→ {
    "challenge_id": "…",
    "nonce": "…",
    "action": "blink",
    "expires_in": 60,
    "illumination": [
      { "name": "red",   "hex": "#ff0000" },
      { "name": "green", "hex": "#00ff00" },
      { "name": "blue",  "hex": "#0000ff" },
      { "name": "green", "hex": "#00ff00" },
      { "name": "red",   "hex": "#ff0000" }
    ],
    "flash_ms": 400
  }
```

```http
POST /auth/verify-face
{
  "phone": "9876543210",
  "challenge_id": "…",
  "frames": [
    { "phase": "open_before", "t_ms": 0,   "image": "data:image/jpeg;base64,…", "ear": 0.31 },
    { "phase": "closed",      "t_ms": 130, "image": "data:image/jpeg;base64,…", "ear": 0.13 },
    { "phase": "open_after",  "t_ms": 290, "image": "data:image/jpeg;base64,…", "ear": 0.30 },

    { "phase": "illum_base",  "t_ms": 0,    "image": "…" },
    { "phase": "illum_0",     "t_ms": 400,  "image": "…" },
    { "phase": "illum_1",     "t_ms": 800,  "image": "…" },
    { "phase": "illum_2",     "t_ms": 1200, "image": "…" },
    { "phase": "illum_3",     "t_ms": 1600, "image": "…" },
    { "phase": "illum_4",     "t_ms": 2000, "image": "…" }
  ]
}
```

<p>
The <code>illum_*</code> frames are captured while the screen displays each colour from the challenge's <code>illumination</code> array, in the order given, preceded by one neutral baseline frame. The server reads the expected sequence from its stored challenge and never from the request, so a client cannot choose which colours it is graded against.
</p>

<p>
A rejected bundle returns <code>400</code> with a user-facing <code>detail</code>. Liveness rejections also carry the header <code>X-Liveness-Failed: 1</code>, so the UI can coach the user ("blink once, deliberately") rather than accuse them of being the wrong person. An identity mismatch returns <code>200</code> with <code>verified: false</code> and a confidence score.
</p>

<h2>Calibration</h2>

<p>
Every face-related threshold in <code>core/config.py</code> comes from a measurement rather than a guess. Reproduce them:
</p>

```bash
cd backend
./venv/bin/pip install scikit-learn      # calibration only, not needed to run the app
./venv/bin/python tools/calibrate.py
```

<p>It downloads the LFW benchmark and reports a threshold sweep (false accept vs false reject at each operating point), an aggregator comparison on clean and deliberately poisoned templates, and how mesh geometry compares with the CNN embedding as an identity signal.</p>

<blockquote>
<b>Development settings.</b> <code>backend/.env</code> currently sets <code>LOCKOUT_ENABLED=False</code> and <code>RATE_LIMIT_ENABLED=False</code> so repeated test captures are not blocked. Together they remove every brute-force protection on face verification. Both must go back to <code>True</code> before any real deployment; the server logs a warning at startup while they are off.
</blockquote>

<p>Every login also logs its measured liveness metrics, so you can tune against your own cameras:</p>

```
liveness phone=… passed=True ear_before=0.2981 ear_closed=0.0712
         ear_after=0.3055 ear_drop=0.7638 blink_ms=290.0
```

<p>
Set <code>LIVENESS_DEBUG=True</code> to have those returned in the API response while tuning. Current thresholds are always readable from <code>GET /health</code>.
</p>

---

<h2 id="changelog">Full Changelog</h2>

<h2>v3.0.0 — Current</h2>

<b>Backend</b>

<ul>
  <li>Migrated configuration to <b>Pydantic v2 <code>BaseSettings</code></b> with field validators and computed properties</li>
  <li>Added <b>MongoDB automatic indexing</b> on startup (unique phone index, created_at index)</li>
  <li>Implemented <b>refresh token system</b> with separate secret key, type claims, and <code>/auth/refresh</code> endpoint</li>
  <li>All DeepFace calls are now <b>async</b> via thread-pool executor; multiple images processed concurrently</li>
  <li>Added <b>image size guard</b> (configurable via <code>MAX_IMAGE_SIZE_MB</code>)</li>
  <li>Implemented <b>Redis-backed rate limiting</b> via slowapi with automatic in-memory fallback</li>
  <li>Extracted limiter to <code>core/limiter.py</code> to resolve circular imports</li>
  <li>Added <b>DeepFace model warm-up</b> in lifespan startup to eliminate first-request lag</li>
  <li>Replaced all <code>print()</code> calls with <b>structured named loggers</b></li>
  <li>Added <b>security headers middleware</b> (HSTS, X-Frame-Options, CSP, XCTO, Referrer-Policy, Permissions-Policy, Server header removal)</li>
  <li>Removed hardcoded <code>SECRET_KEY</code> fallback; startup fails if absent or too short</li>
  <li>Admin endpoints secured with <code>X-Admin-Secret</code> header dependency</li>
  <li>Tightened CORS to specific methods and headers including <code>X-Admin-Secret</code></li>
</ul>

<b>Frontend</b>

<ul>
  <li>Introduced <b><code>AuthContext</code></b> for global authentication state</li>
  <li>Implemented <b>silent token refresh</b> in the 401 interceptor with request queuing</li>
  <li>Added <code>storeTokens()</code> and <code>clearTokens()</code> helpers to manage both tokens</li>
  <li>Fixed <b>memory leak</b> in <code>BlinkDetector</code> (camera and FaceMesh cleanup on unmount)</li>
  <li>Fixed <b>stale closure</b> in blink detection (refs instead of state)</li>
  <li>Fixed <b>race condition</b> in image capture (ref-based image list)</li>
  <li>Fixed <b>double-submission</b> in login (<code>verifying</code> ref guard)</li>
  <li>Replaced all <code>window.confirm()</code> / <code>window.alert()</code> with <code>ConfirmDialog</code> component</li>
  <li>Removed invalid <code>&lt;style jsx&gt;</code> tag from <code>AdminDashboard</code></li>
  <li>Added admin secret authentication gate to <code>AdminDashboard</code></li>
  <li>Complete dark theme with glassmorphism, Inter font, CSS custom properties, and micro-animations</li>
</ul>

---

<p>
<b>Licence:</b> MIT &nbsp;|&nbsp;
<b>Python:</b> 3.10+ &nbsp;|&nbsp;
<b>Node:</b> 18+
</p>

---

<h2 id="upgrading">Upgrading an existing deployment</h2>

<p>
The face recognition engine changed from <code>facenet-pytorch</code> to <b>ArcFace</b>. The two embed into unrelated spaces, so <b>every enrolled template must be captured again</b> — a score computed across engines is noise, not a weaker match, so the server refuses rather than guessing.
</p>

<ul>
  <li>Affected users get a <code>409</code> at login with a clear prompt to set up Face ID again.</li>
  <li>The admin user list flags them with a <b>🔄 Re-enrol</b> badge.</li>
  <li>To postpone the migration, set <code>FACE_ENGINE=facenet</code> in <code>backend/.env</code>. Existing templates keep working, at the older engine's accuracy.</li>
</ul>

<p>
If you have migrated everyone, <code>facenet-pytorch</code>, <code>torch</code> and <code>torchvision</code> can be removed from <code>requirements.txt</code> — roughly 1&nbsp;GB of dependencies.
</p>
