"""
core/pad.py — Presentation Attack Detection.

The gap this closes
-------------------
Blink liveness answers "did the eyes close". It does not answer "is there a real
face in front of the camera", and those come apart badly under replay: hold up a
phone playing a video of the user blinking and every earlier check passes. The
frames are genuinely fresh, the Eye Aspect Ratio genuinely drops, the geometry
is genuinely continuous. The single-use challenge stops a *recorded bundle*
being re-submitted; it does nothing about a recorded face being re-filmed.

So the server makes the client prove the face is physically present, by
illuminating it with light only the server could have chosen.

Active illumination challenge
-----------------------------
The challenge carries a short random colour sequence, e.g.

    magenta → green → blue

The client fills the screen with each colour in turn and captures one frame
under each. The server then measures how the skin responded:

    delta_i = skin_colour(frame_i) - skin_colour(baseline)

For a real face, `delta_i` points in roughly the direction of the emitted colour
— magenta light lifts red and blue, green light lifts green. Skin is diffuse, so
the response is broad and follows the source.

The decision is a **permutation test**, not a threshold on any one frame. We
build the similarity matrix between every measured response and every emitted
colour, then check that pairing them in the order they were actually emitted
beats every other possible pairing, by a margin. That formulation matters: skin
albedo is not neutral (skin reflects red far better than blue), and a fixed
per-channel threshold would drown in that bias. Comparing orderings cancels it,
because the bias applies to every candidate pairing alike.

What each attack does
---------------------
* **Screen / video replay** — a display *emits* light rather than reflecting it
  diffusely. Our flash adds only a specular glare on the glass, so the measured
  response is weak and uncorrelated with the sequence. This is the attack the
  method is built for, and it is the one that matters most, because it is also
  how a real-time deepfake reaches the camera.
* **Pre-recorded anything** — the sequence is generated per challenge and is
  unknown until issued, so a recording cannot respond in the right order. Odds
  of guessing an n-colour order are 1/n!.
* **Printed photo** — paper *does* reflect the flash, so illumination alone is
  weaker here. Print is caught by the blink requirement and by the screen/print
  frequency check below, which is why the layers are kept together.

Limits, stated plainly
----------------------
This raises the cost of an attack; it does not make one impossible. A determined
attacker with a high-quality mask, or one injecting frames into a compromised
browser rather than filming a screen, is outside what any purely software,
single-camera method can settle. Real assurance at that level needs either
hardware depth/IR or a certified PAD model evaluated under ISO/IEC 30107-3.
The thresholds here are starting points and must be validated against real
capture hardware — see tools/calibrate.py and `LIVENESS_DEBUG`.
"""
import logging
import secrets
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from core.config import settings

logger = logging.getLogger(__name__)

# Pure primaries only, and that restriction is load-bearing.
#
# Skin reflectance is *diagonal* — it scales each channel independently — so a
# pure primary keeps its direction exactly under any skin tone: red light off
# skin is still red, only dimmer. A secondary does not survive that. Magenta
# (1,0,1) reflected by skin with albedo (0.65, ., 0.35) comes back at
# (0.88, 0, 0.47), which is 28 degrees away from the magenta it was meant to be
# and only 45 degrees from plain blue.
#
# An earlier version of this palette also carried magenta, cyan and yellow. It
# had a real hole: because a secondary sits only 45 degrees (cos 0.707) from two
# primaries, an attacker responding to an entirely *different* colour set could
# still score highly — 12 of 120 such attempts were accepted. Measured, the
# primaries are mutually orthogonal (worst pairwise cos 0.000) and no wrong
# response passes. See tests/test_pad.py.
PALETTE: Dict[str, Tuple[float, float, float]] = {
    "red":   (1.0, 0.0, 0.0),
    "green": (0.0, 1.0, 0.0),
    "blue":  (0.0, 0.0, 1.0),
}

_UNIT = {name: np.asarray(rgb, dtype=np.float64) / np.linalg.norm(rgb)
         for name, rgb in PALETTE.items()}

ILLUMINATION_PHASE_PREFIX = "illum_"
# Captured under a neutral screen immediately before the colour sequence, so the
# comparison is against light conditions from the same moment rather than from
# before the blink.
BASELINE_PHASE = "illum_base"


def illumination_phases(length: int) -> list:
    """Every phase name a client must supply for a sequence of this length."""
    return [BASELINE_PHASE] + [f"{ILLUMINATION_PHASE_PREFIX}{i}" for i in range(length)]


def hex_colour(name: str) -> str:
    """Palette entry as a CSS hex string for the client to display."""
    r, g, b = PALETTE[name]
    return "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))


@dataclass
class PadResult:
    passed: bool
    reason: str = ""
    metrics: Dict[str, float] = field(default_factory=dict)


def illumination_phase(index: int) -> str:
    return f"{ILLUMINATION_PHASE_PREFIX}{index}"


def generate_sequence(length: Optional[int] = None) -> List[str]:
    """
    A random colour sequence for one challenge.

    With only three colours, repeats are allowed so the sequence can be longer
    than the palette — length 5 gives 3 x 2^4 = 48 possibilities. Consecutive
    repeats are excluded because two identical frames in a row produce no
    visible transition and tell us nothing new.

    `secrets` rather than `random`: predicting the sequence is exactly the
    attack this defends against.
    """
    length = max(1, length or settings.PAD_SEQUENCE_LENGTH)
    names = list(PALETTE)
    chosen: List[str] = []
    for _ in range(length):
        pool = [n for n in names if not chosen or n != chosen[-1]]
        chosen.append(pool[secrets.randbelow(len(pool))])
    return chosen


