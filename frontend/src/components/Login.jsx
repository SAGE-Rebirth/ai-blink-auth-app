import React, { useState, useCallback, useRef } from 'react';
import BlinkDetector from './BlinkDetector';
import { checkUser, verifyUser, getErrorMessage, storeTokens } from '../services/api';
import { useAuth } from '../App';
import { useNavigate } from 'react-router-dom';

const Login = () => {
    const { handleLoginSuccess } = useAuth();
    const navigate = useNavigate();

    const [step, setStep] = useState(1);
    const [phone, setPhone] = useState('');
    const [userName, setUserName] = useState('');
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [alert, setAlert] = useState(null);
    const [verifiedUser, setVerifiedUser] = useState(null);

    const setError = (text) => setAlert({ type: 'error', text });
    const setSuccess = (text) => setAlert({ type: 'success', text });

    const handleNext = async (e) => {
        e.preventDefault();
        setAlert(null);
        const cleaned = phone.trim();
        if (!cleaned || cleaned.length < 7) { setError('Please enter a valid phone number.'); return; }
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

    const handleBlinkDetected = useCallback(async (imageSrc) => {
        if (verifying) return;
        setVerifying(true);
        setAlert(null);
        try {
            const data = await verifyUser({ phone: phone.trim(), image: imageSrc });
            if (data.verified) {
                storeTokens({ access_token: data.access_token, refresh_token: data.refresh_token, role: data.role });
                setVerifiedUser(data.user);
                setSuccess(`Welcome back, ${data.user.name}! ${data.role === 'admin' ? '🛡 Admin access granted.' : ''}`);
                setTimeout(() => handleLoginSuccess(data.role), 1200);
            } else {
                setError(data.message || 'Face verification failed. Please try blinking again.');
                setVerifying(false);
            }
        } catch (err) {
            setError(getErrorMessage(err));
            setVerifying(false);
        }
    }, [phone, verifying, handleLoginSuccess]);

    const reset = () => { setStep(1); setPhone(''); setUserName(''); setAlert(null); setLoading(false); setVerifying(false); setVerifiedUser(null); };

    return (
        <div className="bg-slate-800/60 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 shadow-2xl animate-slide-up">
            {/* Header */}
            <div className="text-center mb-6">
                <div className="w-16 h-16 bg-primary-500/20 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3 border border-primary-500/30">
                    👁
                </div>
                <h1 className="text-2xl font-bold text-white">Face Authentication</h1>
                <p className="text-slate-400 text-sm mt-1">
                    {step === 1 ? 'Enter your phone number to begin' : `Hi ${userName} — blink to verify`}
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

            {/* Step 1 */}
            {step === 1 && (
                <form onSubmit={handleNext} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-1.5">Phone Number</label>
                        <input
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="e.g. 9876543210"
                            autoFocus
                            className="w-full bg-slate-700/50 border border-slate-600/50 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500/50 transition-all"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-600 to-purple-600 hover:from-primary-500 hover:to-purple-500 text-white font-semibold transition-all duration-200 disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                        {loading ? <><span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> Checking...</> : 'Proceed to Face Auth →'}
                    </button>
                    <div className="relative my-2"><div className="border-t border-slate-700" /><span className="absolute left-1/2 -translate-x-1/2 -top-2.5 bg-slate-800 px-2 text-xs text-slate-500">or</span></div>
                    <p className="text-center text-sm text-slate-400">
                        Don&apos;t have an account?{' '}
                        <button type="button" onClick={() => navigate('/register')} className="text-primary-400 hover:text-primary-300 font-medium transition-colors">Register here</button>
                    </p>
                </form>
            )}

            {/* Step 2 */}
            {step === 2 && (
                <div>
                    {verifying ? (
                        <div className="flex flex-col items-center gap-3 py-8">
                            <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
                            <span className="text-slate-400 text-sm">Analysing biometrics…</span>
                        </div>
                    ) : (
                        <BlinkDetector onBlinkDetected={handleBlinkDetected} disabled={!!verifiedUser} />
                    )}
                    <p className="text-center text-slate-400 text-sm mt-3">Look at the camera and blink once naturally</p>
                    {!verifying && (
                        <button onClick={reset} className="mt-3 w-full text-center text-sm text-slate-500 hover:text-slate-300 transition-colors py-2">← Back</button>
                    )}
                </div>
            )}
        </div>
    );
};

export default Login;
