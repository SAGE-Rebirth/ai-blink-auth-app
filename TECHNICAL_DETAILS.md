# Technical Documentation

## Technology Stack

| Component | Technology | Description |
|-----------|------------|-------------|
| **Frontend** | React 19 (Vite) | SPA with Hot Module Replacement. |
| **Client-side CV** | MediaPipe FaceMesh | 468 landmarks in-browser, for capture guidance and blink timing. |
| **Server-side CV** | MediaPipe FaceLandmarker | 478-point mesh, for the liveness check the server can trust. |
| **Backend** | FastAPI | Async Python web framework. |
| **Face Recognition** | insightface `buffalo_l` | SCRFD detection + ArcFace (w600k_r50) → 512-d embeddings, ONNX. `facenet-pytorch` remains selectable as the legacy engine. |
| **Liveness** | Eye Aspect Ratio | Geometric blink verification, invariant to lighting and distance. |
| **Anti-spoofing** | Active illumination challenge | Randomised screen-colour sequence; defeats video replay. |
| **Database** | MongoDB | User documents, plus TTL collections for challenges and replay defence. |
| **Auth** | JWT | Short-lived access token + long-lived refresh token. |

---

## The security model

The single most important thing to understand about this system:

> **Client-side blink detection is not a security control.**

MediaPipe runs in the browser. Anything the browser computes, an attacker can skip — a single-image `/verify-face` endpoint accepts a photograph POSTed with `curl`, no camera involved. The EAR check in `BlinkGate.jsx` exists to tell the *user* when to blink and to assemble a good capture. The control is on the server.

### What the server actually verifies

A login submits three frames captured around one blink:

```
open_before  →  closed  →  open_after
```

`backend/core/liveness.py` then checks, in order:

1. **One face**, in every frame.
2. **Plausible blink timing** — frames in order, total duration 60–1500 ms.
3. **Geometric continuity** — the face stays roughly the same size and position, so three unrelated photographs cannot be stitched together.
4. **The eyes actually closed**, measured from the server's own 478-point mesh.

#### The Eye Aspect Ratio test

The server runs MediaPipe FaceLandmarker itself (`backend/core/mesh.py`) and computes the same quantity the browser does — but where it cannot be forged:

```
EAR = (‖p2−p6‖ + ‖p3−p5‖) / (2 · ‖p1−p4‖)
```

EAR is a ratio of distances *inside the eye*, so lighting, exposure, camera distance and image scale all cancel out.

The test is deliberately **relative, not absolute**:

```
baseline = mean(EAR(open_before), EAR(open_after))
drop     = (baseline − EAR(closed)) / baseline
```

Resting EAR varies enormously between people — eye shape, epicanthic folds, glasses. Measured across 250 real faces, the median open-eye EAR is 0.29 but the 5th percentile is 0.12. A fixed "closed" cutoff would therefore either lock out narrow-eyed users or wave through a lazy squint from someone with wide eyes. Requiring the eye to close by a proportion of *that person's own baseline*, measured in the same bundle seconds earlier, is robust to both.

A genuine blink drops 40–80%. `LIVENESS_MIN_EAR_DROP` defaults to 0.28.

| Attack | Why it fails |
|---|---|
| Same still photo sent three times | No EAR drop |
| Three unrelated photos | Geometry continuity (size/position) fails |
| Lighting or exposure manipulation | Does not move EAR at all |
| A slow squint or eyelid droop | Drop or timing outside the human blink envelope |
| Bystander in shot | More than one face in a frame |
| Replaying a bundle that worked once | The challenge is single-use |
| Replaying the pixels under a fresh challenge | Frame hashes are cached per account |

> **Superseded approach.** An earlier version compared *pixels* in the eye region against a nose "control" region. It was replaced because it was too fragile in practice: the patches were contrast-normalised, and the nose bridge is a low-texture area, so dividing by its small standard deviation amplified sensor noise into a large control delta. Ordinary head drift in a normally-lit room then rivalled the eye signal and the ratio collapsed, rejecting genuine blinks with *"the whole frame changed, not just your eyes."* Geometry does not have this failure mode.

#### Presentation Attack Detection — the replay problem

Blink answers *"did the eyes close"*. It does not answer *"is a real face in front of the camera"*, and those come apart badly under replay.

