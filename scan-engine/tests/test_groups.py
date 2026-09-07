"""Validation for studio/groups.py and server/groups_api.py: a group directory
laid out like the app's project zip, prepared slices, workspace page with
server API, save -> merged slicemap + publish, ICP finisher. Uses the
synthetic overlapping pair so nothing depends on real scans or the pipeline.
Run directly:
    python tests/test_groups.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio.merge_slicemaps import GroupAlignment, ScanAlignment, save_group_alignment, save_slice
from studio.synthetic_overlap import make_pair


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    print(f"  ok  {msg}")


TRUTH = ScanAlignment(offsetX=2.0, offsetZ=-1.0, yawRadians=math.radians(25.0))
GUESS = ScanAlignment(offsetX=2.12, offsetZ=-1.08, yawRadians=math.radians(27.0), method="app")


def make_group(root: Path, name: str = "demo") -> Path:
    a, b = make_pair(TRUTH)
    g = root / name
    (g / "scan_A").mkdir(parents=True)
    (g / "scan_B").mkdir()
    save_slice(g / "scan_A.slicemap.json", a)
    save_slice(g / "scan_B.slicemap.json", b)
    save_group_alignment(g / "group_alignment.json", GroupAlignment(reference="scan_A", alignments={"scan_B": GUESS}, group=name))
    return g


def test_library() -> None:
    from studio import groups

    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "groups"
        publish = Path(td) / "worlds"
        make_group(root)
        st = groups.list_groups(root)
        check(len(st) == 1 and st[0].name == "demo" and st[0].ready, "group discovered and ready (slices present)")
        check([s.id for s in st[0].scans] == ["scan_A", "scan_B"], "reference first, then the others")
        check(st[0].scans[1].method == "app", "scan method comes from the alignment file")

        html = groups.workspace_html("demo", api_base="/api/groups/demo", root=root)
        check('"save": "/api/groups/demo/alignment"' in html and '"icp": "/api/groups/demo/icp"' in html, "workspace page carries the server API")
        offline = groups.workspace_html("demo", api_base=None, root=root)
        check('"api": null' in offline, "offline page has no API")

        doc = json.loads((root / "demo/group_alignment.json").read_text(encoding="utf-8"))
        doc["alignments"]["scan_B"].update({"offsetX": TRUTH.offsetX, "offsetZ": TRUTH.offsetZ, "yawRadians": TRUTH.yawRadians, "method": "pins", "approved": True})
        res = groups.save_alignment("demo", doc, root=root, publish=publish)
        check((root / "demo/merged.slicemap.json").exists() and (root / "demo/merged.png").exists(), "save writes merged slicemap + png")
        check(Path(res["published"]).exists() and res["published"].endswith("demo.slicemap.json"), "save publishes the merged slicemap")
        check(res["approved"] == ["scan_B"] and res["pending"] == [], "approval bookkeeping in the summary")
        saved = json.loads((root / "demo/group_alignment.json").read_text(encoding="utf-8"))
        check(saved["alignments"]["scan_B"]["method"] == "pins", "alignment file rewritten with the page's values")

        # 저장 기록: 매 save_alignment 호출은 "그 직전" 파일을 .history/ 에 스냅샷해야 -- 잘못
        # 저장해도 몇 걸음 전 상태로 돌아갈 수 있다(정합 워크스페이스에 되돌리기 안전망이 없다는
        # 사용자 피드백으로 추가됨).
        hist = groups.list_alignment_history("demo", root=root)
        check(len(hist) == 1, f"first save snapshots the pre-save (GUESS) state -- {len(hist)} entries")
        check(hist[0]["approved"] == [], "snapshot reflects the state before approval, not after")
        entry = groups.get_alignment_history_entry("demo", hist[0]["timestamp"], root=root)
        check(entry["alignments"]["scan_B"]["method"] == "app", "history entry is the exact pre-save document (still GUESS/'app')")

        doc2 = json.loads((root / "demo/group_alignment.json").read_text(encoding="utf-8"))
        doc2["alignments"]["scan_B"]["offsetX"] += 0.5
        groups.save_alignment("demo", doc2, root=root, publish=publish)
        hist2 = groups.list_alignment_history("demo", root=root)
        check(len(hist2) == 2 and hist2[0]["timestamp"] > hist2[1]["timestamp"], "second save adds a newer snapshot, newest first")

        try:
            groups.save_alignment("demo", {"format": "nope"}, root=root, publish=publish)
            check(False, "bad document rejected")
        except ValueError:
            check(True, "bad document rejected")

        icp = groups.icp_refine("demo", "scan_B", {"offsetX": GUESS.offsetX, "offsetZ": GUESS.offsetZ, "yawRadians": GUESS.yawRadians}, root=root)
        err = math.hypot(icp["alignment"]["offsetX"] - TRUTH.offsetX, icp["alignment"]["offsetZ"] - TRUTH.offsetZ)
        print(f"      icp: before {icp['before']}  after {icp['after']}  err {err*100:.1f} cm, {math.degrees(icp['alignment']['yawRadians'] - TRUTH.yawRadians):+.2f} deg")
        check(err < 0.05 and abs(icp["alignment"]["yawRadians"] - TRUTH.yawRadians) < math.radians(1), "ICP from a 12 cm / 2 deg guess lands within 5 cm / 1 deg of truth")
        check(icp["after"]["inlier"] >= icp["before"]["inlier"], "ICP does not reduce inlier on the synthetic pair")


def test_api() -> None:
    from fastapi.testclient import TestClient

    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "groups"
        publish = Path(td) / "worlds"
        make_group(root)
        os.environ["STUDIO_GROUPS_DIR"] = str(root)
        os.environ["STUDIO_PUBLISH_DIR"] = str(publish)
        try:
            from server.app import app

            c = TestClient(app)
            r = c.get("/api/groups")
            check(r.status_code == 200 and r.json()[0]["name"] == "demo", "GET /api/groups lists the group")
            r = c.get("/groups")
            check(r.status_code == 200 and "/groups/demo" in r.text, "GET /groups index links to the workspace")
            r = c.get("/groups/demo")
            check(r.status_code == 200 and "/api/groups/demo/alignment" in r.text, "GET /groups/demo serves the workspace with the API wired")
            doc = c.get("/api/groups/demo/alignment").json()
            doc["alignments"]["scan_B"]["approved"] = True
            r = c.put("/api/groups/demo/alignment", json=doc)
            check(r.status_code == 200 and r.json()["published"], "PUT alignment saves, merges and publishes")
            r = c.get("/api/groups/demo/merged.png")
            check(r.status_code == 200 and r.headers["content-type"] == "image/png", "merged preview is served")
            r = c.post("/api/groups/demo/icp", json={"scan": "scan_B", "alignment": doc["alignments"]["scan_B"]})
            check(r.status_code == 200 and "after" in r.json(), "POST icp returns a refined pose with metrics")
            r = c.put("/api/groups/demo/alignment", json={"format": "x"})
            check(r.status_code == 422, "invalid alignment -> 422")
            check(c.get("/api/groups/nope").status_code == 404, "unknown group -> 404")

            r = c.get("/api/groups/demo/alignment/history")
            check(r.status_code == 200 and len(r.json()) == 1, "GET alignment history lists the one snapshot from the PUT above")
            ts = r.json()[0]["timestamp"]
            r = c.get(f"/api/groups/demo/alignment/history/{ts}")
            check(r.status_code == 200 and "scan_B" in r.json()["alignments"], "GET one history entry returns the full document")
            check(c.get("/api/groups/demo/alignment/history/nope").status_code == 404, "unknown history timestamp -> 404")

            # Test POST /api/groups/upload with a zip archive
            import io
            import zipfile
            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, "w") as z:
                z.writestr("group_alignment.json", json.dumps({"format": "scan-group-alignment-v1", "group": "uploaded_group", "reference": "scan_1", "alignments": {}}))
                z.writestr("scan_1/dummy.txt", "hello")
            zip_buf.seek(0)
            upload_res = c.post("/api/groups/upload", files={"file": ("uploaded_group.zip", zip_buf.getvalue(), "application/zip")})
            check(upload_res.status_code == 200 and upload_res.json()["group"] == "uploaded_group", "POST /api/groups/upload unpacks group zip")
        finally:
            os.environ.pop("STUDIO_GROUPS_DIR", None)
            os.environ.pop("STUDIO_PUBLISH_DIR", None)


if __name__ == "__main__":
    for t in [test_library, test_api]:
        print(t.__name__)
        t()
    print("all groups checks passed")
