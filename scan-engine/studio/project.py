"""Project-folder lifecycle: create and enumerate `projects/<name>/`.

`create_project` is `cmd_new`'s body (scripts/studio.py), moved here so both
the CLI and the API call the same function. `list_projects` is net-new --
nothing enumerated `projects/` before this.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from studio.status import read_status

PROJECTS_ROOT = Path(__file__).resolve().parent.parent / "projects"


def create_project(name: str) -> Path:
    """Create an empty project folder (projects/<name>/map/). Raises
    FileExistsError if it already exists -- callers decide how to surface
    that (the CLI prints and returns, the API returns 409)."""
    proj_dir = PROJECTS_ROOT / name
    if proj_dir.exists():
        raise FileExistsError(f"project already exists: {proj_dir}")
    (proj_dir / "map").mkdir(parents=True)
    return proj_dir


def delete_project(name: str) -> None:
    """Remove projects/<name>/ entirely. Raises FileNotFoundError if it doesn't exist --
    the API layer checks is_running() first so this never races a job writing into it."""
    proj_dir = PROJECTS_ROOT / name
    if not proj_dir.exists():
        raise FileNotFoundError(f"project not found: {proj_dir}")
    shutil.rmtree(proj_dir)


def list_projects() -> list[dict]:
    """Enumerate projects/*, newest first.

    Projects processed via the API have a status.json (studio.status) that's
    authoritative. Projects created by earlier/plain CLI runs (e.g.
    projects/officescan, predating status.json entirely) never get one --
    for those, fall back to "done" if report.html exists (the CLI's last
    pipeline step), else "needs-attention" (a project folder exists but was
    never successfully processed).
    """
    if not PROJECTS_ROOT.exists():
        return []

    entries = []
    for proj_dir in PROJECTS_ROOT.iterdir():
        if not proj_dir.is_dir():
            continue
        status = read_status(proj_dir)
        if status["phase"] is not None:
            phase = status["phase"]
        elif (proj_dir / "report.html").exists():
            phase = "done"
        else:
            phase = "needs-attention"

        entries.append(
            {
                "name": proj_dir.name,
                "phase": phase,
                "steps": status["steps"],
                "error": status["error"],
                "mtime": proj_dir.stat().st_mtime,
            }
        )

    entries.sort(key=lambda e: e["mtime"], reverse=True)
    return entries
