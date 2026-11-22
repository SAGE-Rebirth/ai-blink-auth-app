/**
 * faceMesh.js — geometry derived from MediaPipe FaceMesh's 468 landmarks.
 *
 * All landmarks are normalised to 0..1 against the frame, so every ratio here
 * is resolution-independent.
 */

// Eye contours, ordered p1..p6 for the EAR formula.
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];

// Reference points used for pose and framing.
const NOSE_TIP = 1;
const FOREHEAD = 10;
const CHIN = 152;
const CHEEK_LEFT = 234;   // subject's right cheek as seen on screen
const CHEEK_RIGHT = 454;
const EYE_OUTER_LEFT = 33;
const EYE_OUTER_RIGHT = 263;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Eye Aspect Ratio: (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||).
 * Drops sharply when the lid closes, which is what makes it a blink signal.
 */
export const calculateEAR = (landmarks, eyeIndices) => {
    const [p1, p2, p3, p4, p5, p6] = eyeIndices.map((i) => landmarks[i]);
    const horizontal = dist(p1, p4);
    if (horizontal === 0) return 0;
    return (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
};

export const getAvgEAR = (landmarks) =>
    (calculateEAR(landmarks, LEFT_EYE) + calculateEAR(landmarks, RIGHT_EYE)) / 2;

/**
 * Head pose, as three unitless ratios rather than degrees — we only ever need
 * to compare against thresholds, and ratios avoid a fragile 3-D solve.
 *
 *   yaw   negative = turned to the subject's right, positive = to their left
 *   pitch negative = chin down, positive = chin up
 *   roll  head tilt, from the angle of the eye line
 */
export const getPose = (landmarks) => {
    const nose = landmarks[NOSE_TIP];
    const left = landmarks[CHEEK_LEFT];
    const right = landmarks[CHEEK_RIGHT];
    const forehead = landmarks[FOREHEAD];
    const chin = landmarks[CHIN];
    const eyeL = landmarks[EYE_OUTER_LEFT];
    const eyeR = landmarks[EYE_OUTER_RIGHT];

    // Yaw: as the head turns, the nose moves toward the nearer cheek, so the
    // two nose-to-cheek distances fall out of balance.
    const dLeft = dist(nose, left);
    const dRight = dist(nose, right);
    const yaw = (dLeft + dRight) === 0 ? 0 : (dLeft - dRight) / (dLeft + dRight);

    // Pitch: where the nose sits between brow and chin, re-centred on 0.
    const faceHeight = Math.abs(chin.y - forehead.y);
    const pitch = faceHeight === 0 ? 0 : 0.5 - (nose.y - forehead.y) / faceHeight;

    const roll = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);

    return { yaw, pitch, roll };
};

/**
 * Framing: how big the face is and how far it sits from the centre, both as
 * fractions of the frame.
 */
export const getFraming = (landmarks) => {
    const forehead = landmarks[FOREHEAD];
    const chin = landmarks[CHIN];
    const left = landmarks[CHEEK_LEFT];
    const right = landmarks[CHEEK_RIGHT];

    const heightRatio = Math.abs(chin.y - forehead.y);
    const widthRatio = Math.abs(right.x - left.x);
    const centerX = (left.x + right.x) / 2;
    const centerY = (forehead.y + chin.y) / 2;

    return {
        heightRatio,
        widthRatio,
        centerX,
        centerY,
        offsetFromCenter: Math.hypot(centerX - 0.5, centerY - 0.5),
        box: {
            x1: Math.min(left.x, right.x),
            y1: forehead.y,
            x2: Math.max(left.x, right.x),
            y2: chin.y,
        },
    };
};

export { LEFT_EYE, RIGHT_EYE };
