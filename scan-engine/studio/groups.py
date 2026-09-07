"""Scan groups ("projects" in the iPhone app): several scan_<name>/ folders plus
one group_alignment.json, served and saved by the alignment workspace.

A group directory is exactly what the app's project zip unpacks to:

    <groups root>/<group>/
      group_alignment.json          scan-group-alignment-v1 (app draft -> desktop truth)
      scan_A/  scan.usdz, ...       the scans (full or map-only profile)
      scan_B/  ...
      scan_A.slicemap.json          cached slice per scan (built here on demand)
      merged.slicemap.json/.png     written on every save

Roots are looked up at call time (not import time) so tests and the server
can point them anywhere:

    STUDIO_GROUPS_DIR   where groups live      (default <repo>/groups)
    STUDIO_PUBLISH_DIR  where merged slicemaps are copied on save, e.g. the
                        fleet-studio container stack's deploy/worlds/ folder (optional)
    STUDIO_SLICE_Z      robot LiDAR height for slices, metres (default 0.18)

This module has no FastAPI dependency; server/groups_api.py is the HTTP face.
"""
from __future__ import annotations

import json
import math
import os
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from studio.align_workspace_html import build_alignment_workspace_html
from studio.floorplan import FLOOR_STEM, composite_floorplans, load_floorplan, save_floor
from studio.merge_slicemaps import (
    ALIGNMENT_FORMAT,
    GroupAlignment,
    ScanAlignment,
    Slice,
    load_group_alignment,
    load_slice,
    merge_slices,
    save_group_alignment,
    save_preview_png,
    save_slice,
    summarize,
)
from studio.project import PROJECTS_ROOT
from studio.scan_alignment_metrics import alignment_from_rigid_2d, evaluate, wall_points

REPO_ROOT = Path(__file__).resolve().parent.parent
ALIGNMENT_FILE = "group_alignment.json"
MERGED_STEM = "merged"
# 저장할 때마다 "저장 직전" group_alignment.json을 여기 스냅샷해둔다 -- 정합 작업은 드래그/ICP/핀을
# 여러 번 시행착오하는 성격이라, 잘못 저장했을 때 "그 전엔 뭐였지"를 기억에 의존하면 위험하다.
# HISTORY_KEEP개를 넘으면 오래된 것부터 지운다(무한정 쌓이지 않게).
HISTORY_DIRNAME = ".history"
HISTORY_KEEP = 30


def groups_root() -> Path:
    return Path(os.environ.get("STUDIO_GROUPS_DIR", REPO_ROOT / "groups")).resolve()


def publish_dir() -> Path | None:
    v = os.environ.get("STUDIO_PUBLISH_DIR")
    return Path(v).resolve() if v else None


def slice_z() -> float:
    return float(os.environ.get("STUDIO_SLICE_Z", "0.18"))


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

@dataclass
class ScanStatus:
    id: str
    has_folder: bool
    has_usdz: bool
    has_project: bool   # projects/<scan>/base_map.ply exists
    has_slice: bool     # <group>/<scan>.slicemap.json exists
    method: str


@dataclass
class GroupStatus:
    name: str
    dir: str
    reference: str | None
    scans: list[ScanStatus]
    has_alignment: bool
    has_merged: bool
    ready: bool  # every scan has a slice -> workspace can open without preparing
    has_floor: bool = False  # merged.floor.png exists (app floor images composited on save)

    def to_json(self) -> dict:
        d = asdict(self)
        return d


def _scan_ids(group_dir: Path, ga: GroupAlignment | None) -> list[str]:
    ids: list[str] = []
    if ga is not None:
        ids.append(ga.reference)
        ids += [s for s in ga.alignments if s not in ids]
    for p in sorted(group_dir.iterdir()):
        if p.is_dir() and p.name.startswith("scan_") and p.name not in ids:
            ids.append(p.name)
    return ids


def _load_alignment(group_dir: Path) -> GroupAlignment | None:
    f = group_dir / ALIGNMENT_FILE
    return load_group_alignment(f) if f.exists() else None


def slice_path(group_dir: Path, scan: str) -> Path:
    return group_dir / f"{scan}.slicemap.json"


