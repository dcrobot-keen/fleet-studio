"""HTTP face of studio/groups.py: list scan groups, prepare them, serve the
alignment workspace, save alignments (which rebuilds + publishes the merged
slicemap), and run the ICP finisher. Mounted by server/app.py.

    GET  /groups                          index page (links to each workspace)
    GET  /groups/{name}                   the workspace (auto-prepares slices if missing)
    GET  /api/groups                      group statuses
    GET  /api/groups/{name}               one group's status
    POST /api/groups/{name}/prepare       build projects/slices for every scan
    DELETE /api/groups/{name}             remove the group directory entirely
    GET  /api/groups/{name}/alignment     current group_alignment.json
    PUT  /api/groups/{name}/alignment     save -> merged.slicemap.json/.png (+ publish);
                                           snapshots the previous file into .history/ first
    GET  /api/groups/{name}/alignment/history            past saves, newest first
    GET  /api/groups/{name}/alignment/history/{ts}       one past save's full content
    POST /api/groups/{name}/icp           {scan, alignment, others?} -> refined pose + metrics
    GET  /api/groups/{name}/merged.png    latest merged preview
"""
from __future__ import annotations

import html
import io
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from studio import groups
from server import schemas

router = APIRouter()


def _404(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(exc))


@router.get("/api/groups", response_model=list[schemas.GroupStatus])
def api_list_groups() -> list[dict]:
    return [g.to_json() for g in groups.list_groups()]


@router.get("/api/groups/{name}", response_model=schemas.GroupStatus)
def api_group(name: str) -> dict:
    try:
        return groups.group_status(name).to_json()
    except FileNotFoundError as exc:
        raise _404(exc)


@router.post("/api/groups/{name}/prepare", response_model=schemas.GroupStatus)
def api_prepare(name: str) -> dict:
    try:
        return groups.prepare(name).to_json()
    except FileNotFoundError as exc:
        raise _404(exc)


@router.delete("/api/groups/{name}", status_code=204)
def api_delete_group(name: str) -> None:
    try:
        groups.delete_group(name)
    except FileNotFoundError as exc:
        raise _404(exc)


@router.post("/api/groups/upload", response_model=schemas.GroupUploadResult)
async def api_upload_group(file: UploadFile = File(...), name: str | None = Form(None)) -> dict:
    filename = file.filename or "group.zip"
    group_name = (name or Path(filename).stem).strip()
    if not group_name:
        raise HTTPException(status_code=422, detail="group name is required")

    raw_bytes = await file.read()
    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes)) as z:
            group_dir = groups.groups_root() / group_name
            group_dir.mkdir(parents=True, exist_ok=True)

            names = z.namelist()
            align_names = [n for n in names if n.endswith("group_alignment.json")]
            prefix = ""
            if align_names and "/" in align_names[0]:
                prefix = align_names[0].rsplit("group_alignment.json", 1)[0]
            elif names and all("/" in n for n in names if not n.endswith("/")):
                root_folders = {n.split("/")[0] for n in names}
                if len(root_folders) == 1:
                    prefix = list(root_folders)[0] + "/"

            for item in z.infolist():
                if item.is_dir():
                    continue
                item_name = item.filename
                rel_name = item_name[len(prefix):] if prefix and item_name.startswith(prefix) else item_name
                rel_path = Path(rel_name)
                if ".." in rel_path.parts:
                    continue
                dest = group_dir / rel_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(z.read(item.filename))

            try:
                groups.prepare(group_name)
            except Exception as exc:
                print(f"[Warning] prepare error during group upload: {exc}")

            return {
                "status": "ok",
                "group": group_name,
                "url": f"/groups/{group_name}",
                "scans": len(groups.group_status(group_name).scans),
            }
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Bad zip file: {exc}") from exc


@router.get("/api/groups/{name}/workspace", response_model=schemas.WorkspacePayload)
def api_workspace(name: str) -> dict:
    """Slices + alignment + metrics + floor images as JSON (Fleet Studio native workspace)."""
    try:
        return groups.workspace_data(name)
    except FileNotFoundError as exc:
        raise _404(exc)


@router.post("/api/groups/{name}/metrics", response_model=schemas.AlignmentMetrics)
def api_metrics(name: str, body: schemas.PoseRequest) -> dict:
    try:
        others = {k: v.model_dump() for k, v in body.others.items()} if body.others else None
        return groups.metrics_for(name, body.scan, body.alignment.model_dump(), others)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except FileNotFoundError as exc:
        raise _404(exc)


@router.get("/api/groups/{name}/merged.slicemap.json", responses={200: {"model": schemas.SlicemapV1}})
def api_merged_slicemap(name: str) -> FileResponse:
    p = groups.groups_root() / name / f"{groups.MERGED_STEM}.slicemap.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="not merged yet -- save an alignment first")
    return FileResponse(str(p), media_type="application/json")


