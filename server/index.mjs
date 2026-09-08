// 노드/링크/블록 편집 결과를 GeoJSON 파일 DB(lowdb)에 저장하는 초경량 API 서버.
// 편집 데이터는 프로젝트별로 나뉜다 -- projects.mjs 참고. "기본" 프로젝트는
// 예전부터 있던 data/nodelink.geojson을 그대로 쓰므로, 이 파일은 여전히
// QGIS 등 다른 GIS 툴에서 바로 열리는 유효한 GeoJSON FeatureCollection이다.
import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRobotModelsRouter } from './robotModels.mjs';
import { createRobotsRouter } from './robots.mjs';
import { createProjectsRouter } from './projects.mjs';
import { createSettingsRouter } from './settings.mjs';
import { createSimControlRouter } from './simControl.mjs';
import { createVpsRouter } from './vps.mjs';
import { createDigitalTwinRouter } from './digitalTwin.mjs';
import { createDigitalTwinTrainingRouter } from './digitalTwinTraining.mjs';
import { createVda5050Bridge } from './vda5050.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPORTED_DIR = resolve(__dirname, '../data/imported');
// projects.mjs와 같은 규칙: PATHFINDER_DATA_DIR로 데이터 루트를 바꿀 수 있다(스모크 테스트용).
const DATA_DIR = process.env.PATHFINDER_DATA_DIR ? resolve(process.env.PATHFINDER_DATA_DIR) : resolve(__dirname, '../data');
const ROOM_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const app = express();
app.use(express.json({ limit: '20mb' }));
const robotModelsRouter = await createRobotModelsRouter();
app.use('/api', robotModelsRouter);
const robotsRouter = await createRobotsRouter(robotModelsRouter.models);
app.use('/api', robotsRouter);
app.use('/api', await createProjectsRouter());

// scripts/import-scan-to-map-studio.mjs가 data/imported/<room>.geojson에 미리
// 써둔 결과를 읽기 전용으로 서빙한다. data/nodelink.geojson(위)과 달리 여기는
// 쓰기 API가 없다 -- 갱신은 항상 스크립트를 다시 실행해서 파일을 통째로 교체하는
// 방식으로만 이뤄진다(사용자가 손으로 편집하는 데이터가 아니므로).
app.get('/api/imported-obstacles', async (req, res) => {
  const files = await readdir(IMPORTED_DIR).catch(() => []);
  const rooms = files.filter((f) => f.endsWith('.geojson')).map((f) => f.slice(0, -'.geojson'.length));
  res.json({ rooms });
});

// from-slicemap 이 저장한 바닥 이미지(정합 워크스페이스의 합성 floorplan). 프로젝트의
// floorImage.url 이 여기를 가리키고 extent 는 프로젝트 평면 기준이다.
app.get('/api/imported-obstacles/:room/floor.png', (req, res) => {
  const { room } = req.params;
  if (!ROOM_NAME_RE.test(room)) {
    res.status(400).json({ error: '올바르지 않은 room 이름입니다.' });
    return;
  }
  res.sendFile(resolve(IMPORTED_DIR, `${room}.floor.png`), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: `"${room}" 바닥 이미지가 없습니다.` });
  });
});

app.get('/api/imported-obstacles/:room', async (req, res) => {
  const { room } = req.params;
  if (!ROOM_NAME_RE.test(room)) {
    res.status(400).json({ error: '올바르지 않은 room 이름입니다.' });
    return;
  }
  try {
    const content = await readFile(resolve(IMPORTED_DIR, `${room}.geojson`), 'utf-8');
    res.json(JSON.parse(content));
  } catch {
    res.status(404).json({ error: `"${room}" 가져오기 결과를 찾을 수 없습니다.` });
  }
});

// 실시간 로봇 위치 릴레이 -- vps-system(/localize)에서 계산해 scan-to-map-studio의
// registration_transform.json으로 map 프레임으로 옮긴 pose를(둘 다 ROS 없이,
// src/livePoseTransform.js 참고) 캡처 브리지 페이지가 PUT으로 밀어넣으면, 그걸
// 구독 중인 모든 pathfinder 브라우저 탭에 WebSocket으로 그대로 fan-out한다.
// 발행자는 하나(또는 소수), 구독자는 여럿인 비대칭 구조라 수신은 평범한 HTTP PUT,
// 배포만 WebSocket으로 밀어주는 쪽이 양방향 WebSocket보다 더 단순하다.
// data/nodelink.geojson과 달리 이 상태는 파일에 저장하지 않는다 -- 로봇이 "지금
// 어디 있는지"는 재시작하면 다시 받으면 그만인 휘발성 데이터다.
const latestPoseByRobot = new Map(); // robotId -> { x, y, headingRad, timestamp }

function isLivePose(body) {
  return (
    body &&
    typeof body.x === 'number' &&
    typeof body.y === 'number' &&
    typeof body.headingRad === 'number'
  );
}

app.put('/api/live-pose/:robotId', (req, res) => {
  if (!isLivePose(req.body)) {
    res.status(400).json({ error: 'x, y, headingRad(모두 number)가 필요합니다.' });
    return;
  }
  const { robotId } = req.params;
  const pose = {
    x: req.body.x,
    y: req.body.y,
    headingRad: req.body.headingRad,
    timestamp: typeof req.body.timestamp === 'number' ? req.body.timestamp : Date.now(),
    // 어느 현장(pathfinder 프로젝트/시뮬레이터 월드) 소속인지 -- 없으면(구버전 sim-driver 등)
    // 지도 쪽에서 항상 표시한다. src/liveRobotPose.js 참고.
    mapId: typeof req.body.mapId === 'string' && req.body.mapId ? req.body.mapId : undefined,
  };
  latestPoseByRobot.set(robotId, pose);
  broadcastPose(robotId, pose);
  res.json({ ok: true });
});