Hold up a phone playing a video of the user blinking. The frames are genuinely fresh. The Eye Aspect Ratio genuinely drops. The geometry is genuinely continuous. Identity matches, because it really is their face. Every check above passes. The single-use challenge stops a recorded *bundle* being re-submitted; it does nothing about a recorded *face* being re-filmed — and that is also how a real-time deepfake reaches the camera.

So the server makes the client prove physical presence, using light only the server could have chosen.

**The illumination challenge.** Each challenge carries a random colour sequence, e.g. `red → green → blue → green → red`. The client fills the screen with each colour in turn and captures a frame under each, plus one neutral baseline. The server measures how the skin responded:

```
delta_i = skin_colour(frame_i) − skin_colour(baseline)
```

**Only pure primaries are used, and that restriction is load-bearing.** Skin reflectance is *diagonal* — it scales each channel independently — so a pure primary keeps its direction exactly under any skin tone: red light off skin is still red, merely dimmer. A secondary does not survive that. Magenta (1, 0, 1) reflected by skin with albedo (0.65, ·, 0.35) returns at (0.88, 0, 0.47) — 28° from the magenta it was meant to be, and only 45° from plain blue.

That mattered in practice. An earlier version of this palette also carried magenta, cyan and yellow, and had a real hole: because a secondary sits cos 0.707 from two primaries, an attacker responding to an entirely *different* colour set still scored highly, and **12 of 120 such attempts were accepted**. The primaries are mutually orthogonal (worst pairwise cos 0.000), and the exhaustive test now confirms none of the 48 × 47 wrong sequences passes.

Each frame is then judged on its own: the response must point closer to the colour actually emitted than to either other primary, by a margin, and *every* frame must pass. A wrong answer is therefore not a weaker score — it classifies as a different colour.

Measured in simulation (`tests/test_pad.py`), per frame:

| Scenario | Score | Margin over runner-up | Verdict |
|---|---|---|---|
| Real face, any skin tone | 1.000 | 1.000 | pass |
| Real face, weak flash in a bright room | 1.000 | 1.000 | pass |
| Real face, camera correcting 60% of the cast | 0.797 | 0.335 | pass |
| Real face, camera correcting 80% of the cast | 0.538 | −0.108 | **fail** |
| Response to any other primary | ≤ 0 | ≤ 0 | reject |

Thresholds are `PAD_MIN_SCORE = 0.45` and `PAD_MIN_MARGIN = 0.25`.

The 80% row is the honest weak point, and it is a false *rejection*, not a false accept. Aggressive camera auto-white-balance removes exactly the signal being measured, so the client asks the camera to stop (`whiteBalanceMode: 'manual'`, `exposureMode: 'manual'`) on a best-effort basis — support is patchy, and the check still works without it, with less headroom. This is the behaviour most in need of validation against real capture hardware.

Sequence length is 5 over 3 colours with no consecutive repeats, giving 3 × 2⁴ = 48 possibilities.

**What each attack does:**

* **Screen / video replay** — a display *emits* light rather than reflecting it diffusely. Our flash lands as faint specular glare on the glass, which the median skin patch largely misses, so there is no diffuse response to correlate. This is the attack the method is built for.
* **Pre-recorded anything** — the sequence is generated per challenge and unknown until issued. A recording cannot respond to colours chosen after it was made. Guessing is 1-in-48 at the default length; more to the point, a recording shows *constant* illumination, so it produces no response to correlate with at all, whatever the length.
* **Printed photo** — paper genuinely reflects the flash, so illumination alone does **not** catch a print. Print is caught by the blink requirement instead. This is why the layers are kept together and why no single check is ever the whole decision. `tests/test_pad.py::test_a_printed_photo_does_respond_to_light` asserts this limitation explicitly, so it cannot quietly stop being true.

**Accessibility.** Full-screen colour flashing is a photosensitive-seizure hazard. `PAD_FLASH_MS` is 400 ms, giving 2.5 flashes per second — below the 3 Hz threshold in WCAG 2.3.1. Do not lower it without reading that guideline.

