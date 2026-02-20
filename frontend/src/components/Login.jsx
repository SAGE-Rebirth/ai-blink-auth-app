import React, { useState, useCallback, useRef } from 'react';
import BlinkDetector from './BlinkDetector';
import { checkUser, verifyUser, getErrorMessage, storeTokens } from '../services/api';
import { useAuth } from '../App';
import { useNavigate } from 'react-router-dom';

const Login = () => {
    const { handleLoginSuccess } = useAuth();
    const navigate = useNavigate();

    const [step, setStep] = useState(1); // 1: Phone Input, 2: Blink Verify
    const [phone, setPhone] = useState('');
    const [userName, setUserName] = useState('');
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [alert, setAlert] = useState(null); // { type: 'success'|'error', text: string }
    const [verifiedUser, setVerifiedUser] = useState(null);

    const setError = (text) => setAlert({ type: 'error', text });
    const setSuccess = (text) => setAlert({ type: 'success', text });

    // ── Step 1: Check phone ───────────────────────────────────────
    const handleNext = async (e) => {
        e.preventDefault();
        setAlert(null);
        const cleaned = phone.trim();
        if (!cleaned || cleaned.length < 7) {
            setError('Please enter a valid phone number.');
            return;
        }
        setLoading(true);
        try {
            const data = await checkUser(cleaned);
            setUserName(data.name);
            setStep(2);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // ── Step 2: Blink captured → verify face ──────────────────────
    const handleBlinkDetected = useCallback(
        async (imageSrc) => {
            if (verifying) return; // Ignore additional blinks while processing
            setVerifying(true);
            setAlert(null);

            try {
                const data = await verifyUser({ phone: phone.trim(), image: imageSrc });

                if (data.verified) {
                    storeTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
                    setVerifiedUser(data.user);
                    setSuccess(`Welcome back, ${data.user.name}!`);
                    setTimeout(() => handleLoginSuccess(), 1200);
                } else {
                    setError(data.message || 'Face verification failed. Please try blinking again.');
                    setVerifying(false);
                }
            } catch (err) {
                setError(getErrorMessage(err));
                setVerifying(false);
            }
        },
        [phone, verifying, handleLoginSuccess]
    );

    const reset = () => {
        setStep(1);
        setPhone('');
        setUserName('');
        setAlert(null);
        setLoading(false);
        setVerifying(false);
        setVerifiedUser(null);
    };

    // ── Render ────────────────────────────────────────────────────
    return (
        <div className="card">
            <div className="card-header">
                <div className="card-icon">👁</div>
                <h1 className="card-title">Face Authentication</h1>
                <p className="card-subtitle">
                    {step === 1 ? 'Enter your phone number to begin' : `Hi ${userName} — blink to verify`}
                </p>
            </div>

            {alert && (
                <div className={`alert alert-${alert.type}`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                </div>
            )}

            {/* Step 1 — Phone input */}
            {step === 1 && (
                <form onSubmit={handleNext}>
                    <div className="form-group">
                        <label className="form-label" htmlFor="phone">Phone Number</label>
                        <input
                            id="phone"
                            className="form-input"
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="e.g. 9876543210"
                            required
                            autoFocus
                        />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Checking...</> : 'Proceed to Face Auth →'}
                    </button>
                    <hr className="divider" />
                    <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                        Don&apos;t have an account?{' '}
                        <button type="button" className="link-btn" onClick={() => navigate('/register')}>
                            Register here
                        </button>
                    </p>
                </form>
            )}

            {/* Step 2 — Face verification via blink */}
            {step === 2 && (
                <div>
                    {verifying ? (
                        <div className="spinner-overlay">
                            <div className="spinner" />
                            <span>Analysing biometrics…</span>
                        </div>
                    ) : (
                        <BlinkDetector onBlinkDetected={handleBlinkDetected} disabled={!!verifiedUser} />
                    )}
                    <p className="instruction" style={{ marginTop: '0.75rem' }}>
                        Look at the camera and blink once naturally
                    </p>
                    {!verifying && (
                        <button className="btn-ghost" style={{ marginTop: '1rem', display: 'block', width: '100%', textAlign: 'center' }} onClick={reset}>
                            ← Back
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default Login;