app.get('/api/live-pose', (req, res) => {
  res.json(Object.fromEntries(latestPoseByRobot));
});

// 폐루프 제어 릴레이 -- pf-obstacle 탭에서 찾은 경로를 "시뮬레이터로 실행" 버튼으로
// 보내면, ros-chromium(robot-os-chromium)의 apps/sim-driver가 이 스트림을 구독해
// PathFollowerNode에 넘기고, 그 결과(cmd_vel)가 시뮬레이터를 실제로 움직인다.
// live-pose와 달리 "현재 상태" 개념이 없다 -- 주행 요청은 발생 시점에만 의미 있는
// 1회성 명령이라, 새로 접속한 구독자에게 지난 요청을 다시 보내주지 않는다.
function isDriveRequest(body) {
  return (
    body &&
    Array.isArray(body.path) &&
    body.path.length > 0 &&
    body.path.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'))
  );
}

app.put('/api/drive-request/:robotId', (req, res) => {
  if (!isDriveRequest(req.body)) {
    res.status(400).json({ error: 'path([[x,y], ...], 1개 이상)가 필요합니다.' });
    return;
  }
  const { robotId } = req.params;
  // 이 robotId가 VDA5050(MQTT)로 ONLINE이면 표준 order로 보낸다 -- 같은 로봇이 두
  // 경로로 동시에 경로를 받지 않게 WebSocket 릴레이는 그 경우 건너뛴다(sim-driver도
  // MQTT_URL이 있으면 릴레이를 구독하지 않는다). 아니면 예전 릴레이 그대로.
  const viaMqtt = vda5050.findOnlineBySerial(robotId);
  if (viaMqtt) {
    try {
      const sent = vda5050.sendOrder(viaMqtt.manufacturer, robotId, req.body.path, { mapId: req.body.mapId });
      res.json({ ok: true, transport: 'vda5050', ...sent });
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
    return;
  }
  broadcastOn(driveRequestWss, { robotId, path: req.body.path });
  res.json({ ok: true, transport: 'relay' });
});

const PORT = process.env.PORT || 3001;
const httpServer = createServer(app);

// 두 WebSocket 스트림을 경로별로 분리한다 -- noServer 모드 + 수동 라우팅. 서로 다른
// 업그레이드 요청을 검사 없이 서로가 가로채지 않도록.
const livePoseWss = new WebSocketServer({ noServer: true });
const driveRequestWss = new WebSocketServer({ noServer: true });
// VDA5050 브리지(server/vda5050.mjs): MQTT로 들어온 로봇 위치를 위 live-pose fan-out에
// 그대로 합류시킨다 -- 지도 마커 코드(src/liveRobotPose.js)는 전송 수단을 모른다.
const vda5050 = await createVda5050Bridge({
  dataDir: DATA_DIR,
  onPose: (robotId, pose) => {
    latestPoseByRobot.set(robotId, pose);
    broadcastPose(robotId, pose);
  },
  // 처음 보는 VDA5050 로봇은 레지스트리에 자동 등록 -> 지도 마커에 아이콘/이름이 붙고
  // 길찾기 탭에서 이동 명령 대상으로 고를 수 있다(robots.mjs ensureVda5050Robot).
  onRobotDiscovered: async (manufacturer, serialNumber) => {
    const { created } = await robotsRouter.robots.ensureVda5050Robot(manufacturer, serialNumber);
    if (created) console.log(`[vda5050] 레지스트리에 자동 등록: ${manufacturer}/${serialNumber}`);
  },
});
app.use('/api', vda5050.router);
const settingsRouter = await createSettingsRouter(DATA_DIR); // 서비스 주소 (data/settings.json)
app.use('/api', settingsRouter.router);
app.use('/api', await createSimControlRouter({ dataDir: DATA_DIR, repoRoot: resolve(__dirname, '..') })); // 시뮬레이터 시작/정지 (설정 › 시뮬레이터)
app.use('/api', await createVpsRouter({ getServiceUrl: settingsRouter.getServiceUrl })); // VPS 서버 프록시 (설정 › VPS 서버 주소)
app.use('/api', await createDigitalTwinRouter({ repoRoot: resolve(__dirname, '..') })); // 3D 텍스처 뷰어 (dc-vps-digital-twin 결과)
app.use('/api', await createDigitalTwinTrainingRouter({ repoRoot: resolve(__dirname, '..'), dataDir: DATA_DIR })); // SuGaR 학습 job runner

httpServer.on('upgrade', (req, socket, head) => {
  const wss = { '/api/live-pose/stream': livePoseWss, '/api/drive-request/stream': driveRequestWss, [vda5050.streamPath]: vda5050.wss }[req.url];
  if (!wss) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

livePoseWss.on('connection', (ws) => {
  // 새로 붙은 탭이 다음 업데이트를 기다리지 않고 바로 현재 상태를 보게 한다.
  for (const [robotId, pose] of latestPoseByRobot) {
    ws.send(JSON.stringify({ robotId, pose }));
  }
});

function broadcastOn(wss, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function broadcastPose(robotId, pose) {
  broadcastOn(livePoseWss, { robotId, pose });
}

httpServer.listen(PORT, () => {
  console.log(`node-link API 서버 실행 중: http://localhost:${PORT}`);
});
