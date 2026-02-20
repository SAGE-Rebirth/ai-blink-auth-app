import React, { useEffect, useRef, useState, useCallback } from 'react';
import Webcam from 'react-webcam';
import { FaceMesh } from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';
import { getAvgEAR } from '../utils/faceMesh';

const BLINK_THRESHOLD = 0.25;
const EYE_OPEN_THRESHOLD = 0.30;
const MAX_BLINK_FRAMES = 12;
const BLINK_COOLDOWN_MS = 1200;

/**
 * BlinkDetector
 *
 * Props:
 *  onBlinkDetected(imageSrc)  — called when a capture is ready
 *  disabled                   — pause all processing
 *  autoCapture                — if true, auto-capture after countdown (no blink needed)
 *  countdownSecs              — seconds before auto-capture fires (default 3)
 */
const BlinkDetector = ({
    onBlinkDetected,
    disabled = false,
    autoCapture = false,
    countdownSecs = 3,
}) => {
    const webcamRef = useRef(null);
    const canvasRef = useRef(null);
    const [status, setStatus] = useState('Initializing...');
    const [faceDetected, setFaceDetected] = useState(false);
    const [countdown, setCountdown] = useState(null); // null | number

    // Blink state in refs to avoid stale closures
    const blinkStateRef = useRef({ isBlinking: false, framesInBlink: 0 });
    const lastBlinkTimeRef = useRef(0);
    const faceMeshRef = useRef(null);
    const cameraRef = useRef(null);

    // ── Auto-capture countdown ─────────────────────────────────────────────
    // Starts once the face is detected and autoCapture is true.
    const countdownTimerRef = useRef(null);
    const countdownFiredRef = useRef(false); // prevent double-fire

    const startCountdown = useCallback(() => {
        if (countdownTimerRef.current || countdownFiredRef.current) return;
        let remaining = countdownSecs;
        setCountdown(remaining);

        countdownTimerRef.current = setInterval(() => {
            remaining -= 1;
            setCountdown(remaining);
            if (remaining <= 0) {
                clearInterval(countdownTimerRef.current);
                countdownTimerRef.current = null;
                if (!countdownFiredRef.current) {
                    countdownFiredRef.current = true;
                    setStatus('Captured! ✓');
                    setCountdown(null);
                    const imageSrc = webcamRef.current?.getScreenshot();
                    if (imageSrc) onBlinkDetected(imageSrc);
                }
            }
        }, 1000);
    }, [countdownSecs, onBlinkDetected]);

    // Cancel countdown on unmount / disabled
    useEffect(() => {
        return () => {
            if (countdownTimerRef.current) {
                clearInterval(countdownTimerRef.current);
                countdownTimerRef.current = null;
            }
        };
    }, []);

    // ── FaceMesh result handler ────────────────────────────────────────────
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
                setStatus(autoCapture ? 'Position your face in the frame' : 'No face detected');
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
            const earNorm = Math.min(1, ear / 0.45);
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.roundRect(meterX - 4, meterY - 4, meterWidth + 8, meterHeight + 8, 4);
            ctx.fill();
            ctx.fillStyle = ear < BLINK_THRESHOLD ? '#f87171' : '#7c6af7';
            ctx.roundRect(meterX, meterY, meterWidth * earNorm, meterHeight, 4);
            ctx.fill();

            // ── Auto-capture mode: start countdown once face found ─────
            if (autoCapture) {
                startCountdown();
                return;
            }

            // ── Blink detection mode ───────────────────────────────────
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
                    if (blink.framesInBlink > 0 && blink.framesInBlink <= MAX_BLINK_FRAMES) {
                        if (now - lastBlinkTimeRef.current > BLINK_COOLDOWN_MS) {
                            lastBlinkTimeRef.current = now;
                            setStatus('Blink Detected! ✓');
                            const imageSrc = webcamRef.current?.getScreenshot();
                            if (imageSrc) onBlinkDetected(imageSrc);
                        }
                    }
                    blink.isBlinking = false;
                    blink.framesInBlink = 0;
                } else {
                    setStatus('Ready — blink to capture');
                }
            }
        },
        [onBlinkDetected, disabled, autoCapture, startCountdown]
    );

    // ── Camera + FaceMesh init ─────────────────────────────────────────────
    useEffect(() => {
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
            setStatus(autoCapture ? 'Position your face in the frame' : 'Ready — blink to capture');
        }, 500);

        return () => {
            clearTimeout(initTimeout);
            if (cameraRef.current) { cameraRef.current.stop(); cameraRef.current = null; }
            if (faceMeshRef.current) { faceMeshRef.current.close(); faceMeshRef.current = null; }
            if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
        };
    }, [onResults, disabled, autoCapture]);

    const dotClass = faceDetected
        ? status.includes('Captured') || status.includes('Blink Detected')
            ? 'blink-status-bar__dot blink-status-bar__dot--detected'
            : 'blink-status-bar__dot blink-status-bar__dot--ready'
        : 'blink-status-bar__dot blink-status-bar__dot--no-face';

    return (
        <div className="blink-detector">
            <div className="webcam-container" style={{ position: 'relative' }}>
                <Webcam
                    ref={webcamRef}
                    audio={false}
                    screenshotFormat="image/jpeg"
                    screenshotQuality={0.92}
                    videoConstraints={{ facingMode: 'user', width: 640, height: 480 }}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <canvas ref={canvasRef} />

                {/* ── Countdown ring overlay ─────────────────────────── */}
                {autoCapture && countdown !== null && (
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                    }}>
                        <div style={{
                            width: 80,
                            height: 80,
                            borderRadius: '50%',
                            background: 'rgba(124,106,247,0.85)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '2.2rem',
                            fontWeight: 700,
                            color: '#fff',
                            boxShadow: '0 0 24px rgba(124,106,247,0.6)',
                            animation: 'pulse 1s infinite',
                        }}>
                            {countdown}
                        </div>
                    </div>
                )}
            </div>

            <div className="blink-status-bar">
                <span className={dotClass} />
                <span>{autoCapture && countdown !== null ? `Auto-capturing in ${countdown}s…` : status}</span>
                {!autoCapture && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>EAR meter ↑</span>}
            </div>
        </div>
    );
};

export default BlinkDetector;
