"""FastAPI wrapper around the existing scan-to-map-studio pipeline.

Run with:
    pip install -r requirements-server.txt
    python -m uvicorn server.app:app --reload --port 8000

This module only orchestrates HTTP <-> studio.*; all actual pipeline logic
lives in studio/ (pipeline.py, project.py, status.py), which has zero
dependency on FastAPI so the CLI/offline install path is unaffected.
"""
from __future__ import annotations

import asyncio
import io
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from studio.groups import groups_root, prepare as prepare_group
from studio.project import PROJECTS_ROOT, create_project, delete_project, list_projects
from studio.status import read_status, write_status
from server.align import align_geojson, align_image
from server.groups_api import router as groups_router
from server import schemas
from server.jobs import is_running, start_process_job

app = FastAPI(title="scan-to-map-studio API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(groups_router)  # scan groups + alignment workspace (studio/groups.py)



@app.on_event("startup")
def _reconcile_stale_jobs() -> None:
    """A server restart mid-job kills the background thread but leaves
    status.json saying phase="running" forever -- the UI would poll that
    stale file and show a spinner indefinitely. Flip any such project to
    an explicit error on startup instead."""
    if not PROJECTS_ROOT.exists():
        return
    for proj_dir in PROJECTS_ROOT.iterdir():
        if not proj_dir.is_dir():
            continue
        status = read_status(proj_dir)
        if status["phase"] == "running":
            write_status(
                proj_dir,
                phase="error",
                steps=status["steps"],
                log_line="서버 재시작으로 중단됨",
                error="interrupted by server restart",
            )


@app.get("/api/projects", response_model=list[schemas.ProjectEntry])
def api_list_projects() -> list[dict]:
    return list_projects()


@app.post("/api/projects", response_model=schemas.ProjectCreated)
def api_create_project(name: str = Form(...)) -> dict:
    try:
        create_project(name)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"name": name}


def _extract_scan_upload(
    name: str,
    project_dir: Path,
    uploads_dir: Path,
    filename: str,
    raw_bytes: bytes,
    is_zip: bool,
) -> dict:
    """압축 해제/디스크 쓰기 등 순수 동기 작업만 담당한다. 스캔 zip은 수백MB~1GB급이라 이 안의
    작업이 수십 초~몇 분 걸릴 수 있는데, 호출부(api_process_project)에서 asyncio.to_thread로
    돌려야 그 동안 이벤트 루프(서버 전체)가 멈추지 않는다 -- 예전엔 이걸 그대로 코루틴 안에서
    돌려서, 큰 zip을 올리면 이 요청뿐 아니라 서버의 다른 요청(다른 프로젝트 상태 조회 등)까지
    전부 응답이 끊긴 것처럼 보였다.
    반환: group zip이면 {"kind": "group", "response": {...}}(그대로 클라이언트에 반환),
    아니면 {"kind": "single", "usdz_path": ..., "trajectory_path": ...}
    (trajectory_path는 zip 안 poses.jsonl로 찾은 것 -- 별도 trajectory 필드가 오면 호출부에서 덮어씀).
    """
    if is_zip:
        try:
            with zipfile.ZipFile(io.BytesIO(raw_bytes)) as z:
                names = z.namelist()

                # 1) Multi-scan Project Group zip (contains group_alignment.json)
                align_names = [n for n in names if n.endswith("group_alignment.json")]
                if align_names:
                    group_dir = groups_root() / name
                    group_dir.mkdir(parents=True, exist_ok=True)

                    align_entry = align_names[0]
                    prefix = ""
                    if "/" in align_entry:
                        prefix = align_entry.rsplit("group_alignment.json", 1)[0]

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
                        prepare_group(name)
                    except Exception as exc:
                        print(f"[Warning] prepare_group({name}) during zip upload: {exc}")

                    return {
                        "kind": "group",
                        "response": {
                            "status": "group_ready",
                            "type": "group",
                            "group": name,
                            "group_url": f"/groups/{name}",
                            "message": f"다중 스캔 프로젝트 [{name}] 등록 완료 (정합 워크스페이스 준비됨)",
                        },
                    }

                # 2) Single Scan zip (contains scan.usdz or other files)
                root_folders = {n.split('/')[0] for n in names if '/' in n}
                prefix = ""
                if len(root_folders) == 1 and not any('/' not in n for n in names if not n.endswith('/')):
                    prefix = list(root_folders)[0] + "/"

                for item in z.infolist():
                    if item.is_dir():
                        continue
                    item_name = item.filename
                    rel_name = item_name[len(prefix):] if prefix and item_name.startswith(prefix) else item_name
                    rel_path = Path(rel_name)
                    if ".." in rel_path.parts:
                        continue
                    dest = uploads_dir / rel_path
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(z.read(item.filename))

                usdz_candidates = list(uploads_dir.glob("**/*.usdz")) + list(uploads_dir.glob("**/*.ply"))
                if not usdz_candidates:
                    raise HTTPException(status_code=400, detail="zip 파일 내에 .usdz 또는 .ply 스캔 모델이 없습니다.")
                usdz_path = usdz_candidates[0]

                # Check for floorplan.png and floorplan.json
                floorplan_pngs = list(uploads_dir.glob("**/floorplan.png"))
                floorplan_jsons = list(uploads_dir.glob("**/floorplan.json"))
                if floorplan_pngs and floorplan_jsons:
                    shutil.copyfile(floorplan_pngs[0], project_dir / "floorplan.png")
                    shutil.copyfile(floorplan_jsons[0], project_dir / "floorplan.json")

                # Check for poses inside the zip (an explicit trajectory upload takes priority; see caller)
                trajectory_path = None
                poses_files = list(uploads_dir.glob("**/poses.jsonl"))
                if poses_files:
                    trajectory_path = poses_files[0]
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail=f"손상된 zip 파일입니다: {exc}") from exc
    else:
        # Standard single usdz/ply upload
        usdz_path = uploads_dir / filename
        usdz_path.write_bytes(raw_bytes)
        trajectory_path = None

    return {"kind": "single", "usdz_path": usdz_path, "trajectory_path": trajectory_path}


