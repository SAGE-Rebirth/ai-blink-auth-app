# Troubleshooting & Errors

## Common Issues

### 1. Database Connection Failed
**Error**: `pymongo.errors.ServerSelectionTimeoutError: localhost:27017: [Errno 61] Connection refused`
**Cause**: MongoDB is not running locally.
**Fix**:
- Start MongoDB: `brew services start mongodb-community` (Mac) or `mongod` (Windows).
- Or, use **MongoDB Atlas** and update `MONGO_URL` in `.env`.

### 2. Frontend White Screen
**Error**: Browser shows a blank screen, Console says `Uncaught ReferenceError` or `Import Error`.
**Cause**: Usually happens if a named export is missing in `api.js` but imported in a component.
**Fix**: Ensure all API functions (`checkUser`, `updateFace`, etc.) are correctly exported in `src/services/api.js`.

### 3. First Request Is Very Slow
**Issue**: The first request to `/register` or `/verify-face` takes a long time.
**Cause**: facenet-pytorch downloads the InceptionResnetV1 (vggface2) weights, ~107 MB, on first run.
**Fix**:
- Be patient the first time. The weights cache in `~/.cache/torch/checkpoints/`.
- The app warms the models during startup, so this cost lands at boot rather than on a user's first login.

### 4. Admin Delete Not Working
**Issue**: "User not found" even though the user is visible in the table.
**Cause**: Potentially duplicate records with the same phone number in the database.
**Fix**: The `DELETE /admin/users/{phone}` endpoint has been updated to use `delete_many`, which will clean up all duplicate entries for that number.

### 5. Camera Not Working
**Issue**: "Permission Denied" or Black Screen.
**Fix**:
- Allow camera access in your browser settings.
- Ensure no other app (Zoom, Teams) is using the camera.
- The page must be served over `https://` or `localhost` — browsers block camera access otherwise.
- The camera error panel in the UI names the specific cause (blocked, missing, in use by another app) and offers a retry that re-requests permission.

### 6. "This verification attempt has expired"
**Cause**: The liveness challenge is single-use and expires in `LIVENESS_CHALLENGE_TTL_SECONDS` (default 60). You see this if the bundle was submitted late, the challenge was already used, or it was issued for a different phone number.
**Fix**: Just blink again — the client fetches a fresh challenge per attempt. If it happens constantly, check the clock skew between the app server and MongoDB.

### 7. "These frames were already submitted"
**Cause**: Replay defence. The same frame pixels were submitted before within `REPLAY_CACHE_MINUTES`.
**Fix**: Expected during development if you replay a recorded request. Real captures are never byte-identical. Lower `REPLAY_CACHE_MINUTES` while testing if it gets in the way.

### 8. Liveness Keeps Failing For Real Users
**Issue**: Genuine blinks rejected with "No blink was detected".
**Cause**: The blink was too shallow, or the open frames were not really open.
**Fix**:
- Read the metrics — every attempt logs them:
  `liveness phone=… ear_before=0.298 ear_closed=0.071 ear_drop=0.764 blink_ms=290`
- `ear_drop` is the fraction the eye closed relative to that user's own baseline. If genuine blinks sit just under `LIVENESS_MIN_EAR_DROP` (0.28), lower it a little.
- Set `LIVENESS_DEBUG=True` to get the metrics back in the API response while tuning.
- Current thresholds are always readable from `GET /health`.

> **If you are seeing "Liveness check failed — the whole frame changed, not just your eyes"**, you are running the older pixel-comparison implementation. That approach was replaced: it measured brightness change in the eye region against a nose "control" region, and normalising a low-texture patch amplified sensor noise enough that ordinary head movement looked like a whole-frame change. Liveness is now geometric (Eye Aspect Ratio) and that failure mode is gone. Pull the current `core/liveness.py` and `core/mesh.py`.

### 9. Unregistered Faces Are Being Authenticated
**Issue**: Someone who never registered can log into another user's account.
**Cause**: Almost always a **poisoned template** — one of the stored enrolment embeddings belongs to a different person, usually a bystander caught in frame. The old code scored a login against the *best-matching* stored vector, so the intruder matched their own embedding with a near-perfect score.
**Fix**:
- Current code stores a centroid and scores against that, and refuses an enrolment set whose captures disagree with each other.
- Accounts enrolled under the old code are repaired on the fly: `robust_centroid()` drops disagreeing vectors and logs
  `phone=… has a legacy template with N disagreeing embedding(s)`.
- **If you see that warning, have the user re-enrol their face** (Profile → Update Face ID). The repair is a safety net, not a substitute for a clean template.
- Make sure nobody else is visible behind you during enrolment. The capture gate now refuses frames containing a second face.
- Verify your operating point with `python tools/calibrate.py`.

### 10. Face Never Matches
**Cause**: `FACENET_THRESHOLD` set too high. It is a **cosine similarity** against the enrolled centroid, where higher is stricter — not a distance.
**Fix**: 0.60 is the measured operating point for InceptionResnetV1/vggface2 with 3-image templates (~0.08% false accepts, ~2% false rejects on LFW). 0.85 sits deep inside the genuine distribution and rejects roughly three real logins in five. Check the logged `mean=` and `min=` on failing attempts, and rerun `tools/calibrate.py` before changing it.

