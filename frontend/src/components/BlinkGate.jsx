import React, { useCallback, useEffect, useRef, useState } from 'react';
import CameraStage from './CameraStage';
import useFaceTracker from '../hooks/useFaceTracker';
import { qualityProblem } from '../utils/frameQuality';
import { prepareCanvas, drawFaceBox, drawEarMeter } from '../utils/overlay';

/**
 * BlinkGate — captures the three-frame bundle the server needs to verify a
 * blink actually happened:
 *
 *     open_before  →  closed  →  open_after
 *
 * Why three frames
 * ----------------
 * The old flow sent a single still. The server had no way to tell a live face
 * from a photograph held up to the lens, because the blink check lived entirely
 * in this file — and anything in this file can be skipped by POSTing straight
 * to the API. The bundle lets the server re-derive liveness from the pixels: it
 * compares the eye region across the three frames against a control region, so
 * only a real blink passes. See backend/core/liveness.py.
 *
 * `open_before` is the subtle one: it has to be a frame from *before* the eyes
 * started closing, so a recent open-eyed still is kept refreshed in the
 * background and snapshotted the moment a blink begins. Capturing it after the
 * fact would mean the lids were already moving.
 *
 * This also fixes the old capture timing. The previous code screenshotted on
 * the rising edge of the blink, catching the face with its lids half open —
 * the worst possible frame to run recognition on. Identity is now measured on
 * the two fully-open frames.
 *
 * After the blink, the screen runs the server's randomised colour sequence and
 * captures a frame under each. That is the presentation-attack check: a phone
 * held up playing a video of the user passes every blink test, because the
 * frames really are fresh and the eyes really do close — but a display emits
 * its own light rather than reflecting ours, so it cannot respond to colours
 * the server picked seconds ago. See backend/core/pad.py.
 */

// Blink thresholds are derived from each user's own resting EAR rather than
// fixed. Measured across 250 real faces, open-eye EAR has a median of 0.29 but a
// 5th percentile of 0.12 — so a fixed "closed" cutoff of 0.21 would read a
// narrow-eyed user as permanently mid-blink, and they could never produce a
// clean open → closed → open cycle. The server applies the same relative test
// (see backend/core/liveness.py), so the two agree on what counts as a blink.
const CLOSED_FRACTION = 0.72;      // closed when EAR falls below 72% of baseline
const OPEN_FRACTION = 0.88;        // open again above 88% — the hysteresis band
const BASELINE_MIN = 0.08;         // never trust a baseline below this
const BASELINE_MAX = 0.55;
const BASELINE_SMOOTHING = 0.1;    // EMA weight for new open-eye samples
const PRE_FRAME_REFRESH_MS = 200;  // how often the standby open-eye frame is renewed
const PRE_FRAME_MAX_AGE_MS = 700;  // older than this and it is not a "before" frame
const POST_BLINK_DELAY_MS = 130;   // let the eye settle before the after-shot
const MIN_CLOSED_FRAMES = 1;
const MAX_CLOSED_FRAMES = 14;      // longer than this is a wink or a stare, not a blink
const COOLDOWN_MS = 1200;
const MIN_FACE_HEIGHT = 0.26;
const MAX_FACE_HEIGHT = 0.85;
const MAX_OFF_CENTER = 0.22;

/** Gate the frame before we are willing to treat a blink as meaningful. */
const readiness = (analysis) => {
    if (!analysis.hasFace) return { ok: false, message: 'No face detected — move into the frame', tone: 'warn' };
    if (analysis.faceCount > 1) {
        return { ok: false, message: 'More than one face in view — make sure you are alone', tone: 'bad' };
    }
    const { framing, quality } = analysis;
    if (framing.heightRatio < MIN_FACE_HEIGHT) {
        return { ok: false, message: 'Move closer to the camera', tone: 'warn' };
    }
    if (framing.heightRatio > MAX_FACE_HEIGHT) {
        return { ok: false, message: 'Move back a little', tone: 'warn' };
    }
    if (framing.offsetFromCenter > MAX_OFF_CENTER) {
        return { ok: false, message: 'Centre your face in the frame', tone: 'warn' };
    }
    const problem = qualityProblem(quality);
    if (problem) return { ok: false, message: problem, tone: 'warn' };
    return { ok: true, message: 'Ready — blink once, naturally', tone: 'good' };
};