def group_status(name: str, root: Path | None = None, projects_root: Path = PROJECTS_ROOT) -> GroupStatus:
    root = root or groups_root()
    group_dir = root / name
    if not group_dir.is_dir():
        raise FileNotFoundError(f"group {name!r} not found under {root}")
    ga = _load_alignment(group_dir)
    scans = []
    for sid in _scan_ids(group_dir, ga):
        folder = group_dir / sid
        scans.append(ScanStatus(
            id=sid,
            has_folder=folder.is_dir(),
            has_usdz=(folder / "scan.usdz").exists(),
            has_project=(projects_root / sid / "base_map.ply").exists(),
            has_slice=slice_path(group_dir, sid).exists(),
            method="reference" if ga and sid == ga.reference else (ga.get(sid).method if ga else "identity"),
        ))
    return GroupStatus(
        name=name,
        dir=str(group_dir),
        reference=ga.reference if ga else (scans[0].id if scans else None),
        scans=scans,
        has_alignment=ga is not None,
        has_merged=(group_dir / f"{MERGED_STEM}.slicemap.json").exists(),
        has_floor=(group_dir / f"{MERGED_STEM}.{FLOOR_STEM}.png").exists(),
        ready=bool(scans) and all(s.has_slice for s in scans),
    )


def delete_group(name: str, root: Path | None = None) -> None:
    """Remove <groups root>/<name>/ entirely (scans, group_alignment.json, merged.*).
    Raises FileNotFoundError if the group doesn't exist."""
    root = root or groups_root()
    group_dir = root / name
    if not group_dir.is_dir():
        raise FileNotFoundError(f"group {name!r} not found under {root}")
    shutil.rmtree(group_dir)


def list_groups(root: Path | None = None) -> list[GroupStatus]:
    root = root or groups_root()
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.iterdir()):
        if not p.is_dir():
            continue
        if (p / ALIGNMENT_FILE).exists() or any(c.is_dir() and c.name.startswith("scan_") for c in p.iterdir()):
            out.append(group_status(p.name, root))
    return out


# --------------------------------------------------------------------------
# preparation: usdz -> project (base_map.ply) -> slicemap, cached per scan
# --------------------------------------------------------------------------

def ensure_slice(group_dir: Path, scan: str, projects_root: Path = PROJECTS_ROOT, z: float | None = None) -> Path:
    """Return the scan's slicemap, building the studio project and the slice
    if they do not exist yet. Slow path (usdz -> pipeline) takes tens of
    seconds per scan; the slice itself takes ~1 s."""
    out = slice_path(group_dir, scan)
    if out.exists():
        return out
    base = projects_root / scan / "base_map.ply"
    if not base.exists():
        usdz = group_dir / scan / "scan.usdz"
        if not usdz.exists():
            raise FileNotFoundError(f"{scan}: no slicemap, no processed project and no scan.usdz to build one from")
        from studio.pipeline import run_pipeline

        (projects_root / scan).mkdir(parents=True, exist_ok=True)
        run_pipeline(projects_root / scan, usdz_path=usdz)
    from studio.classify import classify_floor_wall_furniture
    from studio.point_cloud_io import load_point_cloud
    from studio.slice_map import rasterize_slice, save_slice_json

    points, _ = load_point_cloud(base)
    labels = classify_floor_wall_furniture(points, rng=np.random.default_rng(0)).labels
    sg = rasterize_slice(points, z=z if z is not None else slice_z(), band=0.05, resolution=0.05, labels=labels)
    save_slice_json(out, sg)
    return out


def prepare(name: str, root: Path | None = None, projects_root: Path = PROJECTS_ROOT) -> GroupStatus:
    root = root or groups_root()
    group_dir = root / name
    st = group_status(name, root, projects_root)
    for s in st.scans:
        ensure_slice(group_dir, s.id, projects_root)
    return group_status(name, root, projects_root)


def _load_slices(group_dir: Path, ids: list[str]) -> dict[str, Slice]:
    return {sid: load_slice(slice_path(group_dir, sid)) for sid in ids if slice_path(group_dir, sid).exists()}


def _load_floors(group_dir: Path, ids: list[str]) -> dict:
    """scan id -> FloorPlan for every scan folder that has the app's floorplan.png/json."""
    out = {}
    for sid in ids:
        fp = load_floorplan(group_dir / sid)
        if fp is not None:
            out[sid] = fp
    return out


