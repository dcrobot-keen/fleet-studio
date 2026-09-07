"""Pydantic models for the HTTP contract (server/app.py, server/groups_api.py).

These are what `openapi.json` -> `src/scanStudio/scanEngine.gen.d.ts` turns into TypeScript, so
Fleet Studio's client (openapi-fetch, `npm run check:api`) type-checks responses and bodies -- not
just paths. Models mirror the dicts the studio package already produces (studio.groups,
studio.align_workspace_html, studio.scan_alignment_metrics, studio.status, studio.project); the
functions keep returning dicts, FastAPI validates/serialises them through these models.

`extra="allow"` on the payload-ish models keeps forward-compatible: a new field appears in the
response (and as an index signature in TS) before the model catches up, instead of being dropped.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Lenient(BaseModel):
    model_config = ConfigDict(extra="allow")


# --------------------------------------------------------------------------
# alignment primitives (== studio.merge_slicemaps.ScanAlignment)
# --------------------------------------------------------------------------

class Alignment(BaseModel):
    """Pose of one scan in the group's slice plane: CCW yaw, then translate (offsetX, -offsetZ)."""
    offsetX: float
    offsetZ: float
    yawRadians: float
    method: str | None = None


class AlignmentMetrics(BaseModel):
    """== studio.scan_alignment_metrics.AlignmentMetrics.to_json()"""
    n_source: int
    n_observed: int
    overlap_m: float
    inlier: float
    conflict: float
    rmse_m: float | None = None


class SavedMetrics(Lenient):
    """What the page writes into group_alignment.json per scan (rounded subset)."""
    overlap_m: float | None = None
    inlier: float | None = None
    conflict: float | None = None
    rmse_m: float | None = None


class AlignmentEntry(Alignment):
    metrics: SavedMetrics | None = None
    approved: bool | None = None
    approved_at: str | None = None


class GroupAlignmentDoc(Lenient):
    """group_alignment.json (scan-group-alignment-v1)."""
    format: str = "scan-group-alignment-v1"
    group: str | None = None
    reference: str
    up_axis_convention: str | None = None
    alignments: dict[str, AlignmentEntry]


# --------------------------------------------------------------------------
# groups
# --------------------------------------------------------------------------

class ScanStatus(BaseModel):
    id: str
    has_folder: bool
    has_usdz: bool
    has_project: bool
    has_slice: bool
    method: str


class GroupStatus(BaseModel):
    name: str
    dir: str
    reference: str | None
    scans: list[ScanStatus]
    has_alignment: bool
    has_merged: bool
    ready: bool
    has_floor: bool = False


class GroupUploadResult(BaseModel):
    status: str
    group: str
    url: str
    scans: int


class FloorPayload(BaseModel):
    """App floorplan.png as a data URL + where it sits (== studio.floorplan.FloorPlan.payload())."""
    dataUrl: str
    originX: float
    originTopZ: float
    resolution: float
    width: int
    height: int


class LayerPayload(BaseModel):
    """One scan in the workspace: slice cells (base64 uint8 codes, row 0 = min y) + pose + metrics."""
    id: str
    cols: int
    rows: int
    resolution: float
    origin: list[float] = Field(min_length=2, max_length=2)
    z: float
    data: str
    alignment: Alignment
    metrics: AlignmentMetrics | None = None
    floor: FloorPayload | None = None


class WorkspaceGates(BaseModel):
    overlapLockM: float
    inlierMin: float
    conflictMax: float
    corrDist: float
    coarseDist: float
    conflictMargin: int


class WorkspaceApi(BaseModel):
    save: str
    icp: str
    metrics: str | None = None
    merged: str
    status: str


class WorkspacePayload(BaseModel):
    """GET /api/groups/{name}/workspace (== studio.align_workspace_html.workspace_payload)."""
    title: str
    group: str | None
    reference: str
    layers: list[LayerPayload]
    gates: WorkspaceGates
    api: WorkspaceApi | None = None


class PoseRequest(BaseModel):
    """Body of POST .../metrics and .../icp: one scan at a candidate pose, other scans' current poses."""
    scan: str
    alignment: Alignment
    others: dict[str, Alignment] | None = None


class IcpStep(BaseModel):
    radius: float
    rmse: float
    iterations: int


class IcpResult(BaseModel):
    scan: str
    alignment: Alignment
    before: AlignmentMetrics
    after: AlignmentMetrics
    steps: list[IcpStep]
    moved_m: float
    rotated_deg: float


class MergedCells(BaseModel):
    cols: int
    rows: int


class AlignmentHistoryEntry(BaseModel):
    """One past save, newest first (GET /api/groups/{name}/alignment/history) -- a snapshot
    taken right before that save overwrote group_alignment.json, so it's always restorable."""
    timestamp: str
    scans: int
    approved: list[str]


class SaveAlignmentResult(BaseModel):
    """PUT /api/groups/{name}/alignment -> merged slicemap rebuilt (+ published)."""
    group: str
    alignment_file: str
    merged: str
    merged_summary: str
    cells: MergedCells
    scans: int
    approved: list[str]
    pending: list[str]
    published: str | None = None
    floor: str | None = None
    floor_scans: list[str] = []
    published_floor: str | None = None


class SlicemapSource(Lenient):
    scan: str
    offsetX: float | None = None
    offsetZ: float | None = None
    yawRadians: float | None = None
    method: str | None = None
    cells: int | None = None


class SlicemapV1(Lenient):
    """slicemap-v1 file (merged.slicemap.json): base64 uint8 codes 0 unknown / 1 free / 2 furniture / 3 wall."""
    format: Literal["slicemap-v1"]
    z: float
    band: float
    resolution: float
    origin: list[float] = Field(min_length=2, max_length=2)
    cols: int
    rows: int
    data: str
    sources: list[SlicemapSource] | None = None


class FloorMeta(Lenient):
    """merged.floor.json (== studio.floorplan.floor_meta)."""
    format: str
    resolution: float
    origin: list[float] = Field(min_length=2, max_length=2)
    width_px: int
    height_px: int
    row0: str | None = None


# --------------------------------------------------------------------------
# single-scan projects (scan wizard)
# --------------------------------------------------------------------------

StepState = Literal["pending", "active", "done", "skip", "error"]


class ProjectStatus(Lenient):
    """status.json (== studio.status.read_status); phase None = never processed."""
    phase: str | None = None
    steps: dict[str, StepState] = {}
    log: list[str] = []
    error: str | None = None


class ProjectEntry(Lenient):
    """GET /api/projects item (== studio.project.list_projects)."""
    name: str
    phase: str
    steps: dict[str, str] = {}
    error: str | None = None
    mtime: float


class ProjectCreated(BaseModel):
    name: str


class ProcessStarted(Lenient):
    """POST /api/projects/{name}/process: a single scan starts the pipeline; a multi-scan zip becomes a group."""
    status: str
    type: Literal["single", "group"]
    name: str | None = None
    has_floorplan: bool | None = None
    group: str | None = None
    group_url: str | None = None
    message: str | None = None
