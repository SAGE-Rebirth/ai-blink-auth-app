import { useCallback, useEffect, useRef, useState } from 'react';
import { FaceMesh } from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';
import { getAvgEAR, getPose, getFraming } from '../utils/faceMesh';
import { scoreFrame } from '../utils/frameQuality';

/**
 * useFaceTracker — owns one camera + FaceMesh session for the lifetime of the
 * screen and streams per-frame analysis to a callback.
 *
 * The previous code remounted the whole detector after every capture, which
 * tore down the camera and re-fetched the FaceMesh WASM bundle from the CDN
 * each time — a visible stall and a black flash between shots. The fix is to
 * keep `onFrame` in a ref: the effect then depends only on `enabled`, so a
 * caller re-rendering with a new closure never restarts the camera.
 *
 * States: 'requesting' → 'loading' → 'ready', or 'error'. Reports 'idle'
 * whenever the caller has the tracker disabled.
 */
export const useFaceTracker = ({ enabled = true, onFrame } = {}) => {
    const webcamRef = useRef(null);
    const canvasRef = useRef(null);
    const faceMeshRef = useRef(null);
    const cameraRef = useRef(null);
    const startedRef = useRef(false);

    const [state, setState] = useState('requesting');
    const [error, setError] = useState(null);
    // Bumping this remounts <Webcam>, which is what actually re-triggers
    // getUserMedia after the user fixes a permission or device problem.
    const [mountKey, setMountKey] = useState(0);

    // Kept in a ref so a changing callback never re-initialises the camera.
    const onFrameRef = useRef(onFrame);
    useEffect(() => { onFrameRef.current = onFrame; }, [onFrame]);

    const enabledRef = useRef(enabled);
    useEffect(() => { enabledRef.current = enabled; }, [enabled]);

    /** Grab a still from the live stream as a JPEG data URL. */
    const capture = useCallback(
        (quality = 0.92) => webcamRef.current?.getScreenshot({ quality }) ?? null,
        []
    );

    const handleResults = useCallback((results) => {
        if (!enabledRef.current) return;
        const video = webcamRef.current?.video;
        if (!video) return;

        const faces = results.multiFaceLandmarks ?? [];
        if (!faces.length) {
            onFrameRef.current?.({
                hasFace: false,
                faceCount: 0,
                timestamp: performance.now(),
                video,
            });
            return;
        }

        const landmarks = faces[0];
        const framing = getFraming(landmarks);

        onFrameRef.current?.({
            hasFace: true,
            faceCount: faces.length,
            landmarks,
            ear: getAvgEAR(landmarks),
            pose: getPose(landmarks),
            framing,
            quality: scoreFrame(video, framing.box),
            timestamp: performance.now(),
            video,
            canvas: canvasRef.current,
        });
    }, []);

    /**
     * Ask the camera to stop auto-correcting colour and exposure.
     *
     * The illumination liveness check works by measuring how the screen's
     * colour lands on the skin. A camera that "helpfully" white-balances the
     * cast away is removing exactly the signal we are trying to read — in
     * simulation, a camera correcting 80% of the cast takes a genuine response
     * from a margin of 1.000 down to -0.108, i.e. a false rejection.
     *
     * Support is patchy (Chrome on some platforms, rarely Safari or Firefox),
     * so every step is best-effort and failure is silent: the check still works
     * with auto white balance on, it simply has less headroom.
     */
    const relaxCameraAutoCorrection = useCallback(async (stream) => {
        const track = stream?.getVideoTracks?.()[0];
        if (!track?.getCapabilities) return;
        try {
            const caps = track.getCapabilities();
            const advanced = [];
            if (caps.whiteBalanceMode?.includes('manual')) {
                advanced.push({ whiteBalanceMode: 'manual' });
            }
            if (caps.exposureMode?.includes('manual')) {
                advanced.push({ exposureMode: 'manual' });
            }
            if (advanced.length) await track.applyConstraints({ advanced });
        } catch {
            // Unsupported or refused by the platform — not worth surfacing.
        }
    }, []);

    /** Called by react-webcam once the MediaStream is actually flowing. */
    const handleUserMedia = useCallback((stream) => {
        if (startedRef.current) return;
        const video = webcamRef.current?.video;
        if (!video || !faceMeshRef.current) return;

        startedRef.current = true;
        setState('loading');
        relaxCameraAutoCorrection(stream);

        const camera = new Camera(video, {
            onFrame: async () => {
                const v = webcamRef.current?.video;
                // readyState < 2 means there are no frames to send yet; pushing
                // one anyway makes MediaPipe throw on an empty texture.
                if (v && v.readyState >= 2 && faceMeshRef.current) {
                    try {
                        await faceMeshRef.current.send({ image: v });
                        setState((s) => (s === 'ready' ? s : 'ready'));
                    } catch {
                        // A frame dropped mid-teardown is not worth surfacing.
                    }
                }
            },
            width: 640,
            height: 480,
        });
        camera.start();
        cameraRef.current = camera;
    }, [relaxCameraAutoCorrection]);

    const handleUserMediaError = useCallback((err) => {
        const name = err?.name || String(err);
        const messages = {
            NotAllowedError:
                'Camera access was blocked. Allow camera permission for this site, then try again.',
            PermissionDeniedError:
                'Camera access was blocked. Allow camera permission for this site, then try again.',
            NotFoundError: 'No camera was found. Connect a webcam and try again.',
            DevicesNotFoundError: 'No camera was found. Connect a webcam and try again.',
            NotReadableError:
                'Your camera is in use by another app. Close Zoom, Teams or Photo Booth and try again.',
            TrackStartError:
                'Your camera is in use by another app. Close Zoom, Teams or Photo Booth and try again.',
            OverconstrainedError: 'Your camera does not support the required video settings.',
            SecurityError: 'Camera access needs a secure page (https:// or localhost).',
        };
        setError({
            name,
            message: messages[name] || `Could not start the camera (${name}).`,
        });
        setState('error');
    }, []);

    /** Re-request the camera after the user fixes a permission or device problem. */
    const retry = useCallback(() => {
        setError(null);
        setState('requesting');
        startedRef.current = false;
        setMountKey((k) => k + 1);
    }, []);

    // ── FaceMesh lifecycle — created once, torn down on unmount ───────────
    useEffect(() => {
        if (!enabled) return undefined;

        const faceMesh = new FaceMesh({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`,
        });
        faceMesh.setOptions({
            // 2 rather than 1: we need to *notice* a second face to refuse the
            // frame, which is impossible if the detector only ever returns one.
            maxNumFaces: 2,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });
        faceMesh.onResults(handleResults);
        faceMeshRef.current = faceMesh;

        return () => {
            if (cameraRef.current) {
                cameraRef.current.stop();
                cameraRef.current = null;
            }
            if (faceMeshRef.current) {
                faceMeshRef.current.close();
                faceMeshRef.current = null;
            }
            startedRef.current = false;
        };
    }, [enabled, handleResults, mountKey]);

    return {
        webcamRef,
        canvasRef,
        state: enabled ? state : 'idle',
        error,
        capture,
        retry,
        mountKey,
        webcamProps: {
            onUserMedia: handleUserMedia,
            onUserMediaError: handleUserMediaError,
        },
    };
};

export default useFaceTracker;