def _alignment_or_identity(group_dir: Path, ids: list[str]) -> GroupAlignment:
    ga = _load_alignment(group_dir)
    if ga is None:
        ga = GroupAlignment(reference=ids[0], alignments={}, group=group_dir.name)
    if ga.group is None:
        ga.group = group_dir.name
    return ga


# --------------------------------------------------------------------------
# workspace page
# --------------------------------------------------------------------------

def workspace_html(name: str, api_base: str | None, root: Path | None = None, projects_root: Path = PROJECTS_ROOT) -> str:
    """The alignment page for this group. `api_base` like "/api/groups/<name>"
    turns on server save / ICP in the page; None gives the offline page."""
    root = root or groups_root()
    group_dir = root / name
    st = group_status(name, root, projects_root)
    ids = [s.id for s in st.scans]
    if not ids:
        raise FileNotFoundError(f"group {name!r} has no scans")
    slices = _load_slices(group_dir, ids)
    missing = [s for s in ids if s not in slices]
    if missing:
        raise FileNotFoundError(f"group {name!r}: scans not prepared yet: {missing}")
    ga = _alignment_or_identity(group_dir, ids)
    api = None
    if api_base:
        api = {"save": f"{api_base}/alignment", "icp": f"{api_base}/icp", "merged": f"{api_base}/merged.png", "status": f"{api_base}"}
    floors = _load_floors(group_dir, ids)
    return build_alignment_workspace_html(slices, ga, title=f"정합: {name}", order=ids, api=api, floors=floors or None)


def _workspace_parts(name: str, root: Path | None, projects_root: Path):
    root = root or groups_root()
    group_dir = root / name
    st = group_status(name, root, projects_root)
    ids = [s.id for s in st.scans]
    if not ids:
        raise FileNotFoundError(f"group {name!r} has no scans")
    slices = _load_slices(group_dir, ids)
    missing = [s for s in ids if s not in slices]
    if missing:
        raise FileNotFoundError(f"group {name!r}: scans not prepared yet: {missing}")
    return group_dir, ids, slices, _alignment_or_identity(group_dir, ids)


def workspace_data(name: str, root: Path | None = None, projects_root: Path = PROJECTS_ROOT) -> dict:
    """JSON twin of workspace_html(): what Fleet Studio's native alignment canvas loads
    (GET /api/groups/{name}/workspace). Same payload the standalone page embeds."""
    from studio.align_workspace_html import workspace_payload

    group_dir, ids, slices, ga = _workspace_parts(name, root, projects_root)
    api_base = f"/api/groups/{name}"
    api = {"save": f"{api_base}/alignment", "icp": f"{api_base}/icp", "metrics": f"{api_base}/metrics",
           "merged": f"{api_base}/merged.png", "status": api_base}
    floors = _load_floors(group_dir, ids)
    return workspace_payload(slices, ga, title=f"정합: {name}", order=ids, api=api, floors=floors or None)


def metrics_for(name: str, scan: str, alignment: dict, others: dict[str, dict] | None = None,
                root: Path | None = None) -> dict:
    """evaluate() for one scan at a candidate pose against the group's other scans (at the
    page's current poses if given) -- the native workspace asks the server instead of
    re-implementing overlap/inlier/conflict in JS."""
    root = root or groups_root()
    group_dir = root / name
    ga = _load_alignment(group_dir)
    ids = _scan_ids(group_dir, ga)
    slices = _load_slices(group_dir, ids)
    if scan not in slices:
        raise FileNotFoundError(f"{scan}: no slicemap")
    cur = ScanAlignment(float(alignment["offsetX"]), float(alignment["offsetZ"]), float(alignment["yawRadians"]))

    def pose_of(sid: str) -> ScanAlignment:
        if others and sid in others:
            o = others[sid]
            return ScanAlignment(float(o["offsetX"]), float(o["offsetZ"]), float(o["yawRadians"]))
        return ga.get(sid) if ga else ScanAlignment()

    targets = [(slices[o], pose_of(o)) for o in ids if o != scan and o in slices]
    if not targets:
        raise ValueError("no other scan to compare against")
    return evaluate(slices[scan], cur, targets).to_json()


# --------------------------------------------------------------------------
# save: alignment -> merged slicemap (+ publish)
# --------------------------------------------------------------------------

