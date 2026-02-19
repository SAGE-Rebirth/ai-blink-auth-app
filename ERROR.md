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

### 3. DeepFace Model Download
**Issue**: The first request to `/register` or `/verify` takes forever or times out.
**Cause**: DeepFace downloads the ~500MB `ArcFace` model file on the first run.
**Fix**:
- Be patient on the first run.
- Or, manually download the weights to `~/.deepface/weights/`.

### 4. Admin Delete Not Working
**Issue**: "User not found" even though the user is visible in the table.
**Cause**: Potentially duplicate records with the same phone number in the database.
**Fix**: The `DELETE /admin/users/{phone}` endpoint has been updated to use `delete_many`, which will clean up all duplicate entries for that number.

### 5. Camera Not Working
**Issue**: "Permission Denied" or Black Screen.
**Fix**:
- Allow camera access in your browser settings.
- Ensure no other app (Zoom, Teams) is using the camera.
- Check if `react-webcam` is receiving `MediaStream`.
