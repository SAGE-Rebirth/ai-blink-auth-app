"""
tools/calibrate.py — measure this pipeline on a labelled face benchmark.

Every threshold in core/config.py that involves a face should come from a
measurement, not a guess. This script produces those measurements against LFW
(Labeled Faces in the Wild), which scikit-learn downloads on first run.

    ./venv/bin/pip install scikit-learn
    ./venv/bin/python tools/calibrate.py --pairs 300 --identities 40

It reports three things:

  1. **Threshold sweep** — false accept and false reject rates for the configured match threshold,
     using 3-image centroid templates, which is how enrolment actually stores a user.

  2. **Aggregator comparison** — max vs mean vs centroid, on a clean template and
     on one deliberately poisoned with a stranger's embedding. This is the
     experiment behind the decision to stop scoring against the best-matching
     stored vector: with `max`, one wrong vector in three takes the false accept
     rate from ~0.1% to ~3%, because verification is free to match the intruder.

  3. **Mesh-vs-embedding** — how well a scale- and rotation-normalised mesh
     signature separates identities compared with the CNN embedding. The mesh
     lands near chance, which is why it is used for liveness only.

LFW is harder than a cooperative webcam capture (varied pose, lighting, decades
of age drift, low resolution), so treat the false-reject numbers as pessimistic
and the false-accept numbers as conservative.
"""
import argparse
import asyncio
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import face  # noqa: E402
from core.config import settings  # noqa: E402


def _to_bgr(arr: np.ndarray, upscale: int = 3, pad_frac: float = 0.5) -> np.ndarray:
    """
    Prepare an LFW image for the detectors.

    sklearn's LFW is a tight crop with no margin around the face. SCRFD needs
    surrounding context and finds nothing on a face that fills the whole frame,
    so the crop is padded before either engine sees it. Real webcam frames
    already have this margin — the capture gate keeps the face at 28-80% of
    frame height — so the padding corrects the benchmark, not the product.
    """
    a = (arr * 255).astype(np.uint8) if arr.max() <= 1.001 else arr.astype(np.uint8)
    img = cv2.cvtColor(a, cv2.COLOR_RGB2BGR)
    img = cv2.resize(
        img, (img.shape[1] * upscale, img.shape[0] * upscale), interpolation=cv2.INTER_CUBIC
    )
    py, px = int(img.shape[0] * pad_frac), int(img.shape[1] * pad_frac)
    return cv2.copyMakeBorder(img, py, py, px, px, cv2.BORDER_REPLICATE)


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v)
    return v / n if n else v


async def _embed(arr):
    return (await face.detect_and_embed(_to_bgr(arr)))[1]


# ---------------------------------------------------------------------------
async def sweep_threshold(identities: int):
    from sklearn.datasets import fetch_lfw_people

    people = fetch_lfw_people(min_faces_per_person=15, color=True, resize=1.0, funneled=True)
    X, y = people.images, people.target

    templates, probes = {}, {}
    for pid in range(min(identities, len(people.target_names))):
        idx = np.flatnonzero(y == pid)
        if len(idx) < 7:
            continue
        enrol = [await _embed(X[i]) for i in idx[:3]]
        probe = [await _embed(X[i]) for i in idx[3:7]]
        enrol = [e for e in enrol if e is not None]
        probe = [e for e in probe if e is not None]
        if len(enrol) == 3 and probe:
            templates[pid] = enrol
            probes[pid] = probe

    print(f"\n=== 1. Threshold sweep ===  ({len(templates)} identities, "
          f"{sum(len(v) for v in probes.values())} probes, 3-image centroid templates)")

    genuine, impostor = [], []
    for pid, enrol in templates.items():
        centroid = face.centroid(enrol)
        for cid, pes in probes.items():
            for e in pes:
                s = face.template_similarity(e, centroid)
                (genuine if cid == pid else impostor).append(s)
    genuine, impostor = np.array(genuine), np.array(impostor)

    print(f"  genuine  mean={genuine.mean():.3f}  p5={np.percentile(genuine, 5):.3f}")
    print(f"  impostor mean={impostor.mean():.3f}  p99={np.percentile(impostor, 99):.3f}  "
          f"max={impostor.max():.3f}")
    print(f"\n  {'threshold':>10}{'FAR %':>9}{'FRR %':>9}")
    for t in np.arange(0.45, 0.81, 0.05):
        print(f"  {t:>10.2f}{(impostor >= t).mean() * 100:9.2f}{(genuine < t).mean() * 100:9.2f}")
    print(f"\n  configured threshold ({settings.FACE_ENGINE}) = {settings.match_threshold}")
    return templates, probes


# ---------------------------------------------------------------------------
def compare_aggregators(templates, probes):
    print("\n=== 2. Aggregator comparison ===")
    print("  A poisoned template holds one vector belonging to somebody else —")
    print("  what an enrolment captures when a bystander is in frame.\n")

    def score(agg, temp, e):
        sims = [face.cosine_similarity(e, t) for t in temp]
        if agg == "max":
            return max(sims)
        if agg == "mean":
            return float(np.mean(sims))
        return face.template_similarity(e, face.centroid(temp))

    print(f"  {'template':>10} {'aggregator':>11}{'gen mean':>10}{'imp max':>9}"
          f"{'FAR %':>8}{'FRR %':>8}   (at {settings.match_threshold})")
    for poison in (False, True):
        for agg in ("max", "mean", "centroid"):
            gen, imp = [], []
            for pid, enrol in templates.items():
                temp = list(enrol)
                if poison:
                    other = next(q for q in templates if q != pid)
                    temp[2] = templates[other][0]
                for cid, pes in probes.items():
                    for e in pes:
                        (gen if cid == pid else imp).append(score(agg, temp, e))
            gen, imp = np.array(gen), np.array(imp)
            t = settings.match_threshold
            label = "poisoned" if poison else "clean"
            print(f"  {label:>10} {agg:>11}{gen.mean():10.3f}{imp.max():9.3f}"
                  f"{(imp >= t).mean() * 100:8.2f}{(gen < t).mean() * 100:8.2f}")