const BlinkGate = ({
    onBlinkCaptured,
    busy = false,
    disabled = false,
    resetToken = 0,
    illumination = [],
    flashMs = 400,
}) => {
    const [status, setStatus] = useState('Starting camera…');
    const [tone, setTone] = useState('neutral');
    // The colour currently filling the screen during the light check, or null.
    const [flash, setFlash] = useState(null);

    const captureRef = useRef(null);
    // Running estimate of this user's open-eye EAR, seeded on the first good frames.
    const baselineRef = useRef(null);
    // The illumination run spans a couple of seconds; reading the callback from
    // a ref at call time keeps it current without re-creating the run function.
    const onCapturedRef = useRef(onBlinkCaptured);
    // Set below, once runIllumination exists; handleFrame starts the run.
    const runIlluminationRef = useRef(null);
    // Rolling standby frame: the most recent good open-eyed still.
    const preFrameRef = useRef(null);       // { image, t, ear }
    const blinkRef = useRef(null);          // in-progress blink, or null
    const lastBlinkAtRef = useRef(0);
    const pendingAfterRef = useRef(null);   // timer handle for the after-shot
    const emittedRef = useRef(false);

    const clearPending = useCallback(() => {
        if (pendingAfterRef.current) {
            clearTimeout(pendingAfterRef.current);
            pendingAfterRef.current = null;
        }
    }, []);

    const reset = useCallback(() => {
        clearPending();
        baselineRef.current = null;
        preFrameRef.current = null;
        blinkRef.current = null;
        emittedRef.current = false;
        lastBlinkAtRef.current = 0;
    }, [clearPending]);

    useEffect(() => { reset(); }, [resetToken, reset]);
    useEffect(() => clearPending, [clearPending]);

    const handleFrame = useCallback(
        (analysis) => {
            const inactive = busy || disabled || emittedRef.current;
            const gate = readiness(analysis);

            // Overlay first, so the user keeps seeing themselves while we are busy.
            const ctx = prepareCanvas(analysis.canvas, analysis.video);
            if (ctx && analysis.hasFace) {
                const mark = (baselineRef.current ?? 0.3) * CLOSED_FRACTION;
                const blinking = analysis.ear < mark;
                drawFaceBox(ctx, analysis.framing.box, blinking ? 'active' : (gate.ok ? 'good' : 'warn'));
                drawEarMeter(ctx, analysis.ear, mark);
            }

            if (inactive) return;

            if (!gate.ok) {
                setStatus(gate.message);
                setTone(gate.tone);
                blinkRef.current = null;
                return;
            }

            const now = analysis.timestamp;
            const ear = analysis.ear;

            // Until we have seen this user's eyes open, we cannot judge a blink.
            const baseline = baselineRef.current;
            if (baseline === null) {
                if (ear >= BASELINE_MIN && ear <= BASELINE_MAX) {
                    baselineRef.current = ear;
                }
                setStatus('Look at the camera…');
                setTone('neutral');
                return;
            }
            const closedThreshold = baseline * CLOSED_FRACTION;
            const openThreshold = baseline * OPEN_FRACTION;

            // ── Eyes open: keep the standby "before" frame fresh ──────────
            if (ear >= openThreshold) {
                if (blinkRef.current) {
                    // The lid has reopened — this is the end of a blink.
                    const blink = blinkRef.current;
                    blinkRef.current = null;

                    const usable =
                        blink.frames >= MIN_CLOSED_FRAMES &&
                        blink.frames <= MAX_CLOSED_FRAMES &&
                        blink.closedImage &&
                        blink.pre &&
                        now - blink.pre.t <= PRE_FRAME_MAX_AGE_MS;

                    if (!usable) {
                        setStatus('Blink not clear — look at the camera and blink once');
                        setTone('warn');
                        return;
                    }
                    if (now - lastBlinkAtRef.current < COOLDOWN_MS) return;
                    lastBlinkAtRef.current = now;

                    setStatus('Blink detected ✓');
                    setTone('good');

                    // Give the eye a moment to settle before the after-shot, so
                    // it is genuinely open rather than mid-reopen.
                    clearPending();
                    pendingAfterRef.current = setTimeout(() => {
                        pendingAfterRef.current = null;
                        const afterImage = captureRef.current?.();
                        if (!afterImage) {
                            setStatus('Could not capture — please blink again');
                            setTone('warn');
                            return;
                        }
                        emittedRef.current = true;
                        const t0 = blink.pre.t;
                        const blinkFrames = [
                            { phase: 'open_before', t_ms: 0, image: blink.pre.image, ear: blink.pre.ear },
                            { phase: 'closed', t_ms: Math.round(blink.closedAt - t0), image: blink.closedImage, ear: blink.minEar },
                            { phase: 'open_after', t_ms: Math.round(performance.now() - t0), image: afterImage, ear },
                        ];
                        runIlluminationRef.current(blinkFrames);
                    }, POST_BLINK_DELAY_MS);
                    return;
                }

                setStatus(gate.message);
                setTone(gate.tone);

                // Track the resting baseline slowly, so it follows a change of
                // posture or lighting without drifting during the blink itself.
                if (ear >= BASELINE_MIN && ear <= BASELINE_MAX) {
                    baselineRef.current = baseline + BASELINE_SMOOTHING * (ear - baseline);
                }

                const pre = preFrameRef.current;
                if (!pre || now - pre.t >= PRE_FRAME_REFRESH_MS) {
                    const image = captureRef.current?.();
                    if (image) preFrameRef.current = { image, t: now, ear };
                }
                return;
            }

            // ── Eyes closing / closed ────────────────────────────────────
            if (ear < closedThreshold) {
                if (!blinkRef.current) {
                    const pre = preFrameRef.current;
                    if (!pre || now - pre.t > PRE_FRAME_MAX_AGE_MS) {
                        // No usable "before" frame yet — let the standby frame
                        // build up rather than submitting a bad bundle.
                        setStatus('Hold still for a moment, then blink');
                        setTone('warn');
                        return;
                    }
                    blinkRef.current = {
                        pre,
                        frames: 0,
                        minEar: ear,
                        closedImage: null,
                        closedAt: now,
                    };
                }
                const blink = blinkRef.current;
                blink.frames += 1;
                // Keep the deepest point of the blink — the most closed frame
                // gives the strongest signal for the server's eye-region test.
                if (ear <= blink.minEar || !blink.closedImage) {
                    const image = captureRef.current?.();
                    if (image) {
                        blink.minEar = ear;
                        blink.closedImage = image;
                        blink.closedAt = now;
                    }
                }
                setStatus('Blinking…');
                setTone('active');
            }
            // Between the two thresholds: hysteresis band, deliberately ignored.
        },
        [busy, disabled, clearPending]
    );

    const tracker = useFaceTracker({ enabled: !disabled, onFrame: handleFrame });
    useEffect(() => { captureRef.current = tracker.capture; }, [tracker.capture]);
    useEffect(() => { onCapturedRef.current = onBlinkCaptured; }, [onBlinkCaptured]);

    /**
     * Fill the screen with each challenge colour in turn and capture a frame
     * under each, so the server can check the skin responded in the order it
     * asked for. A neutral frame goes first as the baseline.
     *
     * The screen is the light source here, which is what makes this work on any
     * device with no extra hardware — and what a phone replaying a video cannot
     * fake, because a display emits its own light instead of reflecting ours.
     */
    const runIllumination = useCallback(
        async (blinkFrames) => {
            if (!illumination.length) {
                onCapturedRef.current(blinkFrames);
                return;
            }
            const steps = [
                { phase: 'illum_base', hex: '#000000', label: 'Hold still' },
                ...illumination.map((c, i) => ({ phase: `illum_${i}`, hex: c.hex, label: 'Hold still' })),
            ];

            setStatus('Checking the light on your face — hold still');
            setTone('active');

            const out = [];
            const start = performance.now();
            try {
                for (const step of steps) {
                    setFlash(step);
                    // Let the panel actually paint and the sensor settle before
                    // the grab, then hold the colour for the rest of the interval.
                    await new Promise((r) => setTimeout(r, Math.round(flashMs * 0.6)));
                    const image = captureRef.current?.();
                    await new Promise((r) => setTimeout(r, Math.round(flashMs * 0.4)));
                    if (!image) {
                        setStatus('Could not complete the light check — please try again');
                        setTone('warn');
                        emittedRef.current = false;
                        return;
                    }
                    out.push({
                        phase: step.phase,
                        t_ms: Math.round(performance.now() - start),
                        image,
                        ear: null,
                    });
                }
            } finally {
                // The panel covers the whole viewport, so it must come down on
                // every path — a stuck colour would black out the page.
                setFlash(null);
            }
            onCapturedRef.current([...blinkFrames, ...out]);
        },
        [illumination, flashMs]
    );

    useEffect(() => { runIlluminationRef.current = runIllumination; }, [runIllumination]);

    return (
        <>
            <CameraStage
                tracker={tracker}
                status={busy ? 'Verifying…' : status}
                tone={busy ? 'active' : tone}
                hint="Eye-openness meter shown below your face"
                busy={busy}
                busyLabel="Checking your face…"
            />

            {/* Full-screen colour panel. This *is* the light source for the
                check, so it has to cover the viewport rather than sit inside
                the card. Held at 2.5 Hz — see PAD_FLASH_MS. */}
            {flash && (
                <div
                    className="illumination-flash"
                    style={{ background: flash.hex }}
                    role="status"
                    aria-live="polite"
                >
                    <span className="illumination-flash__label">{flash.label}</span>
                </div>
            )}
        </>
    );
};

export default BlinkGate;
