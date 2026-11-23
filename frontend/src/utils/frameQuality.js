/**
 * frameQuality.js — cheap per-frame quality scoring, run on a scratch canvas.
 *
 * The server applies its own gates on submit; these exist so the user finds out
 * *before* they burn a capture that the shot was blurry or backlit.
 */

// One scratch canvas reused for every measurement — allocating per frame would
// churn the GC at 30fps.
let scratch = null;
const SCRATCH_SIZE = 64;

const getScratch = () => {
    if (!scratch) {
        scratch = document.createElement('canvas');
        scratch.width = SCRATCH_SIZE;
        scratch.height = SCRATCH_SIZE;
    }
    return scratch;
};

/**
 * Sample the face region into a small grayscale buffer.
 * `box` is in normalised 0..1 coordinates.
 */
const sampleFace = (video, box) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const sx = Math.max(0, box.x1 * vw);
    const sy = Math.max(0, box.y1 * vh);
    const sw = Math.min(vw - sx, (box.x2 - box.x1) * vw);
    const sh = Math.min(vh - sy, (box.y2 - box.y1) * vh);
    if (sw < 8 || sh < 8) return null;

    const canvas = getScratch();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, SCRATCH_SIZE, SCRATCH_SIZE);

    let data;
    try {
        data = ctx.getImageData(0, 0, SCRATCH_SIZE, SCRATCH_SIZE).data;
    } catch {
        return null;   // tainted canvas — treat quality as unknown, not as failure
    }

    const gray = new Float32Array(SCRATCH_SIZE * SCRATCH_SIZE);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        gray[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    }
    return gray;
};

/** Variance of the Laplacian — the standard blur metric. Higher is sharper. */
const laplacianVariance = (gray, size) => {
    const values = [];
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const i = y * size + x;
            values.push(
                4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - size] - gray[i + size]
            );
        }
    }
    if (!values.length) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
};

/**
 * Score a frame's face region.
 * Returns { sharpness, brightness, contrast } or null when it cannot be read.
 */
export const scoreFrame = (video, box) => {
    const gray = sampleFace(video, box);
    if (!gray) return null;

    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const brightness = sum / gray.length;

    let varSum = 0;
    for (let i = 0; i < gray.length; i++) varSum += (gray[i] - brightness) ** 2;
    const contrast = Math.sqrt(varSum / gray.length);

    return {
        sharpness: laplacianVariance(gray, SCRATCH_SIZE),
        brightness,
        contrast,
    };
};

// Tuned against a 640×480 webcam feed. The sharpness figure is on a 0..1
// grayscale over a 64px face crop, so it is much smaller than the 0..255
// Laplacian variance the backend reports — they are not comparable numbers.
export const QUALITY = {
    MIN_SHARPNESS: 0.0016,
    MIN_BRIGHTNESS: 0.22,
    MAX_BRIGHTNESS: 0.88,
    MIN_CONTRAST: 0.08,
};

/** Human-readable reason a frame is not good enough, or null when it is fine. */
export const qualityProblem = (score) => {
    if (!score) return null;
    if (score.brightness < QUALITY.MIN_BRIGHTNESS) return 'Too dark — find better lighting';
    if (score.brightness > QUALITY.MAX_BRIGHTNESS) return 'Too bright — move away from the light';
    if (score.contrast < QUALITY.MIN_CONTRAST) return 'Not enough contrast — face a light source';
    if (score.sharpness < QUALITY.MIN_SHARPNESS) return 'Too blurry — hold still';
    return null;
};
