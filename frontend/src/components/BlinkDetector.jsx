import React, { useEffect, useRef, useState, useCallback } from 'react';
import Webcam from 'react-webcam';
import { FaceMesh } from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';
import { getAvgEAR } from '../utils/faceMesh';

const BLINK_THRESHOLD = 0.25;    // EAR below this = eye closing
const EYE_OPEN_THRESHOLD = 0.30; // EAR above this = eye open again
const MAX_BLINK_FRAMES = 12;     // Ignore if eyes stay closed too long (not a blink)
const BLINK_COOLDOWN_MS = 1200;  // Minimum ms between blink events (prevents double-fire)

const BlinkDetector = ({ onBlinkDetected, disabled = false }) => {
    const webcamRef = useRef(null);
    const canvasRef = useRef(null);
    const [status, setStatus] = useState('Initializing...');
    const [faceDetected, setFaceDetected] = useState(false);

    // Blink state in a ref (not state) to avoid stale closure issues
    const blinkStateRef = useRef({ isBlinking: false, framesInBlink: 0 });
    const lastBlinkTimeRef = useRef(0);
    // Store references for cleanup
    const faceMeshRef = useRef(null);
    const cameraRef = useRef(null);

    const onResults = useCallback(
        (results) => {
            if (disabled) return;

            const canvas = canvasRef.current;
            const videoEl = webcamRef.current?.video;

            if (!canvas || !videoEl) return;

            canvas.width = videoEl.videoWidth;
            canvas.height = videoEl.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (!results.multiFaceLandmarks?.length) {
                setFaceDetected(false);
                setStatus('No face detected');
                blinkStateRef.current = { isBlinking: false, framesInBlink: 0 };
                return;
            }

            setFaceDetected(true);
            const landmarks = results.multiFaceLandmarks[0];
            const ear = getAvgEAR(landmarks);

            // ── Draw EAR meter on canvas ───────────────────────────────
            const meterWidth = 140;
            const meterHeight = 8;
            const meterX = canvas.width / 2 - meterWidth / 2;
            const meterY = canvas.height - 24;
            const earNorm = Math.min(1, ear / 0.45); // Normalise to [0,1] range
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.roundRect(meterX - 4, meterY - 4, meterWidth + 8, meterHeight + 8, 4);
            ctx.fill();
            ctx.fillStyle = ear < BLINK_THRESHOLD ? '#f87171' : '#7c6af7';
            ctx.roundRect(meterX, meterY, meterWidth * earNorm, meterHeight, 4);
            ctx.fill();

            // ── Blink Detection Logic ──────────────────────────────────
            const blink = blinkStateRef.current;
            const now = Date.now();

            if (ear < BLINK_THRESHOLD) {
                if (!blink.isBlinking) {
                    blink.isBlinking = true;
                    blink.framesInBlink = 0;
                }
                blink.framesInBlink++;
                setStatus('Blinking...');
            } else if (ear > EYE_OPEN_THRESHOLD) {
                if (blink.isBlinking) {
                    // Valid blink: not too short (>0 frames) and not too long (< MAX)
                    if (blink.framesInBlink > 0 && blink.framesInBlink <= MAX_BLINK_FRAMES) {
                        // Cooldown guard: prevent double-firing
                        if (now - lastBlinkTimeRef.current > BLINK_COOLDOWN_MS) {
                            lastBlinkTimeRef.current = now;
                            setStatus('Blink Detected! ✓');
                            const imageSrc = webcamRef.current?.getScreenshot();
                            if (imageSrc) {
                                onBlinkDetected(imageSrc);
                            }
                        }
                    }
                    blink.isBlinking = false;
                    blink.framesInBlink = 0;
                } else {
                    setStatus('Ready — blink to capture');
                }
            }
        },
        [onBlinkDetected, disabled]
    );

    useEffect(() => {
        // Don't initialise if disabled
        if (disabled) return;

        const faceMesh = new FaceMesh({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
        });

        faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });

        faceMesh.onResults(onResults);
        faceMeshRef.current = faceMesh;

        let cam = null;
        // Wait a tick for the Webcam component to mount its video element
        const initTimeout = setTimeout(() => {
            const videoEl = webcamRef.current?.video;
            if (!videoEl) return;

            cam = new Camera(videoEl, {
                onFrame: async () => {
                    const v = webcamRef.current?.video;
                    if (v && faceMeshRef.current) {
                        await faceMeshRef.current.send({ image: v });
                    }
                },
                width: 640,
                height: 480,
            });
            cam.start();
            cameraRef.current = cam;
            setStatus('Ready — blink to capture');
        }, 500);

        // ── Cleanup: CRITICAL bug fix — stop camera & close model on unmount ──
        return () => {
            clearTimeout(initTimeout);
            if (cameraRef.current) {
                cameraRef.current.stop();
                cameraRef.current = null;
            }
            if (faceMeshRef.current) {
                faceMeshRef.current.close();
                faceMeshRef.current = null;
            }
        };
    }, [onResults, disabled]);

    const dotClass = faceDetected
        ? status.includes('Blink') ? 'blink-status-bar__dot blink-status-bar__dot--detected'
            : 'blink-status-bar__dot blink-status-bar__dot--ready'
        : 'blink-status-bar__dot blink-status-bar__dot--no-face';

    return (
        <div className="blink-detector">
            <div className="webcam-container">
                <Webcam
                    ref={webcamRef}
                    audio={false}
                    screenshotFormat="image/jpeg"
                    screenshotQuality={0.92}
                    videoConstraints={{ facingMode: 'user', width: 640, height: 480 }}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <canvas ref={canvasRef} />
            </div>
            <div className="blink-status-bar">
                <span className={dotClass} />
                <span>{status}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>EAR meter ↑</span>
            </div>
        </div>
    );
};

export default BlinkDetector;
