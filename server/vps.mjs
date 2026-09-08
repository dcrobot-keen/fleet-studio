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
import { Router } from 'express';

const SCAN_NAME_RE = /^[A-Za-z0-9_-]+$/;
const TIMEOUT_MS = 5000;

function upstreamError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 502, body: { error: `VPS 서버에 연결할 수 없습니다: ${msg}` } };
}

export async function createVpsRouter({ getServiceUrl }) {
  const router = Router();
  const base = () => getServiceUrl('vpsServer').replace(/\/+$/, '');

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
      res.status(upstream.status).json(await upstream.json().catch(() => ({})));
    } catch (err) {
      const { status, body } = upstreamError(err);
      res.status(status).json(body);
    }
  });

  return router;
}
