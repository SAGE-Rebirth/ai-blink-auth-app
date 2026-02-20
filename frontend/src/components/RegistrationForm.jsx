import React, { useState, useRef, useCallback } from 'react';
import BlinkDetector from './BlinkDetector';
import { registerUser, getErrorMessage } from '../services/api';
import { useNavigate } from 'react-router-dom';

const TOTAL_IMAGES = 3;

const CAPTURE_HINTS = [
    'Look straight at the camera',
    'Turn your head slightly to the left',
    'Turn your head slightly to the right',
];

const RegistrationForm = () => {
    const navigate = useNavigate();
    const [step, setStep] = useState(1); // 1: Details, 2: Face Capture
    const [formData, setFormData] = useState({ name: '', phone: '', masked_id: '' });
    const [loading, setLoading] = useState(false);
    const [alert, setAlert] = useState(null); // { type, text }

    // ── Use a REF for image list to avoid stale-closure race condition ──
    const capturedImagesRef = useRef([]);
    const [captureCount, setCaptureCount] = useState(0); // only for display
    const [captureComplete, setCaptureComplete] = useState(false);
    const [previewImages, setPreviewImages] = useState([]);

    const setError = (text) => setAlert({ type: 'error', text });

    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    // ── Step 1 Validation ─────────────────────────────────────────
    const handleNext = (e) => {
        e.preventDefault();
        setAlert(null);
        const { name, phone, masked_id } = formData;
        if (name.trim().length < 2) { setError('Name must be at least 2 characters.'); return; }
        if (!/^\+?\d{7,15}$/.test(phone.trim())) { setError('Enter a valid phone number (7–15 digits).'); return; }
        if (!masked_id.trim()) { setError('Masked ID is required.'); return; }
        setStep(2);
    };

    // ── Step 2: Blink captures image ──────────────────────────────
    const handleBlinkDetected = useCallback((imageSrc) => {
        // Use ref to read current length — avoids stale closure
        const current = capturedImagesRef.current;
        if (current.length >= TOTAL_IMAGES) return;

        capturedImagesRef.current = [...current, imageSrc];
        const newCount = capturedImagesRef.current.length;

        setCaptureCount(newCount);
        setPreviewImages((prev) => [...prev, imageSrc]);

        if (newCount >= TOTAL_IMAGES) {
            setCaptureComplete(true);
        }
    }, []);

    const retake = () => {
        capturedImagesRef.current = [];
        setCaptureCount(0);
        setPreviewImages([]);
        setCaptureComplete(false);
        setAlert(null);
    };

    // ── Submit Registration ───────────────────────────────────────
    const handleSubmit = async () => {
        setAlert(null);
        setLoading(true);
        try {
            const payload = {
                ...formData,
                name: formData.name.trim(),
                phone: formData.phone.trim(),
                masked_id: formData.masked_id.trim(),
                images: capturedImagesRef.current,
            };
            await registerUser(payload);
            setAlert({ type: 'success', text: 'Registration successful! Redirecting to login…' });
            setTimeout(() => navigate('/'), 1800);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // ── Render ────────────────────────────────────────────────────
    return (
        <div className="card">
            <div className="card-header">
                <div className="card-icon">✦</div>
                <h1 className="card-title">Create Account</h1>
                <p className="card-subtitle">
                    {step === 1 ? 'Enter your details to get started' : `Capture your face — ${captureCount} / ${TOTAL_IMAGES}`}
                </p>
            </div>

            {alert && (
                <div className={`alert alert-${alert.type}`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                </div>
            )}

            {/* Step 1 */}
            {step === 1 && (
                <form onSubmit={handleNext}>
                    <div className="form-group">
                        <label className="form-label" htmlFor="name">Full Name</label>
                        <input id="name" className="form-input" type="text" name="name" value={formData.name} onChange={handleInputChange} placeholder="e.g. Priya Sharma" required autoFocus />
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor="phone">Phone Number</label>
                        <input id="phone" className="form-input" type="tel" name="phone" value={formData.phone} onChange={handleInputChange} placeholder="e.g. 9876543210" required />
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor="masked_id">Masked ID</label>
                        <input id="masked_id" className="form-input" type="text" name="masked_id" value={formData.masked_id} onChange={handleInputChange} placeholder="e.g. XXXX-XXXX-4321" required />
                    </div>
                    <button type="submit" className="btn btn-primary">Next: Capture Face →</button>
                    <hr className="divider" />
                    <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                        Already registered?{' '}
                        <button type="button" className="link-btn" onClick={() => navigate('/')}>Login</button>
                    </p>
                </form>
            )}

            {/* Step 2 — Face Capture */}
            {step === 2 && (
                <div>
                    {/* Capture dots */}
                    <div className="capture-dots">
                        {Array.from({ length: TOTAL_IMAGES }).map((_, i) => (
                            <div key={i} className={`capture-dot ${i < captureCount ? 'capture-dot--filled' : ''}`} />
                        ))}
                    </div>

                    {!captureComplete ? (
                        <>
                            <BlinkDetector onBlinkDetected={handleBlinkDetected} />
                            <p className="instruction">{CAPTURE_HINTS[captureCount] || 'Hold still and blink'}</p>
                        </>
                    ) : (
                        <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                            <p style={{ fontSize: '2rem' }}>✓</p>
                            <p style={{ color: 'var(--success)', fontWeight: 600, marginBottom: '0.5rem' }}>All 3 images captured!</p>
                        </div>
                    )}

                    {/* Preview thumbs */}
                    {previewImages.length > 0 && (
                        <div className="preview-thumbs">
                            {previewImages.map((img, idx) => (
                                <img key={idx} src={img} alt={`capture-${idx + 1}`} className="preview-thumb" />
                            ))}
                        </div>
                    )}

                    {captureComplete && (
                        <div className="btn-group" style={{ marginTop: '1rem' }}>
                            <button className="btn btn-secondary" onClick={retake} disabled={loading}>Retake</button>
                            <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
                                {loading ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Registering…</> : 'Complete Registration'}
                            </button>
                        </div>
                    )}

                    {!captureComplete && (
                        <button className="btn-ghost" style={{ marginTop: '1rem', display: 'block', width: '100%', textAlign: 'center' }} onClick={() => { retake(); setStep(1); }}>
                            ← Back to Details
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default RegistrationForm;