def validate_alignment_doc(doc: dict) -> None:
    if doc.get("format") != ALIGNMENT_FORMAT:
        raise ValueError(f"format must be {ALIGNMENT_FORMAT!r}")
    if not isinstance(doc.get("reference"), str) or not doc["reference"]:
        raise ValueError("reference (scan id) is required")
    al = doc.get("alignments")
    if not isinstance(al, dict):
        raise ValueError("alignments must be an object")
    for sid, a in al.items():
        for k in ("offsetX", "offsetZ", "yawRadians"):
            v = a.get(k)
            if not isinstance(v, (int, float)) or not math.isfinite(v):
                raise ValueError(f"alignments[{sid!r}].{k} must be a finite number")


def _history_dir(group_dir: Path) -> Path:
    return group_dir / HISTORY_DIRNAME


def list_alignment_history(name: str, root: Path | None = None) -> list[dict]:
    """Past saves for this group, newest first. Each entry is a snapshot taken right
    before a save overwrote group_alignment.json -- see save_alignment()."""
    root = root or groups_root()
    hist_dir = _history_dir(root / name)
    if not hist_dir.is_dir():
        return []
    out = []
    for p in sorted(hist_dir.glob("*.json"), reverse=True):
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        alignments = doc.get("alignments", {})
        approved = [s for s, a in alignments.items() if a.get("approved")]
        out.append({"timestamp": p.stem, "scans": len(alignments), "approved": approved})
    return out


def get_alignment_history_entry(name: str, timestamp: str, root: Path | None = None) -> dict:
    """The raw group_alignment.json content saved at `timestamp` (from list_alignment_history)."""
    root = root or groups_root()
    p = _history_dir(root / name) / f"{timestamp}.json"
    if not p.is_file():
        raise FileNotFoundError(f"history entry not found: {name}/{timestamp}")
    return json.loads(p.read_text(encoding="utf-8"))


def save_alignment(name: str, doc: dict, root: Path | None = None, projects_root: Path = PROJECTS_ROOT, publish: Path | None = None) -> dict:
    """Write the alignment file, rebuild merged.slicemap.json/.png, copy the
    merged slicemap to the publish dir (if configured). Returns a summary the
    page shows."""
    validate_alignment_doc(doc)
    root = root or groups_root()
    group_dir = root / name
    if not group_dir.is_dir():
        raise FileNotFoundError(f"group {name!r} not found")

    existing = group_dir / ALIGNMENT_FILE
    if existing.exists():
        hist_dir = _history_dir(group_dir)
        hist_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        shutil.copyfile(existing, hist_dir / f"{stamp}.json")
        for old in sorted(hist_dir.glob("*.json"))[:-HISTORY_KEEP]:
            old.unlink(missing_ok=True)

    doc = dict(doc)
    doc.setdefault("group", name)
    doc.setdefault("up_axis_convention", "top = -z")
    (group_dir / ALIGNMENT_FILE).write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")

    ga = load_group_alignment(group_dir / ALIGNMENT_FILE)
    ids = _scan_ids(group_dir, ga)
    slices = _load_slices(group_dir, ids)
    if ga.reference not in slices:
        raise FileNotFoundError(f"reference scan {ga.reference!r} has no slicemap -- prepare the group first")
    merged = merge_slices(slices, ga)
    merged_json = save_slice(group_dir / f"{MERGED_STEM}.slicemap.json", merged)
    save_preview_png(group_dir / f"{MERGED_STEM}.png", merged)

    # 앱 바닥 이미지가 있는 스캔들을 같은 정합으로 합친 한 장 -- merged 슬라이스맵과 격자가
    # 같아서 pathfinder 배경 / 시뮬레이터 뷰어가 픽셀 단위로 겹쳐 쓸 수 있다.
    floor_png = floor_json = None
    floors = _load_floors(group_dir, ids)
    if floors:
        img = composite_floorplans(floors, ga, merged)
        floor_png, floor_json = save_floor(group_dir / f"{MERGED_STEM}.{FLOOR_STEM}.png", group_dir / f"{MERGED_STEM}.{FLOOR_STEM}.json", img, merged)

    published = None
    published_floor = None
    target_dir = publish if publish is not None else publish_dir()
    if target_dir is not None:
        target_dir.mkdir(parents=True, exist_ok=True)
        published = target_dir / f"{name}.slicemap.json"
        shutil.copyfile(merged_json, published)
        if floor_png is not None:
            published_floor = target_dir / f"{name}.{FLOOR_STEM}.png"
            shutil.copyfile(floor_png, published_floor)
            shutil.copyfile(floor_json, target_dir / f"{name}.{FLOOR_STEM}.json")

    approved = [s for s, a in doc["alignments"].items() if a.get("approved")]
    return {
        "group": name,
        "alignment_file": str(group_dir / ALIGNMENT_FILE),
        "merged": str(merged_json),
        "merged_summary": summarize(merged),
        "cells": {"cols": merged.cols, "rows": merged.rows},
        "scans": len(slices),
        "approved": approved,
        "pending": [s for s in doc["alignments"] if s not in approved],
        "published": str(published) if published else None,
        "floor": str(floor_png) if floor_png else None,
        "floor_scans": sorted(floors),
        "published_floor": str(published_floor) if published_floor else None,
    }