@router.get("/api/groups/{name}/merged.floor.json", responses={200: {"model": schemas.FloorMeta}})
def api_merged_floor_json(name: str) -> FileResponse:
    p = groups.groups_root() / name / f"{groups.MERGED_STEM}.floor.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="no composited floor image for this group")
    return FileResponse(str(p), media_type="application/json")


@router.get("/api/groups/{name}/alignment", response_model=schemas.GroupAlignmentDoc)
def api_get_alignment(name: str) -> dict:
    f = groups.groups_root() / name / groups.ALIGNMENT_FILE
    if not f.exists():
        raise HTTPException(status_code=404, detail="no group_alignment.json yet")
    import json

    return json.loads(f.read_text(encoding="utf-8"))


@router.get("/api/groups/{name}/alignment/history", response_model=list[schemas.AlignmentHistoryEntry])
def api_alignment_history(name: str) -> list[dict]:
    return groups.list_alignment_history(name)


@router.get("/api/groups/{name}/alignment/history/{timestamp}", response_model=schemas.GroupAlignmentDoc)
def api_alignment_history_entry(name: str, timestamp: str) -> dict:
    try:
        return groups.get_alignment_history_entry(name, timestamp)
    except FileNotFoundError as exc:
        raise _404(exc)


@router.put("/api/groups/{name}/alignment", response_model=schemas.SaveAlignmentResult)
def api_put_alignment(name: str, doc: schemas.GroupAlignmentDoc) -> dict:
    try:
        return groups.save_alignment(name, doc.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except FileNotFoundError as exc:
        raise _404(exc)


@router.post("/api/groups/{name}/icp", response_model=schemas.IcpResult)
def api_icp(name: str, body: schemas.PoseRequest) -> dict:
    try:
        others = {k: v.model_dump() for k, v in body.others.items()} if body.others else None
        return groups.icp_refine(name, body.scan, body.alignment.model_dump(), others)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except FileNotFoundError as exc:
        raise _404(exc)


@router.get("/api/groups/{name}/merged.png")
def api_merged_png(name: str) -> FileResponse:
    p = groups.groups_root() / name / f"{groups.MERGED_STEM}.png"
    if not p.exists():
        raise HTTPException(status_code=404, detail="not merged yet -- save an alignment first")
    return FileResponse(str(p), media_type="image/png")


@router.get("/api/groups/{name}/merged.floor.png")
def api_merged_floor_png(name: str) -> FileResponse:
    p = groups.groups_root() / name / f"{groups.MERGED_STEM}.floor.png"
    if not p.exists():
        raise HTTPException(status_code=404, detail="not merged yet -- save an alignment first")
    return FileResponse(str(p), media_type="image/png")


@router.get("/groups", response_class=HTMLResponse)
def groups_index() -> str:
    rows = []
    for g in groups.list_groups():
        scans = ", ".join(f"{s.id} ({s.method}{'' if s.has_slice else ', 준비 필요'})" for s in g.scans)
        rows.append(
            f"<li><a href='/groups/{html.escape(g.name)}'>{html.escape(g.name)}</a> "
            f"<span class='m'>{len(g.scans)} scans · {'합성됨' if g.has_merged else '미합성'}</span><br>"
            f"<span class='m'>{html.escape(scans)}</span></li>"
        )
    body = "".join(rows) or "<li class='m'>그룹이 없습니다. STUDIO_GROUPS_DIR 아래에 프로젝트 zip을 풀어 두세요.</li>"
    root = html.escape(str(groups.groups_root()))
    pub = html.escape(str(groups.publish_dir() or "(설정 안 됨: STUDIO_PUBLISH_DIR)"))
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>스캔 그룹</title>
<style>body{{font:15px/1.6 'IBM Plex Sans KR','Malgun Gothic',system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1C2024;background:#F3F4F0}}
h1{{font-size:20px}} li{{margin:10px 0;padding:10px 12px;border:1px solid #CFD4CF;background:#FBFBF8}} .m{{color:#68717A;font-size:13px;font-family:'IBM Plex Mono',Consolas,monospace}} a{{color:#2F7F74}}</style></head>
<body><h1>스캔 그룹</h1><p class="m">groups: {root}<br>publish: {pub}</p><ul>{body}</ul>
<p class="m">처음 열 때 스캔별 슬라이스를 만드느라 수십 초 걸릴 수 있습니다.</p></body></html>"""


@router.get("/groups/{name}", response_class=HTMLResponse)
def group_workspace(name: str) -> str:
    try:
        st = groups.group_status(name)
        if not st.ready:
            groups.prepare(name)
        return groups.workspace_html(name, api_base=f"/api/groups/{name}")
    except FileNotFoundError as exc:
        raise _404(exc)