# ---------------------------------------------------------------------------
def mesh_vs_embedding(pairs: int):
    """Show why the mesh is used for liveness and not for matching."""
    from sklearn.datasets import fetch_lfw_pairs
    from core import mesh as mesh_mod

    print("\n=== 3. Mesh geometry vs CNN embedding, as an identity signal ===")
    data = fetch_lfw_pairs(subset="test", color=True, resize=1.0, funneled=True)
    rng = np.random.default_rng(0)
    pos = np.flatnonzero(data.target == 1)
    neg = np.flatnonzero(data.target == 0)
    sel = np.concatenate([
        rng.choice(pos, pairs // 2, replace=False),
        rng.choice(neg, pairs // 2, replace=False),
    ])

    # Stable anatomical points: eye corners, nose, mouth, jaw, brow.
    anchors = [33, 133, 362, 263, 1, 168, 4, 61, 291, 199, 152, 234, 454, 10,
               336, 107, 297, 67, 0, 17, 57, 287, 132, 361]

    def signature(points):
        p = points[anchors][:, :2]
        p = p - p.mean(axis=0)
        scale = np.sqrt((p ** 2).sum() / len(p))
        if scale == 0:
            return None
        p = p / scale
        u, _, _ = np.linalg.svd(p.T @ p)
        p = p @ u
        d = [np.linalg.norm(p[i] - p[j]) for i in range(len(p)) for j in range(i + 1, len(p))]
        return _unit(d)

    sims, labels, ears = [], [], []
    for (a, b), label in zip(data.pairs[sel], data.target[sel]):
        ma = mesh_mod.detect_mesh_sync(_to_bgr(a))
        mb = mesh_mod.detect_mesh_sync(_to_bgr(b))
        if ma is None or mb is None:
            continue
        ears += [ma.ear, mb.ear]
        sa, sb = signature(ma.points), signature(mb.points)
        if sa is None or sb is None:
            continue
        sims.append(float(sa @ sb))
        labels.append(int(label))

    sims, labels = np.array(sims), np.array(labels)
    g, i = sims[labels == 1], sims[labels == 0]
    pooled = np.sqrt((g.var() + i.var()) / 2)
    best = max(((sims >= t) == (labels == 1)).mean() for t in np.unique(np.round(sims, 4)))
    print(f"  mesh signature: genuine {g.mean():.4f} vs impostor {i.mean():.4f}  "
          f"(Cohen's d = {(g.mean() - i.mean()) / pooled:.2f})")
    print(f"  best accuracy achievable from mesh geometry alone: {best * 100:.1f}%  "
          f"— near chance, hence embeddings for identity")

    ears = np.array(ears)
    print(f"\n  open-eye EAR across {len(ears)} real faces: median={np.median(ears):.3f}  "
          f"p5={np.percentile(ears, 5):.3f}")
    print(f"  configured LIVENESS_MIN_OPEN_EAR={settings.LIVENESS_MIN_OPEN_EAR} gates "
          f"{(ears < settings.LIVENESS_MIN_OPEN_EAR).mean() * 100:.1f}% of them")


def self_consistency_gate(templates):
    """
    Where to put the enrolment poisoning guard.

    A template is 'poisoned' when one of its vectors belongs to someone else —
    a bystander caught in frame. We compare the weakest member-to-centroid
    agreement in clean templates against the same figure once a stranger is
    swapped in, and look for a cutoff that separates them.
    """
    print("\n=== 4. Enrolment self-consistency gate ===")
    ids = list(templates)
    if len(ids) < 2:
        print("  not enough identities")
        return

    clean = np.array([face.self_consistency(templates[p]) for p in ids])
    poisoned = np.array([
        face.self_consistency(templates[p][:2] + [templates[ids[(i + 1) % len(ids)]][0]])
        for i, p in enumerate(ids)
    ])

    print(f"  clean    min-agreement: mean={clean.mean():.3f} min={clean.min():.3f}")
    print(f"  poisoned min-agreement: mean={poisoned.mean():.3f} max={poisoned.max():.3f}")
    print(f"\n  {'cutoff':>8}{'clean rejected %':>19}{'poisoned caught %':>19}")
    for c in (0.40, 0.50, 0.55, 0.60, 0.65, 0.70):
        print(f"  {c:>8.2f}{(clean < c).mean() * 100:19.1f}{(poisoned < c).mean() * 100:19.1f}")
    print(f"\n  configured self-similarity threshold = {settings.self_similarity_threshold}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pairs", type=int, default=200, help="LFW pairs for the mesh comparison")
    ap.add_argument("--identities", type=int, default=40, help="identities for the threshold sweep")
    ap.add_argument("--skip-mesh", action="store_true")
    args = ap.parse_args()

    print(f"face engine: {settings.FACE_ENGINE}")
    templates, probes = asyncio.run(sweep_threshold(args.identities))
    compare_aggregators(templates, probes)
    self_consistency_gate(templates)
    if not args.skip_mesh:
        mesh_vs_embedding(args.pairs)


if __name__ == "__main__":
    main()
