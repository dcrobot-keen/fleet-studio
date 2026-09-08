// 지도 › 정합 워크스페이스의 "🧬 학습" 버튼 서버 쪽 -- 원본 스캔을 골라 누르면
//   COLMAP 포즈 정제(WSL) -> SuGaR 학습(WSL, GPU) -> 결과 복사 -> 뷰어 자동 생성(digitalTwin.mjs 재사용)
// 까지 전부 백그라운드로 돈다. 총 1~2시간+ 걸리는 작업이라, scan-engine의 jobs.py(같은 프로세스·초 단위
// 작업 전제, 재시작하면 무조건 "죽었다"고 간주)와 달리 **Node 재시작에도 살아남아야** 한다:
//   - 진행상황은 lowdb(data/digital-twin-jobs.json)에 저장(steno 어댑터가 원자적 쓰기를 이미 해줌).
//   - WSL 자식 프로세스의 Windows PID를 기록해두고, process.kill(pid, 0)으로 생존 여부를 확인한다
//     (실측: wsl.exe의 Windows PID는 실제 WSL 명령 생존기간과 정확히 일치함 -- 이 설계의 전제).
//   - 상태 전이는 로그 파일에 스크립트가 남기는 ##STAGE##/##STEP##/##JOB_STAGE_DONE##/##JOB_ERROR##/
//     ##JOB_ALL_DONE## 문구를 3초마다 훑어서 감지한다 -- 방금 이 프로세스가 띄운 job이든, 재시작 후
//     다시 붙은(reattach) job이든 완전히 같은 코드 경로로 처리된다.
//   - GPU(학습 단계)는 한 번에 하나만: 인메모리 락 + FIFO 큐. COLMAP 단계(CPU)는 여러 스캔이 동시에 돌아도 됨.
//
//   GET  /api/digital-twin/train/scans            -> { scans: [{id, group, dir, imageCount}] }
//   POST /api/digital-twin/train  {scanId, polyMode?, refinementTime?} -> 202 { jobId, name }
//   GET  /api/digital-twin/train/:jobId/status     -> job 레코드 하나
//   GET  /api/digital-twin/train                   -> { jobs: [...최신순] }
import { Router } from 'express';
import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { JSONFilePreset } from 'lowdb/node';
import { resolveTwinRoot, generateViewer } from './digitalTwin.mjs';

const execFileP = promisify(execFile);

const VPS_SYSTEM_DIR = process.env.VPS_SYSTEM_DIR || '../vps-system';
const WSL_DISTRO = process.env.WSL_DISTRO || 'Ubuntu-22.04';
const SCAN_ID_RE = /^[A-Za-z0-9_.-]+$/;
const TAIL_MS = 3000;

