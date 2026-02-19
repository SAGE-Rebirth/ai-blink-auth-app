import React, { useState, useCallback } from 'react';
import BlinkDetector from './BlinkDetector';
import api, { checkUser } from '../services/api';

const Login = ({ onLoginSuccess }) => {
    const [step, setStep] = useState(1); // 1: Phone Input, 2: Face Auth
    const [phone, setPhone] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [user, setUser] = useState(null);

    const handleNext = async (e) => {
        e.preventDefault();
        setMessage('');

        if (phone.length < 10) {
            setMessage("Please enter a valid phone number");
            return;
        }

        setLoading(true);
        try {
            // Validate user existence first
            await checkUser(phone);
            setLoading(false);
            setStep(2);
        } catch (error) {
            setLoading(false);
            setMessage("User not found. Please register first.");
        }
    };

    const handleBlinkDetected = useCallback(async (imageSrc) => {
        if (loading) return;

        setLoading(true);
        setMessage('Verifying identity...');

        try {
            const payload = {
                phone: phone,
                image: imageSrc
            };

            const response = await api.post('/auth/verify-face', payload);
            const data = response.data;

            if (data.verified) {
                setMessage(`Welcome back, ${data.user.name}!`);
                setUser(data.user);
                localStorage.setItem('token', data.access_token);
                setTimeout(() => {
                    if (onLoginSuccess) onLoginSuccess();
                }, 1000);
            } else {
                setMessage(data.message || 'Verification Failed.');
                setLoading(false);
            }

        } catch (error) {
            console.error(error);
            if (error.response) {
                setMessage(`Error: ${error.response.data.detail}`);
            } else {
                setMessage("Network error or server unavailable.");
            }
            setLoading(false);
        }
    }, [phone, loading, onLoginSuccess]);

    const reset = () => {
        setStep(1);
        setPhone('');
        setUser(null);
        setMessage('');
        setLoading(false);
    };

    if (user) {
        return (
            <div className="login-container">
                <div className="success-card">
                    <h2>Access Granted</h2>
                    <p className="welcome-text">Welcome, {user.name}</p>
                    <p className="masked-id">ID: {user.masked_id}</p>
                    <div className="token-status">✓ Session Active</div>
                    <button onClick={reset} className="btn-secondary">Logout</button>
                </div>
            </div>
        )
    }

    return (
        <div className="login-container">
            <h2>Face Authentication</h2>
            {message && <div className={`message ${message.includes('Welcome') ? 'success' : 'error'}`}>{message}</div>}

            {step === 1 && (
                <form onSubmit={handleNext} className="login-form">
                    <div className="form-group">
                        <label>Phone Number</label>
                        <input
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            required
                            placeholder="Enter registered phone"
                        />
                    </div>
                    <button type="submit" className="btn-primary" disabled={loading}>
                        {loading ? 'Checking...' : 'Proceed to Face Auth'}
                    </button>

                </form>
            )}

            {step === 2 && (
                <div className="face-auth-section">
                    {!loading ? (
                        <div className="webcam-wrapper">
                            <BlinkDetector onBlinkDetected={handleBlinkDetected} />
                        </div>
                    ) : (
                        <div className="processing-state">
                            <div className="spinner"></div>
                            <p>Analyzing biometrics...</p>
                        </div>
                    )}

                    <div className="auth-controls">
                        <p className="instruction-text">Blink naturally to authenticate</p>
                        {!loading && <button onClick={() => setStep(1)} className="btn-text">Back</button>}
                    </div>
                </div>
            )}
        </div>
    );
};

export default Login;
