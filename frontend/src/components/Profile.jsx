import React, { useEffect, useState, useCallback } from 'react';
import { getProfile, updateProfile, deleteAccount, updateFace } from '../services/api';
import BlinkDetector from './BlinkDetector';

const Profile = ({ onLogout }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [isUpdatingFace, setIsUpdatingFace] = useState(false);
    const [editForm, setEditForm] = useState({ name: '', masked_id: '' });
    const [updateMessage, setUpdateMessage] = useState('');

    useEffect(() => {
        fetchProfile();
    }, [onLogout]);

    const fetchProfile = async () => {
        try {
            const data = await getProfile();
            setUser(data);
            setEditForm({ name: data.name, masked_id: data.masked_id });
        } catch (err) {
            setError('Failed to load profile. Please login again.');
            console.error(err);
            if (err.detail === "Could not validate credentials") {
                onLogout();
            }
        } finally {
            setLoading(false);
        }
    };

    const handleUpdate = async (e) => {
        e.preventDefault();
        setUpdateMessage('');
        try {
            await updateProfile(editForm);
            setUpdateMessage('Profile updated successfully!');
            setIsEditing(false);
            fetchProfile(); // Refresh data
        } catch (err) {
            setUpdateMessage(`Error: ${err.detail || 'Failed to update'}`);
        }
    };

    const [capturedImages, setCapturedImages] = useState([]);

    const handleFaceUpdate = useCallback(async (imageSrc) => {
        setCapturedImages(prev => {
            const newImages = [...prev, imageSrc];
            if (newImages.length === 3) {
                // Determine if we should process now
                submitFaceUpdate(newImages);
            }
            return newImages;
        });
    }, []);

    const submitFaceUpdate = async (images) => {
        setLoading(true);
        setUpdateMessage('Processing face update...');
        try {
            await updateFace(images);
            setUpdateMessage('Face ID updated successfully!');
            setIsUpdatingFace(false);
            setCapturedImages([]);
            fetchProfile();
        } catch (err) {
            setUpdateMessage(`Error: ${err.detail || 'Failed to update face'}`);
            setCapturedImages([]); // Reset on error
        } finally {
            setLoading(false);
        }
    };

    const startFaceUpdate = () => {
        setCapturedImages([]);
        setUpdateMessage('');
        setIsUpdatingFace(true);
    };

    const handleDelete = async () => {
        if (window.confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
            try {
                await deleteAccount();
                onLogout();
            } catch (err) {
                setUpdateMessage(`Error: ${err.detail || 'Failed to delete account'}`);
            }
        }
    };

    if (loading && !isUpdatingFace) return <div className="processing-state"><div className="spinner"></div></div>;

    if (error) return (
        <div className="login-container">
            <div className="message error">{error}</div>
            <button onClick={onLogout} className="btn-secondary">Back to Login</button>
        </div>
    );

    return (
        <div className="login-container">
            <div className="success-card">
                <h2>User Profile</h2>

                {updateMessage && <div className={`message ${updateMessage.includes('Error') ? 'error' : 'success'}`}>{updateMessage}</div>}

                {isUpdatingFace ? (
                    <div className="face-update-section" style={{ marginBottom: '20px' }}>
                        <h3>Update Face ID</h3>
                        <div className="webcam-wrapper">
                            <BlinkDetector onBlinkDetected={handleFaceUpdate} />
                        </div>
                        <p className="instruction-text">
                            {capturedImages.length === 0 && "Blink to capture image 1/3"}
                            {capturedImages.length === 1 && "Great! Blink again for image 2/3"}
                            {capturedImages.length === 2 && "One last blink for image 3/3"}
                            {capturedImages.length === 3 && "Processing..."}
                        </p>
                        <div className="progress-bar">
                            <div className="progress-fill" style={{ width: `${(capturedImages.length / 3) * 100}%` }}></div>
                        </div>
                        <button onClick={() => { setIsUpdatingFace(false); setCapturedImages([]); }} className="btn-secondary" style={{ marginTop: '10px' }}>Cancel</button>
                    </div>
                ) : !isEditing ? (
                    <>
                        {/* ... details ... */}
                        <div className="profile-details" style={{ textAlign: 'left', margin: '2rem 0' }}>
                            <p><strong>Name:</strong> {user?.name}</p>
                            <p><strong>Phone:</strong> {user?.phone}</p>
                            <p><strong>Masked ID:</strong> {user?.masked_id}</p>
                            <p><strong>Registered:</strong> {user?.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}</p>
                            {user?.updated_at && <p><strong>Last Updated:</strong> {new Date(user.updated_at).toLocaleDateString()}</p>}
                        </div>

                        <div className="action-buttons-vertical" style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '1rem' }}>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                <button onClick={() => setIsEditing(true)} className="btn-primary" style={{ flex: 1 }}>Edit Details</button>
                                <button onClick={startFaceUpdate} className="btn-primary" style={{ flex: 1, backgroundColor: '#4CAF50' }}>Update Face</button>
                            </div>
                            <button onClick={handleDelete} className="btn-secondary" style={{ borderColor: '#f44336', color: '#f44336' }}>Delete Account</button>
                        </div>
                    </>
                ) : (
                    <form onSubmit={handleUpdate} className="profile-details" style={{ textAlign: 'left', margin: '2rem 0' }}>
                        <div className="form-group">
                            <label>Name</label>
                            <input
                                type="text"
                                value={editForm.name}
                                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label>Masked ID</label>
                            <input
                                type="text"
                                value={editForm.masked_id}
                                onChange={(e) => setEditForm({ ...editForm, masked_id: e.target.value })}
                                required
                            />
                        </div>
                        <div className="action-buttons" style={{ display: 'flex', gap: '10px' }}>
                            <button type="submit" className="btn-primary" style={{ flex: 1 }}>Save</button>
                            <button type="button" onClick={() => setIsEditing(false)} className="btn-secondary" style={{ flex: 1 }}>Cancel</button>
                        </div>
                    </form>
                )}

                <div className="token-status">✓ Authenticated Session</div>
                <button onClick={onLogout} className="btn-secondary" style={{ width: '100%' }}>Logout</button>
            </div>
        </div>
    );
};

export default Profile;
