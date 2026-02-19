import React, { useEffect, useRef, useState, useCallback } from 'react';
import Webcam from 'react-webcam';
import { FaceMesh } from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';
import { getAvgEAR } from '../utils/faceMesh';

// EAR Thresholds
const BLINK_THRESHOLD = 0.25; // Loop closure
const EYE_OPEN_THRESHOLD = 0.30; // Return to open
const FRAMES_TO_VERIFY = 3; // Frames to confirm blink

const BlinkDetector = ({ onBlinkDetected }) => {
    const webcamRef = useRef(null);
    const canvasRef = useRef(null);
    const [blinkStatus, setBlinkStatus] = useState('Waiting for blink...');
    const [isFaceDetected, setIsFaceDetected] = useState(false);

    // Blink State
    const blinkState = useRef({
        isBlinking: false,
        blinkCount: 0,
        framesInBlink: 0,
    });

    const onResults = useCallback((results) => {
        if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
            setIsFaceDetected(false);
            setBlinkStatus('No face detected');
            return;
        }

        setIsFaceDetected(true);
        const landmarks = results.multiFaceLandmarks[0];
        const ear = getAvgEAR(landmarks);

        // Visual feedback on canvas (optional, simple dots for eyes)
        const videoWidth = webcamRef.current.video.videoWidth;
        const videoHeight = webcamRef.current.video.videoHeight;
        canvasRef.current.width = videoWidth;
        canvasRef.current.height = videoHeight;
        const ctx = canvasRef.current.getContext('2d');
        ctx.clearRect(0, 0, videoWidth, videoHeight);

        // Draw landmarks if needed (skipping for performance/cleanliness, maybe just bounding box later)

        // Blink Logic
        if (ear < BLINK_THRESHOLD) {
            if (!blinkState.current.isBlinking) {
                blinkState.current.isBlinking = true;
                blinkState.current.framesInBlink = 0;
            }
            blinkState.current.framesInBlink++;
        } else if (ear > EYE_OPEN_THRESHOLD) {
            if (blinkState.current.isBlinking && blinkState.current.framesInBlink <= 10) {
                // Valid blink duration (not eyes closed for too long)
                setBlinkStatus('Blink Detected!');
                blinkState.current.isBlinking = false;

                // Trigger generic capture
                const imageSrc = webcamRef.current.getScreenshot();
                if (imageSrc) {
                    onBlinkDetected(imageSrc);
                }
            } else {
                blinkState.current.isBlinking = false;
                setBlinkStatus('Ready');
            }
        }
    }, [onBlinkDetected]);

    useEffect(() => {
        const faceMesh = new FaceMesh({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
            },
        });

        faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });

        faceMesh.onResults(onResults);

        if (webcamRef.current && webcamRef.current.video) {
            const camera = new Camera(webcamRef.current.video, {
                onFrame: async () => {
                    if (webcamRef.current && webcamRef.current.video) {
                        await faceMesh.send({ image: webcamRef.current.video });
                    }
                },
                width: 640,
                height: 480,
            });
            camera.start();
        }
    }, [onResults]);

    return (
        <div className="blink-detector">
            <div className="video-container" style={{ position: 'relative' }}>
                <Webcam
                    ref={webcamRef}
                    audio={false}
                    screenshotFormat="image/jpeg"
                    videoConstraints={{ facingMode: "user", width: 640, height: 480 }}
                    style={{ width: '100%', borderRadius: '12px' }}
                />
                <canvas
                    ref={canvasRef}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                    }}
                />
            </div>
            <div className="status-indicator">
                <p>Status: <span style={{ color: isFaceDetected ? '#4caf50' : '#f44336' }}>
                    {blinkStatus}
                </span></p>
            </div>
        </div>
    );
};

export default BlinkDetector;