### 11. Account Locked Out
**Issue**: `429` with "Too many failed attempts".
**Cause**: `MAX_FAILED_ATTEMPTS` (default 5) failures inside the attempt window.
**Fix**: Wait `LOCKOUT_MINUTES`, or have an admin call `PUT /auth/admin/unlock/{phone}`.

### 12. npm Vulnerabilities / Install-Script Warnings
**Issue**: `npm i` reports vulnerabilities, or warns that `esbuild` and `fsevents` have install scripts "not yet covered by allowScripts".
**Fix**: Both are resolved in the repo — `npm audit fix` updated the lockfile (direct dependency ranges already allowed the patched versions), and the two build-tool scripts are approved in `package.json` under `allowScripts`. A fresh `npm i` should now be clean. If new advisories appear later, `npm audit fix` is the first thing to try; check `npm run build` still passes afterwards.

### 13. The Screen Flashes Colours During Login
**Not a bug.** That is the presentation-attack check. The server picks a random colour sequence per attempt, the screen displays it, and the server confirms the light actually reflected off your skin in that order. It is what stops someone logging in by holding up a phone playing a video of you.

The sequence runs at 2.5 flashes per second (`PAD_FLASH_MS=400`), below the 3 Hz WCAG 2.3.1 threshold for photosensitive seizure risk. **If you deploy to users, you must still surface a warning before the check** — this project does not currently gather that consent.

### 14. "Your face did not respond to the screen light" / "inconclusive"
**Cause**: The illumination check found no diffuse response — the expected result when a display is pointed at the camera, but also possible for a genuine user.
**Fix**:
- Works best in a **dim room**, facing the screen. Strong ambient light or a bright window behind the screen swamps the flash.
- Raise screen brightness.
- Check the logged metrics: `pad phone=… pad_score=… pad_best_alternative=… pad_margin=…`. A real face scores ~0.9+ with a margin of ~0.2; a replay scores near zero or negative.
- **Aggressive webcam auto-white-balance is the most likely cause of a genuine failure.** It removes the exact colour cast the check measures. The client asks the camera to disable it (`whiteBalanceMode: 'manual'`), but browser support is patchy. In simulation a camera correcting 60% of the cast still passes comfortably (margin 0.335); at 80% it fails. If `pad_worst_frame` is healthy but `pad_margin` is thin, lower `PAD_MIN_MARGIN` a little — and consider whether a different camera behaves better.
- The check needs the *screen* to be the dominant light source. A bright window behind the monitor swamps it.
- To disable while debugging something else: `PAD_ENABLED=False`. That leaves video replay wide open — development only.

### 15. Still Locked Out While Testing
**Fix**: `backend/.env` now ships with `LOCKOUT_ENABLED=False` and `RATE_LIMIT_ENABLED=False`. Existing `locked_until` values are ignored while the flag is off, so nothing needs clearing by hand. Restart the server after changing `.env`. **Set both back to `True` before deploying** — the startup log warns while they are off.

### 16. "Your Face ID was created with an older recognition model"
**Cause**: The recognition engine changed to ArcFace. Templates from the previous engine (`facenet`) embed into a different vector space, so a similarity across them is meaningless — the server refuses rather than scoring it anyway, which could admit the wrong person or reject the right one.
**Fix**: Register the face again (Profile → Update Face ID, or re-register). Admins can see everyone affected via the **🔄 Re-enrol** badge in the user list.
**To postpone**: set `FACE_ENGINE=facenet` in `backend/.env` and restart. Old templates work again, at the older engine's accuracy (0.08% FAR / 2.08% FRR vs 0.00% / 0.87%).

### 17. insightface Installs numpy 2.x and Breaks torch
**Issue**: `Failed to initialize NumPy: _ARRAY_API not found`, then torch operations fail.
**Cause**: `insightface` pulls `opencv-python` 5.x, which requires numpy 2.x — and numpy 2 breaks torch's C-level numpy bridge.
**Fix**: `requirements.txt` pins `numpy<2.0` and `opencv-python-headless<4.13`. If pip upgrades numpy anyway:
```bash
pip uninstall -y opencv-python
pip install --force-reinstall --no-deps "opencv-python-headless<4.13" "numpy<2"
```
This only matters while the legacy facenet engine is still installed. Once every template is on ArcFace, torch can be dropped and the pin with it.

### 18. First Login After Upgrade Is Slow
**Cause**: insightface downloads ~280 MB of models to `~/.insightface/models/` on first use.
**Fix**: The app warms the engine at startup, so this cost lands at boot rather than on a user's first login. Watch for `Face engine ready: arcface` in the log before sending traffic.

### 19. Lighthouse Scores Look Bad
**Issue**: Performance 77, ~1.2 MB of "unminified JavaScript", 2.7 MB payload.
**Cause**: The audit was run against the **Vite dev server** (`localhost:5173`), which serves unbundled, unminified modules with HMR attached. None of that exists in a real build.
**Fix**: Audit the production build instead:
```bash
cd frontend
npm run build
npm run preview -- --port 4173
npx lighthouse http://127.0.0.1:4173/ --preset=desktop --view
```
Production scores 100 (desktop) / 99 (mobile) on Performance.

### 20. SEO Score Is 63
**Not a bug.** `public/robots.txt` sets `Disallow: /`, because this is an authentication surface with nothing worth indexing and private routes behind it. Lighthouse's SEO category assumes you want to be indexed, so it scores that deliberate choice as a failure — the entire gap is the single "Page is blocked from indexing" audit.

If you add a public landing page, relax that file for the marketing routes.