def _response_vector(skin: np.ndarray, baseline: np.ndarray) -> Optional[np.ndarray]:
    """
    How the skin moved under one flash, in RGB order, as a unit vector.

    Only the *direction* is kept. Magnitude depends on screen brightness, how
    close the user sits and their skin tone, none of which we can predict; the
    direction is what the emitted colour determines.
    """
    delta = (skin - baseline)[::-1]          # BGR sample → RGB, to match PALETTE
    norm = float(np.linalg.norm(delta))
    if norm < 1e-6:
        return None
    return delta / norm


def analyse_illumination(
    skin_by_phase: Dict[str, np.ndarray],
    baseline_skin: np.ndarray,
    sequence: Sequence[str],
) -> PadResult:
    """
    Verify the face responded to the emitted colour sequence, in order.

    `skin_by_phase` holds the median skin colour of each illuminated frame,
    keyed illum_0, illum_1, ... `baseline_skin` is the same measurement from an
    unlit frame.

    Every frame is judged on its own: the measured response must point closer to
    the colour we actually emitted than to either other primary, by a margin.
    All frames must pass. Because the primaries are orthogonal and skin
    reflectance is diagonal, a genuine response lands essentially exactly on its
    primary (cos 1.000 in simulation), while a response to any other colour
    lands on that other colour instead — so a wrong answer is not merely a
    weaker score, it classifies as a different colour.
    """
    if not sequence:
        return PadResult(True, "", {"pad_skipped": 1.0})

    for name in sequence:
        if name not in PALETTE:
            return PadResult(False, "Malformed liveness challenge. Please try again.")

    frame_scores: List[float] = []
    frame_margins: List[float] = []

    for i, name in enumerate(sequence):
        phase = illumination_phase(i)
        if phase not in skin_by_phase or skin_by_phase[phase] is None:
            return PadResult(
                False, "The lighting check did not complete. Hold still and try again."
            )
        response = _response_vector(skin_by_phase[phase], baseline_skin)
        if response is None:
            # No measurable change at all: the classic signature of a display,
            # which emits its own light instead of reflecting ours.
            return PadResult(
                False,
                "Your face did not respond to the screen light. Make sure you are looking at "
                "the screen, and that you are not holding up a photo or another device.",
                {"pad_response": 0.0},
            )
        similarity = {n: float(np.dot(response, _UNIT[n])) for n in PALETTE}
        correct = similarity[name]
        runner_up = max(v for n, v in similarity.items() if n != name)
        frame_scores.append(correct)
        frame_margins.append(correct - runner_up)

    worst_score = min(frame_scores)
    worst_margin = min(frame_margins)
    metrics = {
        "pad_score": round(float(np.mean(frame_scores)), 4),
        "pad_worst_frame": round(worst_score, 4),
        "pad_margin": round(worst_margin, 4),
        "pad_frames": len(frame_scores),
    }

    if worst_score < settings.PAD_MIN_SCORE:
        return PadResult(
            False,
            "Your face did not respond to the screen light as expected. Try again in a dimmer "
            "room, facing the screen.",
            metrics,
        )
    if worst_margin < settings.PAD_MIN_MARGIN:
        # The response was closer to a colour we did not emit — or too close to
        # call. Either way the client has not shown it knew the sequence.
        return PadResult(
            False,
            "The lighting check was inconclusive. Move somewhere dimmer, face the screen and "
            "try again.",
            metrics,
        )
    return PadResult(True, "", metrics)


# ---------------------------------------------------------------------------
# Passive check: is this frame a photograph of a screen?
# ---------------------------------------------------------------------------
def screen_artifact_score(img_bgr: np.ndarray, box: Tuple[int, int, int, int]) -> float:
    """
    Energy in the periodic high-frequency band of the face region, 0..1.

    Photographing a display beats the camera's sensor grid against the screen's
    pixel grid and produces moiré: regular, narrow-band structure that skin does
    not have. We take the 2-D FFT of the face crop and measure how much of the
    high-frequency energy sits in isolated peaks rather than spread smoothly.

    This is a corroborating signal, not a verdict on its own — print, high-DPI
    displays and heavy JPEG all move it. It is returned as a score and logged so
    it can be calibrated against real attempts before anything is gated on it.
    """
    x1, y1, x2, y2 = box
    crop = img_bgr[max(0, y1):y2, max(0, x1):x2]
    if crop.size == 0 or min(crop.shape[:2]) < 32:
        return 0.0

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float64)
    gray = cv2.resize(gray, (128, 128), interpolation=cv2.INTER_AREA)
    gray -= gray.mean()
    gray *= np.outer(np.hanning(128), np.hanning(128))   # reduce edge ringing

    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(gray)))
    cy, cx = 64, 64
    yy, xx = np.mgrid[0:128, 0:128]
    radius = np.hypot(yy - cy, xx - cx)

    high = spectrum[(radius > 24) & (radius < 60)]
    if high.size == 0:
        return 0.0
    total = float(high.sum())
    if total <= 0:
        return 0.0

    # Peakiness: how much of the band's energy is concentrated in its top 1%.
    top = np.sort(high)[-max(1, high.size // 100):]
    return float(min(1.0, (top.sum() / total) * 10.0))
