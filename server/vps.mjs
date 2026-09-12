// VPS 서버(vps-system, 별도 프로세스 -- SuperPoint/NetVLAD/LightGlue를 GPU에 상주시켜 두는 상시 서버)를
// 향한 얇은 프록시. CORS 미들웨어가 vps-system에 없어서 브라우저가 직접 못 부르므로, 읽기 호출까지
// 전부 여기를 거친다. 주소는 설정(data/settings.json)에서 매 요청마다 읽는다 -- vite 프록시처럼
// 개발서버 시작 시 고정하지 않는 이유는 vpsServer 주소가 화면에서 언제든 바뀌는 값이기 때문.
//
//   GET    /api/vps/health              -> { ok, error? } (업스트림이 죽어 있어도 항상 200 -- nav-health 핀이
//                                          "fetch가 안 던지면 up"만 보는 기존 로직을 그대로 타게 하려고)
//   GET    /api/vps/rooms               -> vps-system GET /rooms 패스스루: { rooms, frames }
//   DELETE /api/vps/rooms/:roomId       -> vps-system DELETE /rooms/{room_id} 패스스루
//   GET    /api/vps/scans/:scanName     -> vps-system GET /scans/{scan_name} 패스스루 (빌드 상태 폴링용)
//   POST   /api/vps/scans?scanName=&replace= -> 원본 zip을 그대로 vps-system POST /scans 로 스트리밍
//   GET    /api/vps/jobs                -> 이 프록시가 넘긴 빌드들의 진행 목록 (아래 참고)
//
// 빌드 진행 목록: vps-system 에는 "지금 무엇이 빌드 중인가"를 한 번에 주는 API 가 없고 scan_name 별 조회뿐이라,
// 여기서 넘긴 업로드를 기억해 두고 끝날 때까지 업스트림을 대신 폴링한다 -- 작업 드로어가 어느 화면에서든
// VPS 빌드 진행·실패를 보게 하려고. 메모리에만 두므로 Node 를 재시작하면 목록은 비지만 빌드 자체(vps-system
// 프로세스)는 계속 돌고, 정합 화면의 스캔 행 폴링(getVpsScanStatus)은 영향 없다.
import { Router } from 'express';

const SCAN_NAME_RE = /^[A-Za-z0-9_-]+$/;
const TIMEOUT_MS = 5000;
const JOB_POLL_MS = 3000;
const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 이 넘게 도는 빌드는 잃어버린 것으로 보고 폴링을 멈춘다
const JOB_KEEP = 50; // 끝난 것 포함 최근 N개만 유지
const TERMINAL = new Set(['done', 'failed']);

function upstreamError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 502, body: { error: `VPS 서버에 연결할 수 없습니다: ${msg}` } };
}

export async function createVpsRouter({ getServiceUrl }) {
  const router = Router();
  const base = () => getServiceUrl('vpsServer').replace(/\/+$/, '');

  /** @type {Map<string, { scanName: string, status: string, roomId: string|null, error: string|null, replace: boolean, startedAt: string, updatedAt: string, finishedAt: string|null }>} */
  const jobs = new Map();
  const timers = new Map();
  const nowIso = () => new Date().toISOString();

  function stopTracking(scanName) {
    const t = timers.get(scanName);
    if (t) { clearInterval(t); timers.delete(scanName); }
  }
  function trimJobs() {
    if (jobs.size <= JOB_KEEP) return;
    const finished = [...jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
    for (const j of finished.slice(0, jobs.size - JOB_KEEP)) jobs.delete(j.scanName);
  }
  function track(scanName, replace) {
    stopTracking(scanName); // 같은 이름을 다시 올리면 새 빌드 하나만 추적
    const job = { scanName, status: 'queued', roomId: null, error: null, replace, startedAt: nowIso(), updatedAt: nowIso(), finishedAt: null };
    jobs.set(scanName, job);
    trimJobs();
    const timer = setInterval(async () => {
      if (Date.now() - new Date(job.startedAt).getTime() > JOB_MAX_AGE_MS) {
        job.status = 'failed'; job.error = '24시간 넘게 끝나지 않아 추적을 멈췄습니다.'; job.finishedAt = job.updatedAt = nowIso();
        stopTracking(scanName);
        return;
      }
      try {
        const r = await fetch(`${base()}/scans/${encodeURIComponent(scanName)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) return; // 업스트림 일시 오류/재시작 -- 다음 tick 에 다시
        const s = await r.json();
        job.status = s.status ?? job.status;
        job.roomId = s.room_id ?? job.roomId;
        job.error = s.error ?? null;
        job.updatedAt = nowIso();
        if (TERMINAL.has(job.status)) { job.finishedAt = nowIso(); stopTracking(scanName); }
      } catch { /* 연결 실패는 다음 tick 에 재시도 */ }
    }, JOB_POLL_MS);
    timers.set(scanName, timer);
  }

  router.get('/vps/jobs', (req, res) => {
    const list = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    res.json({ jobs: list });
  });

  router.get('/vps/health', async (req, res) => {
    try {
      const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      res.json({ ok: r.ok });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/vps/rooms', async (req, res) => {
    try {
      const r = await fetch(`${base()}/rooms`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      res.status(r.status).json(await r.json());
    } catch (err) {
      const { status, body } = upstreamError(err);
      res.status(status).json(body);
    }
  });

  router.delete('/vps/rooms/:roomId', async (req, res) => {
    try {
      const r = await fetch(`${base()}/rooms/${encodeURIComponent(req.params.roomId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    } catch (err) {
      const { status, body } = upstreamError(err);
      res.status(status).json(body);
    }
  });

  router.get('/vps/scans/:scanName', async (req, res) => {
    try {
      const r = await fetch(`${base()}/scans/${encodeURIComponent(req.params.scanName)}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    } catch (err) {
      const { status, body } = upstreamError(err);
      res.status(status).json(body);
    }
  });

  // 업로드는 시간이 걸릴 수 있어(1~2GB) 짧은 TIMEOUT_MS를 안 씀 -- vps-system 쪽이 큐잉되면 즉시 202를
  // 주므로 실제로는 몇 초 안에 끝난다.
  router.post('/vps/scans', async (req, res) => {
    const scanName = String(req.query.scanName ?? '');
    if (!SCAN_NAME_RE.test(scanName)) {
      res.status(400).json({ error: 'scanName은 영문/숫자/-/_ 만 허용됩니다.' });
      return;
    }
    const replace = req.query.replace === 'true';
    try {
      const upstream = await fetch(
        `${base()}/scans?scan_name=${encodeURIComponent(scanName)}&replace=${replace}`,
        { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: req, duplex: 'half' }
      );
      if (upstream.status === 202) track(scanName, replace); // 큐에 들어갔으면 끝날 때까지 대신 지켜본다
      res.status(upstream.status).json(await upstream.json().catch(() => ({})));
    } catch (err) {
      const { status, body } = upstreamError(err);
      res.status(status).json(body);
    }
  });

  return router;
}