const STAGE_LABEL = {
  colmap_convert: 'COLMAP 변환',
  colmap_running: 'COLMAP 처리 중',
  waiting_gpu: 'GPU 대기 중',
  training_running: 'SuGaR 학습 중',
  finalizing: '뷰어 생성 중',
  done: '완료',
  error: '오류',
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function nowIso() {
  return new Date().toISOString();
}

function timestampTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** D:\foo\bar -> /mnt/d/foo/bar (wsl.exe에 넘길 경로). */
function toWslPath(winPath) {
  const posix = resolve(winPath).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(posix);
  if (!m) throw new Error(`WSL 경로로 바꿀 수 없습니다: ${winPath}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hasPoses(dir) {
  return open(join(dir, 'poses', 'poses.jsonl'), 'r')
    .then((fh) => fh.close().then(() => true))
    .catch(() => false);
}

/** vps-system/data 를 1단계(단일 스캔)·2단계(그룹/스캔) 둘 다 훑어 poses.jsonl 있는 폴더만 모은다. */
async function listTrainableScans(vpsDataDir) {
  const scans = [];
  const level1 = await readdir(vpsDataDir, { withFileTypes: true }).catch(() => []);
  for (const e1 of level1) {
    if (!e1.isDirectory()) continue;
    const dir1 = join(vpsDataDir, e1.name);
    if (await hasPoses(dir1)) {
      scans.push({ id: e1.name, group: null, dir: dir1 });
      continue;
    }
    const level2 = await readdir(dir1, { withFileTypes: true }).catch(() => []);
    for (const e2 of level2) {
      if (!e2.isDirectory()) continue;
      const dir2 = join(dir1, e2.name);
      if (await hasPoses(dir2)) scans.push({ id: e2.name, group: e1.name, dir: dir2 });
    }
  }
  for (const s of scans) {
    s.imageCount = await readdir(join(s.dir, 'rgb')).then((files) => files.length).catch(() => 0);
  }
  scans.sort((a, b) => a.id.localeCompare(b.id));
  return scans;
}

function colmapScriptContent({ logWsl, outputColmapWsl, scanWsl, datasetWsl }) {
  return `#!/usr/bin/env bash
set -e
set -o pipefail
LOG=${logWsl}
trap 'echo "##JOB_ERROR## exit_code=$? at line $LINENO: $BASH_COMMAND" >> "$LOG"' ERR

command -v colmap >/dev/null || { echo "##JOB_ERROR## colmap이 WSL PATH에 없습니다" >> "$LOG"; exit 1; }

echo "##STAGE## colmap_running" >> "$LOG"
cd "${outputColmapWsl}"

echo "##STEP## feature_extractor" >> "$LOG"
colmap feature_extractor --database_path database.db --image_path images \\
  --SiftExtraction.use_gpu 0 --ImageReader.single_camera_per_image 1 >> "$LOG" 2>&1

echo "##STEP## exhaustive_matcher" >> "$LOG"
colmap exhaustive_matcher --database_path database.db --SiftMatching.use_gpu 0 >> "$LOG" 2>&1

echo "##STEP## build_known_pose_model" >> "$LOG"
source ~/miniconda3/etc/profile.d/conda.sh
conda activate sugar
python /mnt/d/code/robot-project/dc-vps-digital-twin/build_known_pose_model.py \\
  "${scanWsl}" database.db sparse/0 >> "$LOG" 2>&1

echo "##STEP## point_triangulator" >> "$LOG"
mkdir -p sparse/refined_points
colmap point_triangulator --database_path database.db --image_path images \\
  --input_path sparse/0 --output_path sparse/refined_points >> "$LOG" 2>&1

echo "##STEP## bundle_adjuster" >> "$LOG"
mkdir -p sparse/refined
colmap bundle_adjuster --input_path sparse/refined_points --output_path sparse/refined \\
  --BundleAdjustment.refine_focal_length 0 --BundleAdjustment.refine_principal_point 0 \\
  --BundleAdjustment.refine_extra_params 0 >> "$LOG" 2>&1

echo "##STEP## model_converter" >> "$LOG"
colmap model_converter --input_path sparse/refined --output_path sparse/refined --output_type TXT >> "$LOG" 2>&1

echo "##STEP## copy_to_dataset" >> "$LOG"
mkdir -p "${datasetWsl}/sparse"
rm -rf "${datasetWsl}/images" "${datasetWsl}/sparse/0"
cp -r images "${datasetWsl}/images"
cp -r sparse/refined "${datasetWsl}/sparse/0"

echo "##JOB_STAGE_DONE## colmap" >> "$LOG"
`;
}

function trainScriptContent({ logWsl, datasetWsl, resultWsl, name, polyMode, refinementTime }) {
  const polyFlag = polyMode === 'high' ? 'high_poly' : 'low_poly';
  return `#!/usr/bin/env bash
set -e
set -o pipefail
LOG=${logWsl}
trap 'echo "##JOB_ERROR## exit_code=$? at line $LINENO: $BASH_COMMAND" >> "$LOG"' ERR

source ~/miniconda3/etc/profile.d/conda.sh
conda activate sugar

echo "##STAGE## training_running" >> "$LOG"
python -c "import torch; assert torch.cuda.is_available()" >> "$LOG" 2>&1 \\
  || { echo "##JOB_ERROR## sugar conda 환경 또는 CUDA를 쓸 수 없습니다" >> "$LOG"; exit 1; }

cd ~/SuGaR
python train_full_pipeline.py -s "${datasetWsl}" -r dn_consistency \\
  --${polyFlag} True --refinement_time ${refinementTime} --export_obj True --eval True >> "$LOG" 2>&1

echo "##STEP## copy_result" >> "$LOG"
mkdir -p "${resultWsl}"
cp ~/SuGaR/output/refined_mesh/${name}/sugarfine_*.obj "${resultWsl}"/ >> "$LOG" 2>&1
cp ~/SuGaR/output/refined_mesh/${name}/sugarfine_*.mtl "${resultWsl}"/ >> "$LOG" 2>&1
cp ~/SuGaR/output/refined_mesh/${name}/sugarfine_*.png "${resultWsl}"/ >> "$LOG" 2>&1

echo "##STEP## cleanup_dataset" >> "$LOG"
rm -rf "${datasetWsl}"

echo "##JOB_ALL_DONE##" >> "$LOG"
`;
}

export async function createDigitalTwinTrainingRouter({ repoRoot, dataDir }) {
  const twinRoot = resolveTwinRoot(repoRoot);
  const vpsDataDir = resolve(repoRoot, VPS_SYSTEM_DIR, 'data');
  const jobsDir = resolve(dataDir, 'digital-twin-jobs');
  await mkdir(jobsDir, { recursive: true });

  const db = await JSONFilePreset(resolve(dataDir, 'digital-twin-jobs.json'), { jobs: {}, gpuQueue: [] });
  const tailers = new Map(); // name -> IntervalID
  let gpuBusy = false;

  function scriptPaths(name) {
    return {
      colmapSh: join(jobsDir, `${name}-colmap.sh`),
      trainSh: join(jobsDir, `${name}-train.sh`),
      log: join(jobsDir, `${name}.log`),
    };
  }

  function stopTailer(name) {
    const t = tailers.get(name);
    if (t) {
      clearInterval(t);
      tailers.delete(name);
    }
  }

  async function readLogSince(logPath, offset) {
    let fh;
    try {
      fh = await open(logPath, 'r');
      const st = await fh.stat();
      if (st.size <= offset) return { text: '', newOffset: offset };
      const len = st.size - offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      return { text: buf.toString('utf-8'), newOffset: st.size };
    } catch {
      return { text: '', newOffset: offset };
    } finally {
      await fh?.close();
    }
  }

  function tryStartNextTraining() {
    if (gpuBusy) return;
    const nextName = db.data.gpuQueue.shift();
    if (!nextName) return;
    const job = db.data.jobs[nextName];
    if (!job) {
      tryStartNextTraining();
      return;
    }
    startTrainStage(nextName, job);
  }

  function releaseGpuAndAdvanceQueue() {
    gpuBusy = false;
    tryStartNextTraining();
  }

  async function markError(name, job, message) {
    const wasTraining = job.stage === 'training_running';
    job.phase = 'error';
    job.stage = 'error';
    job.error = message;
    job.pid = null;
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    await db.write();
    stopTailer(name);
    if (wasTraining) releaseGpuAndAdvanceQueue();
  }

  async function finalizeJob(name, job) {
    job.stage = 'finalizing';
    job.pid = null;
    job.updatedAt = nowIso();
    await db.write();
    const resultDir = resolve(twinRoot, 'data/results', name);
    try {
      const entries = await readdir(resultDir, { withFileTypes: true }).catch(() => []);
      const objFile = entries.find((e) => e.isFile() && /\.obj$/i.test(e.name));
      if (objFile) {
        const pngFile = objFile.name.replace(/\.obj$/i, '.png');
        await generateViewer({
          twinRoot,
          obj: join(resultDir, objFile.name),
          png: join(resultDir, pngFile),
          output: join(resultDir, 'viewer.html'),
          title: name,
        });
      }
    } catch (err) {
      // 뷰어 자동 생성 실패는 학습 자체의 실패로 안 침 -- mesh는 이미 안전히 복사됐고, "3D 텍스처" 탭에서
      // 수동 "뷰어 만들기"로 언제든 재시도할 수 있다.
      job.log = [...(job.log ?? []), `뷰어 자동 생성 실패(무시, 나중에 3D 텍스처 탭에서 수동 생성 가능): ${err.message}`].slice(-300);
    }
    job.stage = 'done';
    job.phase = 'done';
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    await db.write();
    stopTailer(name);
    releaseGpuAndAdvanceQueue();
  }

  async function startTrainStage(name, job) {
    gpuBusy = true;
    job.stage = 'training_running';
    job.updatedAt = nowIso();
    await db.write();

    const { trainSh, log } = scriptPaths(name);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      trainSh,
      trainScriptContent({
        logWsl: toWslPath(log),
        // 주의: 이 값은 생성된 bash 스크립트 안에서 항상 큰따옴표로 감싸 쓴다(colmap/train 스크립트 템플릿) --
        // "~/datasets/..." 처럼 따옴표 안의 ~ 는 bash가 확장해주지 않는다(실측으로 발견한 버그).
        // $HOME 은 변수 확장이라 따옴표 안에서도 정상 동작하므로 반드시 $HOME 을 쓴다.
        datasetWsl: `$HOME/datasets/${name}`,
        resultWsl: toWslPath(resolve(twinRoot, 'data/results', name)),
        name,
        polyMode: job.options.polyMode,
        refinementTime: job.options.refinementTime,
      }),
      'utf-8'
    );
    // detached + unref 필수: 안 하면 이 Node 프로세스가 죽을 때 wsl.exe 자식까지 같이 죽는다(실측 확인됨) --
    // 그러면 재시작 후 pid로 재부착한다는 설계 전체가 무의미해진다.
    const child = spawn('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', toWslPath(trainSh)], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (err) => markError(name, job, `WSL을 시작할 수 없습니다: ${err.message}`));
    job.pid = child.pid;
    await db.write();
    startTailer(name);
  }

  function startTailer(name) {
    if (tailers.has(name)) return;
    const timer = setInterval(() => tick(name).catch(() => {}), TAIL_MS);
    tailers.set(name, timer);
  }

  async function tick(name) {
    const job = db.data.jobs[name];
    if (!job) {
      stopTailer(name);
      return;
    }
    if (job.phase !== 'running') {
      stopTailer(name);
      return;
    }

    const { log: logPath } = scriptPaths(name);
    const { text, newOffset } = await readLogSince(logPath, job.readOffset ?? 0);
    job.readOffset = newOffset;

    if (text) {
      const newLines = text.split(/\r?\n/).filter(Boolean);
      job.log = [...(job.log ?? []), ...newLines].slice(-300);

      const errMatch = /##JOB_ERROR##[^\n]*/.exec(text);
      if (errMatch) {
        await markError(name, job, errMatch[0].replace(/^##JOB_ERROR##\s*/, ''));
        return;
      }
      if (job.stage === 'colmap_running' && text.includes('##JOB_STAGE_DONE## colmap')) {
        job.stage = 'waiting_gpu';
        job.pid = null;
        job.updatedAt = nowIso();
        db.data.gpuQueue.push(name);
        await db.write();
        tryStartNextTraining();
        return;
      }
      if (job.stage === 'training_running' && text.includes('##JOB_ALL_DONE##')) {
        await finalizeJob(name, job);
        return;
      }
    }

    if ((job.stage === 'colmap_running' || job.stage === 'training_running') && job.pid) {
      if (!isPidAlive(job.pid)) {
        await markError(name, job, `프로세스가 예기치 않게 종료됐습니다 (pid ${job.pid}).`);
        return;
      }
    }
    job.updatedAt = nowIso();
    await db.write();
  }

  // ---- 재시작 복구: running 상태인 job을 pid 생존 여부로 재부착하거나 error 처리 ----
  for (const [name, job] of Object.entries(db.data.jobs)) {
    if (job.phase !== 'running') continue;
    // waiting_gpu/finalizing은 원래 이 시점에 살아있는 WSL 프로세스가 없는 게 정상(GPU 대기 중이거나
    // Node 안에서 뷰어를 만드는 중) -- pid 생존 여부로 판단하면 안 되고, 그냥 이어서 하면 된다.
    if (job.stage === 'waiting_gpu') {
      db.data.gpuQueue.push(name);
      continue;
    }
    if (job.stage === 'finalizing') {
      finalizeJob(name, job);
      continue;
    }
    if (job.pid && isPidAlive(job.pid)) {
      if (job.stage === 'training_running') gpuBusy = true;
      startTailer(name);
    } else {
      // pid가 없거나(전이 중이었음) 죽어있음 -- 로그에 완료 마커가 이미 있었는지 한 번 더 확인
      const { log: logPath } = scriptPaths(name);
      const { text } = await readLogSince(logPath, 0);
      if (job.stage === 'training_running' && text.includes('##JOB_ALL_DONE##')) {
        finalizeJob(name, job);
      } else if (job.stage === 'colmap_running' && text.includes('##JOB_STAGE_DONE## colmap')) {
        job.stage = 'waiting_gpu';
        db.data.gpuQueue.push(name);
      } else {
        job.phase = 'error';
        job.stage = 'error';
        job.error = '서버 재시작 중 프로세스가 사라짐 -- 중단된 것으로 처리';
        job.pid = null;
        job.finishedAt = nowIso();
      }
    }
  }
  await db.write();
  tryStartNextTraining();

  const router = Router();

  router.get('/digital-twin/train/scans', async (req, res) => {
    res.json({ scans: await listTrainableScans(vpsDataDir) });
  });

  router.post('/digital-twin/train', async (req, res) => {
    try {
      const { scanId, polyMode = 'low', refinementTime = 'short' } = req.body ?? {};
      if (!['low', 'high'].includes(polyMode)) throw badRequest('polyMode은 low 또는 high여야 합니다.');
      if (!['short', 'medium', 'long'].includes(refinementTime)) throw badRequest('refinementTime은 short/medium/long이어야 합니다.');
      if (typeof scanId !== 'string' || !SCAN_ID_RE.test(scanId)) throw badRequest('올바르지 않은 scanId입니다.');

      const existing = Object.values(db.data.jobs).find((j) => j.scanId === scanId && j.phase === 'running');
      if (existing) throw Object.assign(new Error('이 스캔은 이미 학습 중입니다.'), { status: 409 });

      const scans = await listTrainableScans(vpsDataDir);
      const scan = scans.find((s) => s.id === scanId);
      if (!scan) throw badRequest(`알 수 없는 스캔입니다: ${scanId}`);

      const name = `${scanId}_${timestampTag()}`;
      const outputColmapDir = resolve(twinRoot, 'data/output_colmap', name);
      await mkdir(outputColmapDir, { recursive: true });

      // 1단계: Windows, 동기(빠름) -- 나쁜 스캔(프레임 부족 등)은 여기서 바로 400으로 알 수 있게.
      try {
        await execFileP('python', ['convert_to_colmap.py', scan.dir, outputColmapDir], {
          cwd: twinRoot,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (err) {
        throw badRequest(`스캔 변환 실패: ${err.stderr?.trim().slice(-500) || err.message}`);
      }

      const record = {
        name,
        scanId,
        scanDir: scan.dir,
        options: { polyMode, refinementTime },
        stage: 'colmap_running',
        phase: 'running',
        pid: null,
        readOffset: 0,
        startedAt: nowIso(),
        updatedAt: nowIso(),
        finishedAt: null,
        log: [],
        error: null,
      };
      db.data.jobs[name] = record;
      await db.write();

      const { colmapSh, log } = scriptPaths(name);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        colmapSh,
        colmapScriptContent({
          logWsl: toWslPath(log),
          outputColmapWsl: toWslPath(outputColmapDir),
          scanWsl: toWslPath(scan.dir),
          datasetWsl: `$HOME/datasets/${name}`, // 따옴표 안 ~ 는 bash가 확장 안 해줌 -- $HOME 사용 (startTrainStage 쪽 주석 참고)
        }),
        'utf-8'
      );
      const child = spawn('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', toWslPath(colmapSh)], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      child.on('error', (err) => markError(name, record, `WSL을 시작할 수 없습니다: ${err.message}`));
      record.pid = child.pid;
      await db.write();
      startTailer(name);

      res.status(202).json({ jobId: name, name });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  router.get('/digital-twin/train/:jobId/status', (req, res) => {
    const job = db.data.jobs[req.params.jobId];
    if (!job) {
      res.status(404).json({ error: 'job을 찾을 수 없습니다.' });
      return;
    }
    res.json(withDerived(job));
  });

  router.get('/digital-twin/train', (req, res) => {
    const jobs = Object.values(db.data.jobs)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(withDerived);
    res.json({ jobs });
  });

  function withDerived(job) {
    const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
    const elapsedMs = end - new Date(job.startedAt).getTime();
    const queuePosition = job.stage === 'waiting_gpu' ? db.data.gpuQueue.indexOf(job.name) + 1 : undefined;
    return { ...job, log: (job.log ?? []).slice(-50), stageLabel: STAGE_LABEL[job.stage] ?? job.stage, elapsedMs, queuePosition };
  }

  return router;
}