# --------------------------------------------------------------------------
# ICP finisher (Phase 2): coarse -> fine, from the current pose, all other scans as target
# --------------------------------------------------------------------------

def _compose(inc_R: np.ndarray, inc_t: np.ndarray, a: ScanAlignment) -> ScanAlignment:
    c, s = math.cos(a.yawRadians), math.sin(a.yawRadians)
    Ra = np.array([[c, -s], [s, c]])
    ta = np.array([a.offsetX, -a.offsetZ])
    return alignment_from_rigid_2d(inc_R @ Ra, inc_R @ ta + inc_t)


def icp_refine(name: str, scan: str, alignment: dict, others: dict[str, dict] | None = None,
               root: Path | None = None, radii: tuple[float, ...] = (0.5, 0.25, 0.15)) -> dict:
    """Refine `scan`'s pose against every other scan of the group.
    `alignment` is the current pose from the page; `others` optionally carries
    the page's current poses for the other scans (else the saved file's).
    Returns the refined pose plus metrics before/after; the page decides
    whether to apply (and the gates decide whether it's believable)."""
    from studio.registration import icp_2d

    root = root or groups_root()
    group_dir = root / name
    ga = _load_alignment(group_dir)
    ids = _scan_ids(group_dir, ga)
    slices = _load_slices(group_dir, ids)
    if scan not in slices:
        raise FileNotFoundError(f"{scan}: no slicemap")
    cur = ScanAlignment(float(alignment["offsetX"]), float(alignment["offsetZ"]), float(alignment["yawRadians"]), method="icp")

    def pose_of(sid: str) -> ScanAlignment:
        if others and sid in others:
            o = others[sid]
            return ScanAlignment(float(o["offsetX"]), float(o["offsetZ"]), float(o["yawRadians"]))
        return ga.get(sid) if ga else ScanAlignment()

    targets = [(slices[o], pose_of(o)) for o in ids if o != scan and o in slices]
    if not targets:
        raise ValueError("no other scan to align against")
    tgt = np.concatenate([a.apply_xy(wall_points(s)) for s, a in targets])
    src_local = wall_points(slices[scan])
    before = evaluate(slices[scan], cur, targets)
    history = []
    for r in radii:
        # start in place: the page's pose IS the initial guess (never centroid-align
        # partial overlaps -- that slides the scan along the corridor)
        res = icp_2d(cur.apply_xy(src_local), tgt, max_correspondence_distance=r, max_iterations=200, start_from_centroids=False)
        cur = _compose(res.rotation, res.translation, cur)
        history.append({"radius": r, "rmse": float(res.rmse), "iterations": int(res.iterations)})
    after = evaluate(slices[scan], cur, targets)
    return {
        "scan": scan,
        "alignment": {"offsetX": cur.offsetX, "offsetZ": cur.offsetZ, "yawRadians": cur.yawRadians, "method": "icp"},
        "before": before.to_json(),
        "after": after.to_json(),
        "steps": history,
        "moved_m": math.hypot(cur.offsetX - float(alignment["offsetX"]), cur.offsetZ - float(alignment["offsetZ"])),
        "rotated_deg": math.degrees(cur.yawRadians - float(alignment["yawRadians"])),
    }
