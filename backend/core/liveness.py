"""
core/liveness.py — server-side blink verification, from mesh geometry.

Why this exists
---------------
Blink detection in the browser proves nothing to the server: anyone can POST a
still photo straight to /auth/verify-face and skip the camera entirely. The
client-side EAR check is a *usability* feature (it tells the user when to hold
still); it is not a security control.

So the server re-derives the blink itself, from a short bundle captured around
one blink:

    open_before  →  closed  →  open_after

How it decides
--------------
Eye Aspect Ratio, measured on the server's own 478-point mesh (core/mesh.py):

    EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)

The test is deliberately **relative, not absolute**. Resting EAR varies a lot
between people — eye shape, epicanthic folds, glasses, how wide someone
naturally holds their eyes — so a fixed "closed" cutoff either locks out
narrow-eyed users or waves through a lazy squint. Instead we require the eye to
close by a *proportion of that person's own open baseline*, measured in the same
bundle seconds earlier:

    baseline = mean(EAR(open_before), EAR(open_after))
    drop     = (baseline − EAR(closed)) / baseline

A genuine blink drops 40-80%. A still photo repeated three times drops ~0%.

An earlier version of this file compared *pixels* in the eye region against a
nose control region. It was replaced because it was too fragile: the patches
were contrast-normalised, and the nose bridge is low-texture, so dividing by its
small standard deviation amplified sensor noise into a large control delta.
Ordinary head drift in a normally-lit room then rivalled the eye signal and the
ratio collapsed, rejecting genuine blinks with "the whole frame changed". EAR is
a ratio of distances within the eye, so lighting, exposure and camera distance
all cancel out.

What it rejects
---------------
    still photo sent 3×       no EAR drop
    3 unrelated photos        geometry continuity (size/position) fails
    lighting manipulation     does not move EAR at all
    a slow squint / droop     drop or timing outside the human blink envelope
    someone else in shot      more than one face in any frame
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, Tuple

import numpy as np

from core.config import settings
from core.mesh import Mesh

logger = logging.getLogger(__name__)

PHASE_OPEN_BEFORE = "open_before"
PHASE_CLOSED = "closed"
PHASE_OPEN_AFTER = "open_after"
REQUIRED_PHASES = (PHASE_OPEN_BEFORE, PHASE_CLOSED, PHASE_OPEN_AFTER)


@dataclass
class LivenessResult:
    passed: bool
    reason: str = ""
    metrics: Dict[str, float] = field(default_factory=dict)


def _geometry_consistent(meshes: Dict[str, Mesh]) -> Tuple[bool, str, Dict[str, float]]:
    """
    The three frames must plausibly come from one continuous capture: same face,
    roughly the same size, roughly the same place. This is what stops three
    unrelated photographs being stitched together into a "blink".

    Tolerances are loose on purpose — a real person breathes and sways, and this
    check exists to catch a swapped photo, not to demand that someone sit
    perfectly rigid.
    """
    widths = [m.width for m in meshes.values()]
    centers = [m.center for m in meshes.values()]
    reference = float(np.mean(widths))
    if reference <= 0:
        return False, "Could not measure the face in the captured frames.", {}

    size_spread = (max(widths) - min(widths)) / reference
    max_shift = max(
        float(np.hypot(c[0] - centers[0][0], c[1] - centers[0][1])) for c in centers
    ) / reference

    metrics = {"size_spread": round(size_spread, 4), "center_shift": round(max_shift, 4)}

    if size_spread > settings.LIVENESS_MAX_SIZE_SPREAD:
        return False, "You moved toward or away from the camera mid-blink. Hold still and blink again.", metrics
    if max_shift > settings.LIVENESS_MAX_CENTER_SHIFT:
        return False, "You moved out of position mid-blink. Hold still and blink again.", metrics
    return True, "", metrics


def analyse_blink(
    meshes: Dict[str, Mesh],
    timings_ms: Dict[str, float],
) -> LivenessResult:
    """
    Decide whether a three-frame bundle contains a genuine blink.

    `meshes` and `timings_ms` are keyed by phase and must cover REQUIRED_PHASES.
    """
    missing = [p for p in REQUIRED_PHASES if p not in meshes or meshes[p] is None]
    if missing:
        return LivenessResult(
            False, "Your face was not clearly visible in every frame. Please blink again."
        )

    # ── 1. Exactly one face, in every frame ───────────────────────────────
    for mesh in meshes.values():
        if mesh.n_faces > 1:
            return LivenessResult(
                False, "More than one face is visible. Make sure you are alone in the frame."
            )

    # ── 2. Humanly plausible timing ───────────────────────────────────────
    t_before = timings_ms.get(PHASE_OPEN_BEFORE, 0.0)
    t_closed = timings_ms.get(PHASE_CLOSED, 0.0)
    t_after = timings_ms.get(PHASE_OPEN_AFTER, 0.0)
    if not (t_before < t_closed < t_after):
        return LivenessResult(False, "The captured frames are out of order. Please blink again.")
    duration = t_after - t_before
    if duration < settings.LIVENESS_MIN_BLINK_MS or duration > settings.LIVENESS_MAX_BLINK_MS:
        return LivenessResult(
            False, "That did not look like a natural blink. Look at the camera and blink once."
        )

    # ── 3. One continuous capture ─────────────────────────────────────────
    ok, reason, geo = _geometry_consistent(meshes)
    if not ok:
        return LivenessResult(False, reason, geo)

    # ── 4. The eyes actually closed ───────────────────────────────────────
    ear_before = meshes[PHASE_OPEN_BEFORE].ear
    ear_closed = meshes[PHASE_CLOSED].ear
    ear_after = meshes[PHASE_OPEN_AFTER].ear
    baseline = (ear_before + ear_after) / 2.0

    metrics = {
        **geo,
        "ear_before": round(ear_before, 4),
        "ear_closed": round(ear_closed, 4),
        "ear_after": round(ear_after, 4),
        "ear_baseline": round(baseline, 4),
        "blink_ms": round(duration, 1),
    }

    if baseline < settings.LIVENESS_MIN_OPEN_EAR:
        metrics["ear_drop"] = 0.0
        return LivenessResult(
            False,
            "Your eyes did not look open in the captured frames. Look straight at the camera, "
            "then blink once.",
            metrics,
        )

    drop = (baseline - ear_closed) / baseline
    metrics["ear_drop"] = round(drop, 4)

    if drop < settings.LIVENESS_MIN_EAR_DROP:
        return LivenessResult(
            False,
            "No blink was detected. Look straight at the camera and blink once, deliberately.",
            metrics,
        )

    # An absolute ceiling as well as the relative drop: someone with very wide
    # eyes could clear the percentage while still not really shutting them.
    if ear_closed > settings.LIVENESS_MAX_CLOSED_EAR:
        return LivenessResult(
            False, "Your eyes did not close fully. Blink once, a little more deliberately.", metrics
        )

    return LivenessResult(True, "", metrics)


def describe_thresholds() -> Dict[str, float]:
    """Current liveness thresholds — surfaced on /health to make tuning visible."""
    return {
        "min_open_ear": settings.LIVENESS_MIN_OPEN_EAR,
        "min_ear_drop": settings.LIVENESS_MIN_EAR_DROP,
        "max_closed_ear": settings.LIVENESS_MAX_CLOSED_EAR,
        "min_blink_ms": settings.LIVENESS_MIN_BLINK_MS,
        "max_blink_ms": settings.LIVENESS_MAX_BLINK_MS,
        "max_size_spread": settings.LIVENESS_MAX_SIZE_SPREAD,
        "max_center_shift": settings.LIVENESS_MAX_CENTER_SHIFT,
    }
