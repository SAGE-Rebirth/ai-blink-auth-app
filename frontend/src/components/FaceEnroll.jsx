import React, { useCallback, useEffect, useRef, useState } from 'react';
import CameraStage from './CameraStage';
import useFaceTracker from '../hooks/useFaceTracker';
import { qualityProblem } from '../utils/frameQuality';
import { prepareCanvas, drawFaceBox, drawYawMeter, drawProgressRing } from '../utils/overlay';


/**
 * FaceEnroll — captures one enrolment pose at a time, under a live quality gate.
 *
 * What changed and why
 * --------------------
 * The old flow blinked for shot 1 and then fired a blind 3-second timer for
 * shots 2 and 3. It prompted "turn left" / "turn right" but never checked that
 * the head had moved, so three identical frontal frames were the normal
 * outcome — and because each shot remounted the detector, the camera restarted
 * between every one.
 *
 * Now the head pose is measured, and a shot is only taken once *every* gate
 * holds continuously for HOLD_MS: one face, framed, level, sharp, well lit,
 * eyes open, and pointing where the step asks. The user sees exactly which gate
 * is failing instead of a timer counting down over a bad frame.
 *
 * Capturing only with the eyes open also fixes a quiet bug in the old blink
 * capture: it screenshotted on the *rising* edge of the blink, so the enrolled
 * face was often caught mid-reopen with the lids half shut.
 */

const HOLD_MS = 700;           // how long every gate must hold before capturing
const CANDIDATE_EVERY_MS = 180; // sampling cadence while holding
const MIN_FACE_HEIGHT = 0.28;   // face must fill ≥28% of frame height
const MAX_FACE_HEIGHT = 0.80;
const MAX_OFF_CENTER = 0.20;
const MAX_ROLL_RAD = 0.28;      // ≈16° of head tilt
// Only a floor for "not caught mid-blink". Resting EAR varies widely by eye
// shape — across 250 real faces the 5th percentile is 0.12 — so a stricter
// value here would stall enrolment for narrow-eyed users.
const EYES_OPEN_EAR = 0.13;

/** Evaluate every gate for a frame; the first failure is what the user is told. */
const evaluate = (analysis, step) => {
    const checks = [];
    const add = (id, label, ok, message) => checks.push({ id, label, ok, message });

    if (!analysis.hasFace) {
        return {
            ready: false,
            message: 'No face detected — move into the frame',
            tone: 'warn',
            checks: [{ id: 'face', label: 'Face detected', ok: false }],
        };
    }
    if (analysis.faceCount > 1) {
        return {
            ready: false,
            message: 'More than one face in view — make sure you are alone',
            tone: 'bad',
            checks: [{ id: 'face', label: 'Only you in frame', ok: false }],
        };
    }

    const { framing, pose, quality, ear } = analysis;

    add('face', 'Only you in frame', true);

    const tooFar = framing.heightRatio < MIN_FACE_HEIGHT;
    const tooClose = framing.heightRatio > MAX_FACE_HEIGHT;
    add('distance', 'Good distance', !tooFar && !tooClose,
        tooFar ? 'Move closer to the camera' : 'Move back a little');

    add('centered', 'Centred', framing.offsetFromCenter <= MAX_OFF_CENTER,
        'Centre your face in the frame');

    add('level', 'Head level', Math.abs(pose.roll) <= MAX_ROLL_RAD, 'Straighten your head');

    add('eyes', 'Eyes open', ear >= EYES_OPEN_EAR, 'Keep your eyes open');

    const qProblem = qualityProblem(quality);
    add('quality', 'Lighting & focus', !qProblem, qProblem ?? '');

    const yawError = pose.yaw - step.yawTarget;
    const poseOk = Math.abs(yawError) <= step.yawTolerance;
    let poseMessage = step.label;
    if (!poseOk) {
        if (step.id === 'center') {
            poseMessage = 'Face the camera straight on';
        } else if (Math.abs(pose.yaw) < Math.abs(step.yawTarget)) {
            poseMessage = `Turn a little further to your ${step.yawTarget > 0 ? 'LEFT' : 'RIGHT'}`;
        } else {
            poseMessage = 'Turned too far — come back a little';
        }
    }
    add('pose', step.label, poseOk, poseMessage);

    const failed = checks.find((c) => !c.ok);
    return {
        ready: !failed,
        message: failed ? (failed.message || failed.label) : 'Hold still…',
        tone: failed ? 'warn' : 'good',
        checks,
    };
};

