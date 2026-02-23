import React, { useState, useRef, useCallback } from 'react';
import BlinkDetector from './BlinkDetector';
import { registerUser, getErrorMessage } from '../services/api';
import { useNavigate } from 'react-router-dom';

const TOTAL_IMAGES = 3;
const CAPTURE_HINTS = [
    'Look straight at the camera and blink',
    'Slowly turn your head to your LEFT — hold still',
    'Slowly turn your head to your RIGHT — hold still',
];

const RegistrationForm = () => {
    const navigate = useNavigate();
    const [step, setStep] = useState(1);
    const [formData, setFormData] = useState({ name: '', phone: '', masked_id: '' });
    const [loading, setLoading] = useState(false);
    const [alert, setAlert] = useState(null);

    const capturedImagesRef = useRef([]);
    const [captureCount, setCaptureCount] = useState(0);
    const [captureComplete, setCaptureComplete] = useState(false);
    const [previewImages, setPreviewImages] = useState([]);

    const setError = (text) => setAlert({ type: 'error', text });

    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    const handleNext = (e) => {
        e.preventDefault();
        setAlert(null);
        const { name, phone, masked_id } = formData;
        if (name.trim().length < 2) { setError('Name must be at least 2 characters.'); return; }
        if (!/^\+?\d{7,15}$/.test(phone.trim())) { setError('Enter a valid phone number (7–15 digits).'); return; }
        if (!masked_id.trim()) { setError('Masked ID is required.'); return; }
        setStep(2);
    };

    const handleBlinkDetected = useCallback((imageSrc) => {
        const current = capturedImagesRef.current;
        if (current.length >= TOTAL_IMAGES) return;
        capturedImagesRef.current = [...current, imageSrc];
        const newCount = capturedImagesRef.current.length;
        setCaptureCount(newCount);
        setPreviewImages((prev) => [...prev, imageSrc]);
        if (newCount >= TOTAL_IMAGES) setCaptureComplete(true);
    }, []);

    const retake = () => {
        capturedImagesRef.current = [];
        setCaptureCount(0);
        setPreviewImages([]);
        setCaptureComplete(false);
        setAlert(null);
    };

    const handleSubmit = async () => {
        setAlert(null);
        setLoading(true);
        try {
            const res = await registerUser({
                ...formData,
                name: formData.name.trim(),
                phone: formData.phone.trim(),
                masked_id: formData.masked_id.trim(),
                images: capturedImagesRef.current,
            });
            const isAdmin = res.role === 'admin';
            setAlert({
                type: 'success',
                text: `Registration successful! ${isAdmin ? '🛡 You are the admin.' : ''} Redirecting to login…`
            });
            setTimeout(() => navigate('/'), 1800);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const inputCls = "w-full bg-slate-700/50 border border-slate-600/50 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500/50 transition-all";

    return (
        <div className="bg-slate-800/60 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 shadow-2xl animate-slide-up">
            {/* Header */}
            <div className="text-center mb-6">
                <div className="w-16 h-16 bg-primary-500/20 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3 border border-primary-500/30">
                    ✦
                </div>
                <h1 className="text-2xl font-bold text-white">Create Account</h1>
                <p className="text-slate-400 text-sm mt-1">
                    {step === 1 ? 'Enter your details to get started' : `Capture your face — ${captureCount} / ${TOTAL_IMAGES}`}
                </p>
            </div>

            {/* Alert */}
            {alert && (
                <div className={`flex items-center gap-2 rounded-xl px-4 py-3 mb-4 text-sm font-medium ${alert.type === 'success'
                        ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                        : 'bg-red-500/10 border border-red-500/30 text-red-300'
                    }`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                </div>
            )}

            {/* Step 1 — Details */}
            {step === 1 && (
                <form onSubmit={handleNext} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-1.5">Full Name</label>
                        <input className={inputCls} type="text" name="name" value={formData.name} onChange={handleInputChange} placeholder="e.g. Priya Sharma" required autoFocus />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-1.5">Phone Number</label>
                        <input className={inputCls} type="tel" name="phone" value={formData.phone} onChange={handleInputChange} placeholder="e.g. 9876543210" required />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-1.5">Masked ID</label>
                        <input className={inputCls} type="text" name="masked_id" value={formData.masked_id} onChange={handleInputChange} placeholder="e.g. XXXX-XXXX-4321" required />
                    </div>
                    <button type="submit" className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-600 to-purple-600 hover:from-primary-500 hover:to-purple-500 text-white font-semibold transition-all duration-200">
                        Next: Capture Face →
                    </button>
                    <div className="relative my-2"><div className="border-t border-slate-700" /><span className="absolute left-1/2 -translate-x-1/2 -top-2.5 bg-slate-800 px-2 text-xs text-slate-500">or</span></div>
                    <p className="text-center text-sm text-slate-400">
                        Already registered?{' '}
                        <button type="button" onClick={() => navigate('/')} className="text-primary-400 hover:text-primary-300 font-medium transition-colors">Login</button>
                    </p>
                </form>
            )}

            {/* Step 2 — Face Capture */}
            {step === 2 && (
                <div>
                    {/* Progress dots */}
                    <div className="capture-dots mb-4">
                        {Array.from({ length: TOTAL_IMAGES }).map((_, i) => (
                            <div key={i} className={`capture-dot ${i < captureCount ? 'capture-dot--filled' : ''}`} />
                        ))}
                    </div>

                    {!captureComplete ? (
                        <>
                            <BlinkDetector
                                key={captureCount}
                                onBlinkDetected={handleBlinkDetected}
                                autoCapture={captureCount > 0}
                                countdownSecs={3}
                            />
                            <p className="text-center text-slate-400 text-sm mt-2">
                                {captureCount === 0 ? CAPTURE_HINTS[0] : `${CAPTURE_HINTS[captureCount]} — hold still`}
                            </p>
                        </>
                    ) : (
                        <div className="text-center py-4">
                            <p className="text-4xl mb-1">✓</p>
                            <p className="text-emerald-400 font-semibold">All 3 images captured!</p>
                        </div>
                    )}

                    {/* Preview */}
                    {previewImages.length > 0 && (
                        <div className="preview-thumbs mt-3">
                            {previewImages.map((img, idx) => (
                                <img key={idx} src={img} alt={`capture-${idx + 1}`} className="preview-thumb" />
                            ))}
                        </div>
                    )}

                    {/* Actions */}
                    {captureComplete && (
                        <div className="flex gap-3 mt-4">
                            <button onClick={retake} disabled={loading} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 hover:bg-slate-700 transition-all font-medium">
                                Retake
                            </button>
                            <button onClick={handleSubmit} disabled={loading} className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-purple-600 hover:from-primary-500 hover:to-purple-500 text-white font-semibold transition-all flex items-center justify-center gap-2">
                                {loading ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Registering…</> : 'Complete Registration'}
                            </button>
                        </div>
                    )}

                    {!captureComplete && (
                        <button onClick={() => { retake(); setStep(1); }} className="mt-3 w-full text-center text-sm text-slate-500 hover:text-slate-300 transition-colors py-2">← Back to Details</button>
                    )}
                </div>
            )}
        </div>
    );
};

export default RegistrationForm;
