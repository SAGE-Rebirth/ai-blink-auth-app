/**
 * overlay.js — canvas drawing for the camera stage.
 *
 * The canvas sits on top of the mirrored <video> and is flipped back by CSS, so
 * everything here is drawn in the video's own (unmirrored) coordinate space.
 */

const TONE = {
    neutral: '#94a3b8',
    active: '#7c6af7',
    good: '#34d399',
    warn: '#f59e0b',
    bad: '#f87171',
};

export const toneColor = (tone) => TONE[tone] ?? TONE.neutral;

/** Resize the canvas to match the video, and clear it. */
export const prepareCanvas = (canvas, video) => {
    if (!canvas || !video?.videoWidth) return null;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return ctx;
};

/** A rounded reticle around the face, with corner ticks. */
export const drawFaceBox = (ctx, box, tone = 'active') => {
    const { width: W, height: H } = ctx.canvas;
    const padX = (box.x2 - box.x1) * 0.20;
    const padY = (box.y2 - box.y1) * 0.15;

    const x = Math.max(0, (box.x1 - padX) * W);
    const y = Math.max(0, (box.y1 - padY) * H);
    const w = Math.min(W, (box.x2 + padX) * W) - x;
    const h = Math.min(H, (box.y2 + padY) * H) - y;

    const color = toneColor(tone);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(x, y, w, h);

    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    const tick = Math.min(w, h) * 0.14;
    [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
    ].forEach(([cx, cy, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(cx + sx * tick, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * tick);
        ctx.stroke();
    });
    ctx.restore();
};

/**
 * Horizontal yaw indicator: a track with the target zone marked and a dot for
 * where the head currently points. Turns guesswork into a target to hit.
 */
export const drawYawMeter = (ctx, yaw, target, tolerance, tone = 'active') => {
    const { width: W, height: H } = ctx.canvas;
    const trackW = W * 0.5;
    const x = (W - trackW) / 2;
    const y = H - 34;
    const toX = (v) => x + ((Math.max(-0.5, Math.min(0.5, v)) + 0.5) / 1) * trackW;

    ctx.save();
    ctx.fillStyle = 'rgba(15,23,42,0.6)';
    ctx.beginPath();
    ctx.roundRect(x - 8, y - 8, trackW + 16, 22, 11);
    ctx.fill();

    ctx.fillStyle = 'rgba(148,163,184,0.35)';
    ctx.beginPath();
    ctx.roundRect(x, y, trackW, 6, 3);
    ctx.fill();

    // Target zone
    ctx.fillStyle = 'rgba(124,106,247,0.45)';
    const zx1 = toX(target - tolerance);
    const zx2 = toX(target + tolerance);
    ctx.beginPath();
    ctx.roundRect(zx1, y - 2, Math.max(4, zx2 - zx1), 10, 5);
    ctx.fill();

    // Current position
    ctx.fillStyle = toneColor(tone);
    ctx.beginPath();
    ctx.arc(toX(yaw), y + 3, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
};

/** Eye-openness meter — shows the blink actually registering. */
export const drawEarMeter = (ctx, ear, threshold) => {
    const { width: W, height: H } = ctx.canvas;
    const meterW = 140;
    const meterH = 8;
    const x = W / 2 - meterW / 2;
    const y = H - 24;
    const filled = Math.max(0, Math.min(1, ear / 0.45));

    ctx.save();
    ctx.fillStyle = 'rgba(15,23,42,0.55)';
    ctx.beginPath();
    ctx.roundRect(x - 5, y - 5, meterW + 10, meterH + 10, 6);
    ctx.fill();

    ctx.fillStyle = ear < threshold ? toneColor('bad') : toneColor('active');
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(2, meterW * filled), meterH, 4);
    ctx.fill();

    // Threshold tick, so "how far must my eyes close" is visible.
    ctx.strokeStyle = 'rgba(248,250,252,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const tx = x + meterW * (threshold / 0.45);
    ctx.moveTo(tx, y - 3);
    ctx.lineTo(tx, y + meterH + 3);
    ctx.stroke();
    ctx.restore();
};

/** A ring that sweeps clockwise as a hold-still timer runs down. */
export const drawProgressRing = (ctx, progress, tone = 'active') => {
    const { width: W, height: H } = ctx.canvas;
    const r = Math.min(W, H) * 0.16;
    const cx = W / 2;
    const cy = H / 2;

    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(15,23,42,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = toneColor(tone);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, progress)));
    ctx.stroke();
    ctx.restore();
};
