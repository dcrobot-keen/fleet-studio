// 설정 › (지도 › "3D 텍스처" 탭)의 서버 쪽 -- dc-vps-digital-twin(SuGaR/3D Gaussian Splatting) 트랙이
// WSL에서 수동으로 학습해 만들어 둔 결과(data/results/<name>/)를 읽기 전용으로 보여준다. 학습 자체를
// 트리거하는 job runner는 아니다 -- 이미 끝난 학습 결과를 포인트클라우드 뷰어(.html)로 "포장"만 한다.
//
// dc-vps-digital-twin/data/results/<name>/ 은 scan-engine의 스캔/그룹 id와 연결되는 명명 규칙이 없다
// (사람이 CLI로 손수 만든 이름) -- 그래서 자동 매칭 없이 폴더 목록을 그대로 보여준다.
//
// 형제 저장소 경로는 simControl.mjs의 ROS_CHROMIUM_DIR과 같은 관례(DIGITAL_TWIN_DIR 환경변수, 기본값은
// pathfinder 저장소 기준 상대경로).
//
//   GET  /api/digital-twin/results                       -> { results: [{name, hasViewer, hasSource, sizeBytes}] }
//   GET  /api/digital-twin/results/:name/viewer           -> 있으면 그 viewer(.html) 그대로 서빙, 없으면 404
//   POST /api/digital-twin/results/:name/generate         -> make_point_cloud_viewer.py 실행(비동기), 202
//   GET  /api/digital-twin/results/:name/generate/status  -> { status: 'idle'|'running'|'done'|'error', error? }
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';

const DIGITAL_TWIN_DIR = process.env.DIGITAL_TWIN_DIR || '../dc-vps-digital-twin';
const NAME_RE = /^[A-Za-z0-9_.-]+$/; // 결과 폴더 이름 검증 -- 경로 순회 방지(실제 폴더명은 이미 이 모양)

async function listEntries(dir) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function findViewerFile(dir) {
  const entries = await listEntries(dir);
  const html = entries.find((e) => e.isFile() && extname(e.name).toLowerCase() === '.html');
  return html ? html.name : null;
}

/** sugarfine_*.obj 우선, 없으면 아무 .obj -- 같은 베이스이름의 .png 가 있는 것만 후보로 삼는다. */
async function findSourcePair(dir) {
  const entries = await listEntries(dir);
  const pngNames = new Set(entries.filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.png').map((e) => e.name));
  const objCandidates = entries
    .filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.obj')
    .map((e) => e.name)
    .filter((obj) => pngNames.has(obj.replace(/\.obj$/i, '.png')));
  if (objCandidates.length === 0) return null;
  const preferred = objCandidates.find((n) => n.startsWith('sugarfine_')) ?? objCandidates[0];
  return { obj: preferred, png: preferred.replace(/\.obj$/i, '.png') };
}

async function dirSizeBytes(dir) {
  const entries = await listEntries(dir);
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    total += await stat(join(dir, e.name)).then((s) => s.size).catch(() => 0);
  }
  return total;
}

export async function createDigitalTwinRouter({ repoRoot }) {
  const twinRoot = resolve(repoRoot, DIGITAL_TWIN_DIR);
  const resultsDir = resolve(twinRoot, 'data/results');
  const generating = new Map(); // name -> { status: 'running'|'done'|'error', error? }
  const router = Router();

  function resultDirFor(name) {
    if (!NAME_RE.test(name)) throw Object.assign(new Error('올바르지 않은 결과 이름입니다.'), { status: 400 });
    return join(resultsDir, name);
  }

  router.get('/digital-twin/results', async (req, res) => {
    const entries = await listEntries(resultsDir);
    const results = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const dir = join(resultsDir, e.name);
          const [viewer, source, sizeBytes] = await Promise.all([findViewerFile(dir), findSourcePair(dir), dirSizeBytes(dir)]);
          return { name: e.name, hasViewer: Boolean(viewer), hasSource: Boolean(source), sizeBytes };
        })
    );
    results.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ results });
  });

  router.get('/digital-twin/results/:name/viewer', async (req, res) => {
    try {
      const dir = resultDirFor(req.params.name);
      const viewer = await findViewerFile(dir);
      if (!viewer) {
        res.status(404).json({ error: '아직 뷰어가 없습니다 -- 먼저 생성하세요.' });
        return;
      }
      res.sendFile(join(dir, viewer));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  router.post('/digital-twin/results/:name/generate', async (req, res) => {
    try {
      const { name } = req.params;
      const dir = resultDirFor(name);
      const current = generating.get(name);
      if (current?.status === 'running') {
        res.status(409).json({ error: '이미 생성 중입니다.' });
        return;
      }
      const source = await findSourcePair(dir);
      if (!source) {
        res.status(400).json({ error: '원본 .obj/.png 쌍을 찾을 수 없습니다.' });
        return;
      }
      generating.set(name, { status: 'running' });
      const outputPath = join(dir, 'viewer.html');
      execFile(
        'python',
        ['make_point_cloud_viewer.py', join(dir, source.obj), join(dir, source.png), outputPath, '--title', name],
        { cwd: twinRoot, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) generating.set(name, { status: 'error', error: stderr?.trim().slice(-800) || err.message });
          else generating.set(name, { status: 'done' });
        }
      );
      res.status(202).json({ status: 'running' });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  router.get('/digital-twin/results/:name/generate/status', (req, res) => {
    try {
      resultDirFor(req.params.name); // 이름 검증만
      res.json(generating.get(req.params.name) ?? { status: 'idle' });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  return router;
}
