import React, { useState, useRef, useCallback } from 'react';
import Webcam from 'react-webcam';
import { registerUser } from '../services/api';
import BlinkDetector from './BlinkDetector';

const RegistrationForm = ({ onRegisterSuccess }) => {
    const [step, setStep] = useState(1); // 1: Details, 2: Face Capture
    const [formData, setFormData] = useState({
        name: '',
        phone: '',
        masked_id: '',
    });
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    const handleNext = (e) => {
        e.preventDefault();
        if (formData.name && formData.phone && formData.masked_id) {
            setStep(2);
        } else {
            setMessage('Please fill in all fields.');
        }
    };

    const handleBlinkDetected = useCallback((imageSrc) => {
        if (images.length < 3) {
            console.log(`[Registration] Captured image ${images.length + 1}/3`);
            setImages((prev) => {
                if (prev.length < 3) {
                    return [...prev, imageSrc];
                }
                return prev;
            });
        }
    }, [images]);

    const retake = () => {
        setImages([]);
    };

    const handleSubmit = async () => {
        setLoading(true);
        setMessage('Registering... This may take a moment to process face embeddings.');
        try {
            const payload = {
                ...formData,
                images: images
            };
            const response = await registerUser(payload);
            setMessage(`Success: ${response.message}`);
            setTimeout(() => {
                if (onRegisterSuccess) {
                    onRegisterSuccess();
                }
            }, 2000);
        } catch (error) {
            setMessage(`Error: ${error.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="registration-container">
            <h2>Identity Registration</h2>
            {message && <div className={`message ${message.startsWith('Success') ? 'success' : 'error'}`}>{message}</div>}

            {step === 1 && (
                <form onSubmit={handleNext} className="registration-form">
                    <div className="form-group">
                        <label>Full Name</label>
                        <input
                            type="text"
                            name="name"
                            value={formData.name}
                            onChange={handleInputChange}
                            required
                            placeholder="Ex: Abhinav Pavithran"
                        />
                    </div>
                    <div className="form-group">
                        <label>Phone Number</label>
                        <input
                            type="tel"
                            name="phone"
                            value={formData.phone}
                            onChange={handleInputChange}
                            required
                            placeholder="Ex: 9876543210"
                        />
                    </div>
                    <div className="form-group">
                        <label>Masked ID (Last 4 digits)</label>
                        <input
                            type="text"
                            name="masked_id"
                            value={formData.masked_id}
                            onChange={handleInputChange}
                            required
                            placeholder="Ex: xxxx-xxxx-4321"
                        />
                    </div>
                    <button type="submit" className="btn-primary">Next: Face Capture</button>
                </form>
            )}

            {step === 2 && (
                <div className="face-capture-section">
                    <div className="webcam-wrapper">
                        {images.length < 3 ? (
                            <BlinkDetector onBlinkDetected={handleBlinkDetected} />
                        ) : (
                            <div className="capture-complete">
                                <p>✓ 3 Images Captured</p>
                            </div>
                        )}
                    </div>

                    <div className="capture-controls">
                        <p className="capture-count">Captured: {images.length} / 3</p>
                        <p className="instruction-text" style={{ color: '#aaa', fontSize: '0.9rem', marginBottom: '1rem' }}>
                            Blink naturally to capture photo (hold still)
                        </p>

                        <div className="image-previews">
                            {images.map((img, idx) => (
                                <img key={idx} src={img} alt={`capture-${idx}`} className="preview-thumb" />
                            ))}
                        </div>

                        {images.length >= 3 && (
                            <div className="action-buttons">
                                <button onClick={retake} className="btn-secondary">Retake</button>
                                <button onClick={handleSubmit} className="btn-primary" disabled={loading}>
                                    {loading ? 'Registering...' : 'Complete Registration'}
                                </button>
                            </div>
                        )}

                        <button onClick={() => setStep(1)} className="btn-text">Back to Details</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RegistrationForm;
