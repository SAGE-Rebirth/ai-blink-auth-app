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
    const [alert, setAlert] = useState(null);
    const [confirm, setConfirm] = useState(null);

    const [isEditing, setIsEditing] = useState(false);
    const [editForm, setEditForm] = useState({ name: '', masked_id: '' });
    const [editLoading, setEditLoading] = useState(false);

    const [isUpdatingFace, setIsUpdatingFace] = useState(false);
    const [faceCaptureCount, setFaceCaptureCount] = useState(0);
    const [faceImages, setFaceImages] = useState([]);
    const [faceLoading, setFaceLoading] = useState(false);

    const setError = (text) => setAlert({ type: 'error', text });
    const setSuccess = (text) => setAlert({ type: 'success', text });

    const fetchProfile = async () => {
        try {
            const data = await getProfile();
            setUser(data);
            setEditForm({ name: data.name, masked_id: data.masked_id });
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setPageLoading(false);
        }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchProfile(); }, []);

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

    const handleFaceCapture = (imageSrc) => {
        setFaceImages((prev) => {
            if (prev.length >= TOTAL_IMAGES) return prev;
            const next = [...prev, imageSrc];
            if (next.length === TOTAL_IMAGES) submitFaceUpdate(next);
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

    const requestDelete = () => {
        setConfirm({
            title: 'Delete Account',
            message: 'This will permanently delete your account and face data. This cannot be undone.',
            danger: true,
            confirmLabel: 'Yes, Delete',
            onConfirm: async () => {
                setConfirm(null);
                try { await deleteAccount(); handleLogout(); }
                catch (err) { setError(getErrorMessage(err)); }
            },
        });
    };

    const formattedDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';

    if (pageLoading) return (
        <div className="bg-slate-800/60 rounded-2xl p-8 flex flex-col items-center gap-3">
            <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
            <span className="text-slate-400 text-sm">Loading profile…</span>
        </div>
    );

    const inputCls = "w-full bg-slate-700/50 border border-slate-600/50 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 transition-all";

    return (
        <div className="bg-slate-800/60 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 shadow-2xl animate-slide-up">
            {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}

            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-primary-500/20 rounded-xl flex items-center justify-center text-2xl border border-primary-500/30">🪪</div>
                    <div>
                        <h1 className="text-xl font-bold text-white">My Profile</h1>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">✓ Authenticated</span>
                            {user?.role === 'admin' && (
                                <span className="text-xs bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full">🛡 Admin</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {alert && (
                <div className={`flex items-center gap-2 rounded-xl px-4 py-3 mb-4 text-sm font-medium ${alert.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
                    }`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                </div>
            )}

            {/* Face Update */}
            {isUpdatingFace ? (
                <div>
                    <h3 className="font-semibold text-white mb-3">Update Face ID</h3>
                    <div className="capture-dots">
                        {Array.from({ length: TOTAL_IMAGES }).map((_, i) => (
                            <div key={i} className={`capture-dot ${i < faceCaptureCount ? 'capture-dot--filled' : ''}`} />
                        ))}
                    </div>
                    {faceLoading ? (
                        <div className="flex flex-col items-center gap-3 py-6">
                            <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
                            <span className="text-slate-400 text-sm">Processing…</span>
                        </div>
                    ) : (
                        <BlinkDetector key={faceCaptureCount} onBlinkDetected={handleFaceCapture} disabled={faceCaptureCount >= TOTAL_IMAGES} autoCapture={faceCaptureCount > 0} />
                    )}
                    <p className="text-center text-slate-400 text-sm mt-2">
                        {['Blink to capture image 1/3', 'Blink for image 2/3', 'Last one — blink for 3/3', 'Processing…'][Math.min(faceCaptureCount, 3)]}
                    </p>
                    {!faceLoading && (
                        <button onClick={() => { setIsUpdatingFace(false); setFaceImages([]); setFaceCaptureCount(0); }} className="mt-3 w-full py-2 rounded-xl border border-slate-600 text-slate-400 hover:bg-slate-700 transition-all text-sm">Cancel</button>
                    )}
                </div>

            ) : isEditing ? (
                <form onSubmit={handleUpdate} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-1.5">Full Name</label>
                        <input className={inputCls} type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-1.5">Masked ID</label>
                        <input className={inputCls} type="text" value={editForm.masked_id} onChange={(e) => setEditForm({ ...editForm, masked_id: e.target.value })} required />
                    </div>
                    <div className="flex gap-3">
                        <button type="submit" disabled={editLoading} className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-purple-600 text-white font-semibold transition-all">
                            {editLoading ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button type="button" onClick={() => setIsEditing(false)} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 hover:bg-slate-700 transition-all">Cancel</button>
                    </div>
                </form>

            ) : (
                <>
                    {/* Info grid */}
                    <div className="grid grid-cols-1 gap-3 mb-5">
                        {[
                            { label: 'Full Name', value: user?.name },
                            { label: 'Phone', value: user?.phone },
                            { label: 'Masked ID', value: user?.masked_id, mono: true },
                            { label: 'Role', value: user?.role === 'admin' ? '🛡 Administrator' : '👤 User' },
                            { label: 'Registered', value: formattedDate(user?.created_at) },
                        ].map(({ label, value, mono }) => (
                            <div key={label} className="flex justify-between items-center py-2.5 border-b border-slate-700/50">
                                <span className="text-sm text-slate-400">{label}</span>
                                <span className={`text-sm font-medium text-white ${mono ? 'font-mono' : ''}`}>{value}</span>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-3 mb-3">
                        <button onClick={() => setIsEditing(true)} className="flex-1 py-2.5 rounded-xl bg-primary-600/20 hover:bg-primary-600/30 text-primary-300 border border-primary-500/30 font-medium transition-all text-sm">Edit Details</button>
                        <button onClick={() => { setIsUpdatingFace(true); setAlert(null); }} className="flex-1 py-2.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-medium transition-all text-sm">Update Face</button>
                    </div>
                    <button onClick={requestDelete} className="w-full py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-medium transition-all text-sm mb-3">Delete Account</button>
                    <div className="border-t border-slate-700 pt-3">
                        <button onClick={handleLogout} className="w-full py-2 text-sm text-slate-500 hover:text-slate-300 transition-colors">Logout</button>
                    </div>
                </>
            )}
        </div>
    );
};

export default Profile;
