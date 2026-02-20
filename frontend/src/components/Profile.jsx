import React, { useEffect, useState } from 'react';
import { getProfile, updateProfile, deleteAccount, updateFace, getErrorMessage } from '../services/api';
import { useAuth } from '../App';
import BlinkDetector from './BlinkDetector';
import ConfirmDialog from './ConfirmDialog';

const TOTAL_IMAGES = 3;

const Profile = () => {
    const { handleLogout } = useAuth();

    const [user, setUser] = useState(null);
    const [pageLoading, setPageLoading] = useState(true);
    const [alert, setAlert] = useState(null); // { type, text }
    const [confirm, setConfirm] = useState(null); // { title, message, onConfirm }

    // Edit mode
    const [isEditing, setIsEditing] = useState(false);
    const [editForm, setEditForm] = useState({ name: '', masked_id: '' });
    const [editLoading, setEditLoading] = useState(false);

    // Face update mode
    const [isUpdatingFace, setIsUpdatingFace] = useState(false);
    const [faceCaptureCount, setFaceCaptureCount] = useState(0);
    const [faceImages, setFaceImages] = useState([]);
    const [faceLoading, setFaceLoading] = useState(false);

    const setError = (text) => setAlert({ type: 'error', text });
    const setSuccess = (text) => setAlert({ type: 'success', text });

    // ── Fetch Profile ─────────────────────────────────────────────
    const fetchProfile = async () => {
        try {
            const data = await getProfile();
            setUser(data);
            setEditForm({ name: data.name, masked_id: data.masked_id });
        } catch (err) {
            setError(getErrorMessage(err));
            // 401 will be handled by the global interceptor → auth:logout
        } finally {
            setPageLoading(false);
        }
    };

    // Remove handleLogout from deps — it won't change but including it causes re-fetch on parent re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchProfile(); }, []);

    // ── Update Profile ────────────────────────────────────────────
    const handleUpdate = async (e) => {
        e.preventDefault();
        setAlert(null);
        setEditLoading(true);
        try {
            await updateProfile(editForm);
            setSuccess('Profile updated successfully.');
            setIsEditing(false);
            await fetchProfile();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setEditLoading(false);
        }
    };

    // ── Face Capture for re-enroll ────────────────────────────────
    const handleFaceCapture = (imageSrc) => {
        setFaceImages((prev) => {
            if (prev.length >= TOTAL_IMAGES) return prev;
            const next = [...prev, imageSrc];
            if (next.length === TOTAL_IMAGES) {
                submitFaceUpdate(next);
            }
            return next;
        });
        setFaceCaptureCount((c) => Math.min(c + 1, TOTAL_IMAGES));
    };

    const submitFaceUpdate = async (images) => {
        setFaceLoading(true);
        setAlert(null);
        try {
            await updateFace(images);
            setSuccess('Face ID updated successfully.');
            setIsUpdatingFace(false);
            setFaceImages([]);
            setFaceCaptureCount(0);
        } catch (err) {
            setError(getErrorMessage(err));
            setFaceImages([]);
            setFaceCaptureCount(0);
        } finally {
            setFaceLoading(false);
        }
    };

    const startFaceUpdate = () => {
        setFaceImages([]);
        setFaceCaptureCount(0);
        setIsUpdatingFace(true);
        setAlert(null);
    };

    // ── Delete Account ────────────────────────────────────────────
    const requestDelete = () => {
        setConfirm({
            title: 'Delete Account',
            message: 'This will permanently delete your account and face data. This action cannot be undone.',
            danger: true,
            confirmLabel: 'Yes, Delete',
            onConfirm: async () => {
                setConfirm(null);
                try {
                    await deleteAccount();
                    handleLogout();
                } catch (err) {
                    setError(getErrorMessage(err));
                }
            },
        });
    };

    // ── Render ────────────────────────────────────────────────────
    if (pageLoading) {
        return (
            <div className="card">
                <div className="spinner-overlay">
                    <div className="spinner" />
                    <span>Loading profile…</span>
                </div>
            </div>
        );
    }

    const formattedDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';

    return (
        <div className="card">
            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    message={confirm.message}
                    danger={confirm.danger}
                    confirmLabel={confirm.confirmLabel}
                    onConfirm={confirm.onConfirm}
                    onCancel={() => setConfirm(null)}
                />
            )}

            <div className="card-header">
                <div className="card-icon">🪪</div>
                <h1 className="card-title">My Profile</h1>
                <div className="session-badge">✓ Authenticated Session</div>
            </div>

            {alert && (
                <div className={`alert alert-${alert.type}`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                </div>
            )}

            {/* ── Face Update Section ── */}
            {isUpdatingFace ? (
                <div>
                    <h3 style={{ marginBottom: '0.75rem', fontWeight: 600 }}>Update Face ID</h3>
                    <div className="capture-dots">
                        {Array.from({ length: TOTAL_IMAGES }).map((_, i) => (
                            <div key={i} className={`capture-dot ${i < faceCaptureCount ? 'capture-dot--filled' : ''}`} />
                        ))}
                    </div>
                    {faceLoading ? (
                        <div className="spinner-overlay"><div className="spinner" /><span>Processing…</span></div>
                    ) : (
                        <BlinkDetector onBlinkDetected={handleFaceCapture} disabled={faceCaptureCount >= TOTAL_IMAGES} />
                    )}
                    <p className="instruction">
                        {faceCaptureCount === 0 && 'Blink to capture image 1/3'}
                        {faceCaptureCount === 1 && 'Great! Blink for image 2/3'}
                        {faceCaptureCount === 2 && 'Last one — blink for image 3/3'}
                        {faceCaptureCount >= 3 && 'Processing…'}
                    </p>
                    <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${(faceCaptureCount / TOTAL_IMAGES) * 100}%` }} />
                    </div>
                    {!faceLoading && (
                        <button className="btn btn-secondary" style={{ marginTop: '0.75rem' }} onClick={() => { setIsUpdatingFace(false); setFaceImages([]); setFaceCaptureCount(0); }}>
                            Cancel
                        </button>
                    )}
                </div>
            ) : isEditing ? (
                /* ── Edit Form ── */
                <form onSubmit={handleUpdate}>
                    <div className="form-group">
                        <label className="form-label">Full Name</label>
                        <input className="form-input" type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Masked ID</label>
                        <input className="form-input" type="text" value={editForm.masked_id} onChange={(e) => setEditForm({ ...editForm, masked_id: e.target.value })} required />
                    </div>
                    <div className="btn-group">
                        <button type="submit" className="btn btn-primary" disabled={editLoading}>
                            {editLoading ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setIsEditing(false)}>Cancel</button>
                    </div>
                </form>
            ) : (
                /* ── Profile View ── */
                <>
                    <div className="profile-grid">
                        <div className="profile-item">
                            <span className="profile-item__label">Full Name</span>
                            <span className="profile-item__value">{user?.name}</span>
                        </div>
                        <div className="profile-item">
                            <span className="profile-item__label">Phone Number</span>
                            <span className="profile-item__value">{user?.phone}</span>
                        </div>
                        <div className="profile-item">
                            <span className="profile-item__label">Masked ID</span>
                            <span className="profile-item__value" style={{ fontFamily: 'monospace' }}>{user?.masked_id}</span>
                        </div>
                        <div className="profile-item">
                            <span className="profile-item__label">Registered On</span>
                            <span className="profile-item__value">{formattedDate(user?.created_at)}</span>
                        </div>
                        {user?.updated_at && user.updated_at !== user.created_at && (
                            <div className="profile-item">
                                <span className="profile-item__label">Last Updated</span>
                                <span className="profile-item__value">{formattedDate(user.updated_at)}</span>
                            </div>
                        )}
                    </div>

                    <div className="btn-group" style={{ marginBottom: '0.75rem' }}>
                        <button className="btn btn-primary" onClick={() => setIsEditing(true)}>Edit Details</button>
                        <button className="btn btn-success" onClick={startFaceUpdate}>Update Face</button>
                    </div>
                    <button className="btn btn-danger" onClick={requestDelete}>Delete Account</button>
                    <hr className="divider" />
                    <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
                </>
            )}
        </div>
    );
};

export default Profile;