@app.post("/api/projects/{name}/process", status_code=202, response_model=schemas.ProcessStarted)
async def api_process_project(
    name: str,
    usdz: UploadFile | None = File(None),
    scan_file: UploadFile | None = File(None),
    robot_map_pgm: UploadFile | None = File(None),
    robot_map_yaml: UploadFile | None = File(None),
    trajectory: UploadFile | None = File(None),
    remove_isolated_clusters: bool = Form(False),
    isolated_cluster_min_area: float = Form(0.3),
    classify: bool = Form(False),
) -> dict:
    file_to_process = scan_file if scan_file is not None else usdz
    if file_to_process is None:
        raise HTTPException(status_code=422, detail="scan_file 또는 usdz 파일이 필요합니다.")

    project_dir = PROJECTS_ROOT / name
    if not project_dir.exists():
        create_project(name)
    if is_running(name):
        raise HTTPException(status_code=409, detail=f"a processing job is already running for project {name!r}")

    uploads_dir = project_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    filename = file_to_process.filename or "scan.usdz"
    raw_bytes = await file_to_process.read()

    # Check if uploaded file is a zip archive
    is_zip = filename.lower().endswith(".zip") or (file_to_process.content_type and "zip" in file_to_process.content_type)
    result = await asyncio.to_thread(_extract_scan_upload, name, project_dir, uploads_dir, filename, raw_bytes, is_zip)
    if result["kind"] == "group":
        return result["response"]

    usdz_path = result["usdz_path"]
    trajectory_path = result["trajectory_path"]
    if trajectory is not None:
        trajectory_path = uploads_dir / "trajectory.json"
        trajectory_path.write_bytes(await trajectory.read())

    robot_map_prefix = None
    if robot_map_pgm is not None and robot_map_yaml is not None:
        pgm_path = uploads_dir / "robot_map.pgm"
        yaml_path = uploads_dir / "robot_map.yaml"
        pgm_path.write_bytes(await robot_map_pgm.read())
        yaml_path.write_bytes(await robot_map_yaml.read())
        robot_map_prefix = uploads_dir / "robot_map"

    try:
        start_process_job(
            name,
            project_dir,
            usdz_path,
            robot_map_prefix,
            trajectory_path,
            remove_isolated_clusters,
            isolated_cluster_min_area,
            classify,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "started",
        "type": "single",
        "name": name,
        "has_floorplan": (project_dir / "floorplan.png").exists(),
    }


@app.get("/api/projects/{name}/status", response_model=schemas.ProjectStatus)
def api_get_status(name: str) -> dict:
    project_dir = PROJECTS_ROOT / name
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail=f"project not found: {name}")
    return read_status(project_dir)


@app.delete("/api/projects/{name}", status_code=204)
def api_delete_project(name: str) -> None:
    if is_running(name):
        raise HTTPException(status_code=409, detail=f"a processing job is still running for project {name!r}")
    try:
        delete_project(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/projects/{name}/align/geojson")
async def api_align_geojson(name: str, geojson: UploadFile = File(...)) -> dict:
    project_dir = PROJECTS_ROOT / name
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail=f"project not found: {name}")
    return await align_geojson(name, project_dir, geojson)


@app.post("/api/projects/{name}/align/image")
async def api_align_image(name: str, image: UploadFile = File(...)) -> dict:
    project_dir = PROJECTS_ROOT / name
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail=f"project not found: {name}")
    return await align_image(name, project_dir, image)


# Serve every project's files (map.png, viewer.html, output.geojson, overlay.glb,
# report.json, ...) directly -- no route needed to shuttle large binaries
# through JSON. Mounted once at the root, not per-project, since a
# per-project mount would have to exist before the project's directory does.
PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=str(PROJECTS_ROOT)), name="files")
