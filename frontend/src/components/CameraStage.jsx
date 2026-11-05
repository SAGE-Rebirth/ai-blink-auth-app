import React from 'react';
import Webcam from 'react-webcam';

/**
 * CameraStage — the shared camera surface: live video, the overlay canvas, a
 * status line, and recoverable error states.
 *
 * It is purely presentational. The caller owns the tracker (see
 * useFaceTracker) and passes it straight through, which is what lets one camera
 * session span an entire multi-capture flow.
 */

const VIDEO_CONSTRAINTS = { facingMode: 'user', width: 640, height: 480 };

const TONE_CLASS = {
    neutral: 'stage-status__dot--neutral',
    active: 'stage-status__dot--active',
    good: 'stage-status__dot--good',
    warn: 'stage-status__dot--warn',
    bad: 'stage-status__dot--bad',
};

const CameraStage = ({
    tracker,
    status = '',
    tone = 'neutral',
    hint = null,
    busy = false,
    busyLabel = 'Working…',
    children,
}) => {
    const { webcamRef, canvasRef, state, error, retry, mountKey, webcamProps } = tracker;

    if (state === 'error') {
        return (
            <div className="stage stage--error" role="alert">
                <div className="stage-error">
                    <span className="stage-error__icon" aria-hidden="true">📷</span>
                    <p className="stage-error__title">Camera unavailable</p>
                    <p className="stage-error__message">{error?.message}</p>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
                        Try again
                    </button>
                </div>
            </div>
        );
    }

    const starting = state === 'requesting' || state === 'loading';

    return (
        <div className="stage">
            <div className="webcam-container">
                <Webcam
                    key={mountKey}
                    ref={webcamRef}
                    audio={false}
                    mirrored
                    screenshotFormat="image/jpeg"
                    screenshotQuality={0.92}
                    videoConstraints={VIDEO_CONSTRAINTS}
                    {...webcamProps}
                />
                {/* Flipped back, because the video above is mirrored for the
                    user's benefit but landmarks arrive unmirrored. */}
                <canvas ref={canvasRef} style={{ transform: 'scaleX(-1)' }} />

                {starting && (
                    <div className="stage-veil">
                        <span className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
                        <span>
                            {state === 'requesting' ? 'Waiting for camera permission…' : 'Starting camera…'}
                        </span>
                    </div>
                )}

                {busy && (
                    <div className="stage-veil stage-veil--busy">
                        <span className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
                        <span>{busyLabel}</span>
                    </div>
                )}

                {children}
            </div>

            {/* Announced to screen readers, since the whole flow is visual. */}
            <div className="stage-status" role="status" aria-live="polite">
                <span className={`stage-status__dot ${TONE_CLASS[tone] ?? TONE_CLASS.neutral}`} />
                <span className="stage-status__text">{status}</span>
                {hint && <span className="stage-status__hint">{hint}</span>}
            </div>
        </div>
    );
};

export default CameraStage;