**Limits, stated plainly.** This raises the cost of an attack; it does not make one impossible. A high-quality 3D mask, or an attacker injecting frames into a compromised browser rather than filming a screen, is outside what any single-camera software method can settle. Real assurance at that level needs hardware depth/IR or a PAD model evaluated under **ISO/IEC 30107-3**. For context, the Android Biometric Class 3 bar is FAR ≤ 1/50,000, FRR ≤ 10% and **Spoof Accept Rate ≤ 7%** — and Face ID reaches its numbers with a dot projector and IR camera, not a webcam.

#### Why the mesh is not used for identity

A reasonable question is whether the mesh could also do the face *matching* — compare the geometry of two meshes and skip the neural network. Measured on 200 LFW pairs with a scale- and rotation-normalised signature over 24 stable anatomical landmarks:

| Signal | Genuine vs impostor | Best accuracy alone |
|---|---|---|
| Mesh geometry | 0.9915 vs 0.9891 (Cohen's d = 0.24) | **60.4%** |
| CNN embedding | 0.817 vs 0.044 | ~98% |

The mesh lands near chance. MediaPipe fits a *canonical* face template to the image, which by construction regresses toward a generic face and discards much of what makes an individual distinctive. So the mesh answers "are these eyes open or shut" — which it does very well, and in a way that is invariant to everything that broke the pixel method — while the embedding answers "is this the same person".

Reproduce both numbers with `python tools/calibrate.py`.

### Freshness and replay

`backend/core/challenges.py` issues a single-use, phone-bound challenge with a seconds-long TTL, consumed atomically via `findOneAndUpdate`. Separately, every submitted frame's SHA-256 is recorded for `REPLAY_CACHE_MINUTES` behind a unique index on `(phone, fingerprint)` — the index is the enforcement point, so the check is race-free across workers.

Both collections are TTL-indexed; MongoDB expires the rows itself and nothing is swept in application code.

### Lockout

Five failed attempts within a 15-minute window locks the account for 15 minutes. This sits **on top of** the per-IP rate limit, because an attacker who rotates source addresses defeats the rate limit entirely but not a per-account lock. Failed *liveness* checks count too — otherwise the lockout could be sidestepped by always failing at the earlier stage. Admins can clear a lock via `PUT /auth/admin/unlock/{phone}`.

---

## Capture pipeline

### Enrolment — three guided poses

Also note the client derives its blink thresholds from the user's own resting EAR, using the same relative rule as the server, so the two agree on what counts as a blink.

`ENROLL_STEPS` defines centre / slight-left / slight-right. Head pose comes from `getPose()` in `utils/faceMesh.js`, which derives yaw from the imbalance between the two nose-to-cheek distances rather than a fragile 3-D solve.

A shot is taken only when **every** gate holds continuously for 700 ms:

| Gate | Threshold |
|---|---|
| Exactly one face | — |
| Face height | 28–80 % of frame height |
| Off-centre | ≤ 0.20 |
| Head roll | ≤ 0.28 rad (≈16°) |
| Eyes open | EAR ≥ 0.21 |
| Sharpness / brightness / contrast | see `utils/frameQuality.js` |
| Head pose | within the step's yaw tolerance |

Any gate dropping restarts the hold, so a capture only ever comes from a window that stayed good the whole way through. Several candidates are sampled across the hold and the **sharpest** is kept.

The server re-checks all of this on submit (`_embed_enrollment_images`), including that the three images are the same person but *not* three copies of one frame — a template built from identical frames does not generalise.

### Login — the blink bundle

`BlinkGate.jsx` keeps a rolling open-eyed still refreshed every 200 ms. When EAR crosses below 0.21 that standby frame becomes `open_before`; the deepest point of the blink becomes `closed`; 130 ms after the eyes reopen, `open_after` is taken. Hysteresis between 0.21 and 0.26 stops a half-open eye from flapping the state machine.

Identity is measured on the **two open frames only**. Both must match, and their mean must clear `FACENET_THRESHOLD`, so a single fluke frame cannot carry a login.

---

## Matching

Embeddings are L2-normalised at both enrolment and verification, compared by cosine similarity.

### Engine

Two backends, chosen by `FACE_ENGINE`. Measured on LFW with 3-image centroid templates, both detectors given the same padding around the face (`tools/calibrate.py`):

| | facenet / vggface2 | **ArcFace / buffalo_l** |
|---|---|---|
| separation (Cohen's d) | 5.52 | **9.51** |
| genuine mean | 0.836 | 0.717 |
| genuine min | 0.621 | 0.385 |
| impostor max | 0.726 | **0.293** |
| FAR / FRR at its threshold | 0.08% / 2.08% | **0.00% / 0.87%** |

The decisive difference is not the averages — it is that the facenet distributions **overlap**. Its worst impostor (0.726) scores *above* its weakest genuine pair (0.621), so no threshold exists that rejects every stranger without also rejecting real users. ArcFace leaves a clean gap between 0.293 and 0.385, which is what makes a confident operating point possible at all. `ARCFACE_THRESHOLD` defaults to 0.40, inside that gap.

> **Templates are not portable between engines.** The two networks embed into unrelated spaces, so a similarity computed across them is noise, not a weaker signal — it could admit anyone or lock out everyone, unpredictably. Every template records the engine that produced it; a mismatch returns `409` and the user must re-enrol. Untagged templates predate the field and are treated as facenet. The admin user list flags who still needs to re-register (`needs_reenrollment`).

A note on detection: SCRFD needs some context around the face and finds nothing on a tight crop that fills the whole frame. Real webcam frames have that margin — the capture gate keeps the face between 28% and 80% of frame height — but benchmark images often do not, which is why `tools/calibrate.py` pads them.

### Templates are centroids, not collections

Enrolment stores the three per-pose embeddings **and their centroid** (the L2-normalised mean). Verification scores against that single centroid.

This matters more than it sounds. The previous code took the **maximum** similarity over the stored vectors — the most permissive aggregator available. If one stored vector is wrong (a bystander caught in frame during enrolment, or a frame where the detector locked onto the wrong face), verification is free to match *that* vector, and the stranger it belongs to authenticates with a perfect score.

Measured on LFW with 3-image templates (`tools/calibrate.py`):

| Template | Aggregator | Genuine mean | Impostor max | FAR @0.60 | FRR @0.60 |
|---|---|---|---|---|---|
| clean | max | 0.803 | 0.703 | 0.12% | 1.39% |
| clean | **centroid** | **0.817** | 0.733 | **0.08%** | 2.08% |
| poisoned | max | 0.782 | **0.854** | **3.03%** | 2.78% |
| poisoned | **centroid** | 0.708 | 0.747 | **0.12%** | 14.58% |

The centroid is better even on clean templates, and roughly 25× more resistant to a poisoned one.

Two further guards:

* **At enrolment**, `self_consistency()` rejects a set where any embedding disagrees with the centroid by more than `REGISTRATION_MIN_SELF_SIMILARITY` — that is the "somebody else was in the frame" case, caught before it is ever stored.
* **At verification**, accounts enrolled *before* those guards existed have no stored centroid. For them `robust_centroid()` rebuilds one and discards vectors that disagree with the majority, which disarms an already-poisoned template without locking the rightful owner out of the account they need in order to re-enrol. Each such login logs a warning.

### Threshold

`FACENET_THRESHOLD` defaults to **0.60**, chosen from the sweep:

| Threshold | FAR | FRR |
|---|---|---|
| 0.50 | 0.37% | 0.69% |
| **0.60** | **0.08%** | **2.08%** |
| 0.70 | 0.02% | 6.94% |
| 0.85 | 0.00% | ~60% |

The original 0.85 sat deep inside the genuine distribution and rejected roughly three legitimate logins in five. LFW is harder than a cooperative webcam capture, so real-world false rejects should be lower than the table suggests.

### No flip augmentation

There is deliberately no horizontal-flip augmentation. Mirroring every enrolment image doubles the number of stored vectors while adding almost no genuine information — a mirrored frontal face embeds nearly identically to the original — and under the old `max` aggregator it directly doubled the false-accept surface. Real pose coverage comes from the three guided angles instead.

## Performance notes

* The PyTorch models are **not thread-safe**, so all model work is serialised through a single-worker executor in `core/face.py`. The models are created exactly once at import.
* pymongo is synchronous; every database call in the auth path goes through `run_in_threadpool` rather than blocking the event loop.
* A login runs **six mesh passes** with PAD on (three blink frames plus baseline and colour frames) and **two MTCNN passes** (the open frames, detected and embedded together). Each detector is used only where it is the right tool, and neither is run twice on the same frame.
* MediaPipe's `FaceLandmarker` is not safe to call concurrently, so `core/mesh.py` guards it with a lock and the router dispatches it through the threadpool.
* The camera and FaceMesh session is created **once per screen** (`useFaceTracker`) and survives every capture and every failed attempt. The callback lives in a ref so a re-rendering parent never restarts the camera.

---

## Configuration

Required in `.env` (the app refuses to start without them):

| Variable | Notes |
|---|---|
| `COLLECTION_NAME` | No default — prevents accidental writes to a default collection |
| `SECRET_KEY` | Must be ≥ 16 characters |

Key tunables:

| Variable | Default | Purpose |
|---|---|---|
| `FACENET_THRESHOLD` | `0.70` | Cosine similarity required to verify |
| `FACENET_FRAME_MARGIN` | `0.06` | How far below threshold a single frame may fall |
| `REQUIRE_LIVENESS` | `True` | **Keep on.** `False` accepts a single frame — a photo is then enough to log in |
| `LIVENESS_MIN_EAR_DROP` | `0.28` | Fraction the eye must close, relative to the user's own baseline |
| `LIVENESS_MIN_OPEN_EAR` | `0.08` | Floor for "the open frames really are open" (gates ~2% of real faces) |
| `LIVENESS_MAX_CLOSED_EAR` | `0.21` | Absolute ceiling on the closed frame |
| `PAD_ENABLED` | `True` | The illumination challenge. Off leaves video replay wide open |
| `PAD_SEQUENCE_LENGTH` | `5` | Flashes per challenge; 3 × 2ⁿ⁻¹ = 48 possible sequences |
| `PAD_MIN_SCORE` | `0.45` | Per-frame correlation with the emitted primary |
| `PAD_MIN_MARGIN` | `0.25` | How far it must beat the closest other primary |
| `PAD_FLASH_MS` | `400` | Per-colour display time — **2.5 Hz, WCAG 2.3.1** |
| `FACE_ENGINE` | `arcface` | `arcface` or `facenet`. Switching forces every user to re-enrol |
| `ARCFACE_THRESHOLD` | `0.40` | Match threshold for ArcFace (`match_threshold` picks per engine) |
| `ARCFACE_MIN_SELF_SIMILARITY` | `0.65` | Enrolment poisoning gate; measured 0% clean rejected / 100% poisoned caught |
| `LOCKOUT_ENABLED` | `True` | **Currently `False` in `.env` for testing.** Restore before deploying |
| `RATE_LIMIT_ENABLED` | `True` | **Currently `False` in `.env` for testing.** Restore before deploying |
| `REGISTRATION_MIN_SELF_SIMILARITY` | `0.62` | Rejects an enrolment set containing a second person |
| `LIVENESS_DEBUG` | `False` | Return measured metrics in API responses while calibrating |
| `MAX_FAILED_ATTEMPTS` | `5` | Failures before lockout |
| `LOCKOUT_MINUTES` | `15` | Lockout duration |
| `CORS_ORIGINS` | localhost:5173 | Comma-separated allowed origins |

Frontend: set `VITE_API_URL` to point a deployed build at a non-localhost backend.

---

## Tests

```bash
cd backend && ./venv/bin/python -m pytest
```

34 tests, no MongoDB and no camera required — the database is an in-memory fake and the face models are stubbed, so the suite exercises routing and policy rather than PyTorch.

* `test_pad.py` — the illumination challenge, simulating the optics of each attack rather than mocking the verdict
* `test_liveness.py` — the blink decision logic, including each spoof shape, narrow- and wide-eyed users, and the scale-invariance of EAR
* `test_challenges.py` — single-use semantics and replay defence
* `test_auth_api.py` — the full login handshake end to end
* `test_rate_limit.py` — the per-IP limit

`test_liveness.py` builds synthetic meshes with a precisely chosen EAR, so it validates the decision logic exactly. The threshold *values* come from `tools/calibrate.py`, which measures this pipeline against LFW — rerun it after changing models, and tune further against real captures from your own cameras if needed.


---

## Interface

### Responsive layout

The app previously rendered every screen inside a fixed `max-w-md` card, which on a desktop monitor is a phone-width column floating in empty space — a mobile layout served over the web. Layout is now driven by viewport width, not user-agent sniffing, so resizing a desktop window narrow gives the phone layout and a tablet in landscape gets the wide one.

`src/components/AuthLayout.jsx` provides three shapes:

| Shape | Below `lg` (1024px) | At `lg` and above |
|---|---|---|
| `Narrow` | centred card | centred card (forms gain nothing from width) |
| `Hero` | form only | context panel beside the form |
| `Split` | camera, then guidance stacked | camera and guidance side by side, guidance sticky |

The capture screens use `Split`, so the camera preview gets the space it deserves on a desktop while the pose prompts, checklist and thumbnails sit beside it rather than below the fold. Verified with no horizontal overflow at 390 / 768 / 1440 px.

### Photosensitivity consent

`PhotosensitivityNotice` is shown before the first illumination check and must be accepted. Full-screen colour flashing is a genuine seizure risk, and `PAD_FLASH_MS = 400` (2.5 Hz, under the WCAG 2.3.1 limit) makes it *safer*, not safe — staying under a guideline is not informed consent.

Declining is a real branch, not a dead end: the check cannot be skipped without removing the protection it provides, so the app says exactly that and routes the person to an administrator instead of silently downgrading their security. The acknowledgement can be remembered per device via `localStorage`, wrapped in try/catch so private-browsing mode degrades to asking each time.

---

## Frontend performance

Measured with Lighthouse 12 against `vite preview` (the production build). Running Lighthouse against the **dev server** is misleading — it reports unminified, unbundled modules and flags ~1.2 MB of "unminifiable JavaScript" that does not exist in a real build.

| | Dev server | Production, before | Production, after |
|---|---|---|---|
| Performance (desktop) | 77 | 97 | **100** |
| Performance (mobile) | — | — | **99** |
| Accessibility | 92 | 100 | **100** |
| Best Practices | 100 | 100 | **100** |
| First Contentful Paint | 1.6 s | 1.0 s | **0.4 s** |
| Largest Contentful Paint | 2.9 s | 1.0 s | **0.5 s** |
| Total Blocking Time | 0 ms | 0 ms | 0 ms |
| Cumulative Layout Shift | 0 | 0 | 0 |

Three changes got production from 97 to 100:

**The web font was render-blocking.** `index.css` pulled Inter in with `@import url(https://fonts.googleapis.com/...)`. A browser cannot paint until an imported stylesheet resolves, and this one lives on a third-party origin — Lighthouse measured 670 ms of blocking. It is now a `preconnect` pair plus a `rel="preload"` that promotes itself to a stylesheet on load, with a `<noscript>` fallback, and the weight list trimmed from six to the four the app actually uses.

**MediaPipe was in the initial bundle.** `BlinkGate` and `FaceEnroll` pull in FaceMesh, which is the bulk of the JavaScript and is useless until the camera step — yet it was downloaded before the phone-number form could paint. Both are now `React.lazy`, moving 89 KB into a deferred chunk: the main bundle went from 422 KB to 326 KB (139 KB to 105 KB gzipped).

**The build targeted old browsers.** `build.target: 'es2020'`, since anything that can run `getUserMedia` and WebAssembly — which this app requires regardless — supports ES2020.

### Accessibility

Lighthouse found one contrast failure; checking the rest of the palette by hand found two more it had not reached on that page:

| Token | Contrast on card | Verdict | Now |
|---|---|---|---|
| `text-slate-500` (#64748b) | 3.07:1 | fails AA (4.5:1) | `text-slate-400` — 5.71:1 |
| `text-primary-400` (#8470ff) links | 4.00:1 | fails AA | `text-primary-300` — 6.32:1 |
| `placeholder-slate-500` | 2.57:1 | fails AA | `placeholder-slate-400` — 4.76:1 |

### SEO: 63, on purpose

The whole gap is one audit — *"Page is blocked from indexing"* — because `public/robots.txt` sets `Disallow: /`. This is an authentication surface; its routes are private and there is nothing to index. Lighthouse's SEO category assumes you want search traffic, so it scores the deliberate choice as a failure.

If a public landing page is added later, change that file to `Allow: /` for the marketing routes and the score returns to ~100. The original report's SEO 91 was not better — the dev server was returning `index.html` for `/robots.txt` via its SPA fallback, which parsed as 20 errors.