const FaceEnroll = ({ step, stepIndex, totalSteps, onCaptured, busy = false }) => {
    const [status, setStatus] = useState('Starting camera…');
    const [tone, setTone] = useState('neutral');
    const [checks, setChecks] = useState([]);

    // Hold/candidate bookkeeping lives in refs — it updates every frame and
    // must not drive a re-render.
    const holdStartRef = useRef(null);
    const lastCandidateRef = useRef(0);
    const bestRef = useRef(null);
    const capturedRef = useRef(false);
    // The frame handler needs to grab a still, but the tracker is created
    // below it — so the capture function is bridged through a ref.
    const captureRef = useRef(null);

    const reset = useCallback(() => {
        holdStartRef.current = null;
        lastCandidateRef.current = 0;
        bestRef.current = null;
        capturedRef.current = false;
    }, []);

    const handleFrame = useCallback(
        (analysis) => {
            if (capturedRef.current || busy) return;

            const verdict = evaluate(analysis, step);
            setStatus(verdict.message);
            setTone(verdict.tone);
            setChecks(verdict.checks);

            const now = analysis.timestamp;
            let progress = 0;

            if (verdict.ready) {
                if (holdStartRef.current === null) {
                    holdStartRef.current = now;
                    bestRef.current = null;
                    lastCandidateRef.current = 0;
                }
                progress = Math.min(1, (now - holdStartRef.current) / HOLD_MS);

                // Sample a few candidates across the hold and keep the sharpest
                // — the steadiest instant of a steady window.
                if (now - lastCandidateRef.current >= CANDIDATE_EVERY_MS) {
                    lastCandidateRef.current = now;
                    const image = captureRef.current?.();
                    const sharpness = analysis.quality?.sharpness ?? 0;
                    if (image && (!bestRef.current || sharpness > bestRef.current.sharpness)) {
                        bestRef.current = { image, sharpness };
                    }
                }

                if (progress >= 1 && bestRef.current) {
                    capturedRef.current = true;
                    setStatus('Captured ✓');
                    setTone('good');
                    onCaptured(bestRef.current.image);
                }
            } else {
                // Any gate dropping restarts the hold: a shot is only taken
                // from a window that stayed good the whole way through.
                holdStartRef.current = null;
                bestRef.current = null;
            }

            // ── Overlay ──────────────────────────────────────────────────
            const ctx = prepareCanvas(analysis.canvas, analysis.video);
            if (!ctx || !analysis.hasFace) return;
            drawFaceBox(ctx, analysis.framing.box, verdict.ready ? 'good' : 'warn');
            drawYawMeter(
                ctx, analysis.pose.yaw, step.yawTarget, step.yawTolerance,
                verdict.checks.find((c) => c.id === 'pose')?.ok ? 'good' : 'active'
            );
            if (progress > 0) drawProgressRing(ctx, progress, 'good');
        },
        [step, onCaptured, busy]
    );

    const tracker = useFaceTracker({ enabled: true, onFrame: handleFrame });

    useEffect(() => { captureRef.current = tracker.capture; }, [tracker.capture]);

    // A new step means a fresh hold — but the camera keeps running throughout,
    // which is the whole point of hoisting the tracker out of the step.
    useEffect(() => { reset(); }, [step.id, reset]);

    return (
        <div className="enroll">
            <div className="enroll-prompt">
                <span className="enroll-prompt__step">Step {stepIndex + 1} of {totalSteps}</span>
                <p className="enroll-prompt__label">{step.label}</p>
                <p className="enroll-prompt__detail">{step.detail}</p>
            </div>

            <CameraStage
                tracker={tracker}
                status={status}
                tone={tone}
                busy={busy}
                busyLabel="Uploading…"
            />

            <ul className="check-list" aria-label="Capture requirements">
                {checks.map((c) => (
                    <li key={c.id} className={`check-list__item ${c.ok ? 'is-ok' : 'is-pending'}`}>
                        <span aria-hidden="true">{c.ok ? '✓' : '○'}</span>
                        <span>{c.label}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default FaceEnroll;
