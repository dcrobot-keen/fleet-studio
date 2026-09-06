// server/index.mjs의 /api/live-pose/stream WebSocket을 구독해서, vps-system +
// scan-to-map-studio 좌표 변환(livePoseTransform.js, ROS 없이 계산됨)을 거쳐
// map 프레임으로 들어온 실제 로봇 위치를 지도 위 아이콘 마커로 표시한다.
// doc/architecture-improvements.md ② 참고.
//
// 시뮬레이션 경로 애니메이션(robotAnimation.js)과는 별개의 소스를 쓴다 --
// "지금 실제로 어디 있는지"와 "경로탐색 데모로 재생 중인지"를 섞으면 안 되므로.
// 연결은 하나만 유지하고(appShared.js의 liveRobotPoseSource), 2D 지도 탭과
// 길찾기(장애물) 탭은 이 소스를 각자의 VectorLayer로 감싸기만 한다 —
// nodeLinkSource/importedObstacleSource와 같은 공유 방식.
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { robotMarkerStyle, REFERENCE_SIZE_M } from './pathfinding/robotAnimation.js';
import { listRobots } from './robots/robotApi.js';
import { activeProjectName } from './appShared.js';
import { getSelectedRobotSerial, onSelectedRobotChange } from './fleet/selectedRobot.js';

const RECONNECT_DELAY_MS = 2000;
const UNKNOWN_ROBOT_COLOR = '#e91e63';
// ros-chromium의 apps/sim-driver + manifests/tb3-sim.manifest.json이 쓰는 로봇 id
// 규칙("tb3-sim-01" 등, "-sim-" 또는 "sim-"/"-sim"을 포함)을 그대로 재사용한다 --
// 실제로 존재하지 않는 가상 로봇을 실제 로봇과 같은 마커로 보여주면 혼동을
// 일으키므로, 색상+점선 테두리+라벨로 구분한다(doc/architecture-improvements.md 참고).
const SIM_ROBOT_ID_RE = /(^|-)sim(-|$)/i;
const SIM_ROBOT_COLOR = '#9b59b6';

// sim-driver가 "<robotId>-truth"로 따로 올리는 ground-truth 디버그 마커(OdometryNode
// + PoseFusionNode가 실제로 뭘 보고 조향하는지와, 시뮬레이터만 아는 "진짜" 위치를
// 눈으로 비교하기 위한 것 -- 실기에는 ground truth 자체가 없다). 반투명 회색 유령
// 점으로 그려 "이건 로봇이 아니라 디버그용 참고선"임을 명확히 한다.
const TRUTH_ROBOT_ID_RE = /-truth$/i;
const TRUTH_ROBOT_COLOR = 'rgba(136, 136, 136, 0.55)';

function isSimRobotId(robotId) {
  return SIM_ROBOT_ID_RE.test(robotId);
}

function isTruthRobotId(robotId) {
  return TRUTH_ROBOT_ID_RE.test(robotId);
}

/**
 * WebSocket 연결을 시작하고 들어오는 pose로 source를 계속 갱신한다.
 * @param {import('ol/source/Vector.js').default} source
 * @returns {{ close: () => void }}
 */
export function startLiveRobotPoseTracking(source) {
  const featuresByRobotId = new Map();
  let robotsById = new Map();
  // VDA5050 로봇은 robotId == serialNumber 로 들어온다. 레지스트리(robots.json)의
  // vda5050Serial 로 이어서 아이콘·이름·크기를 붙인다(서버가 처음 보는 로봇을 자동
  // 등록하므로 잠깐 뒤에 다시 조회하면 항상 찾아진다).
  let robotsBySerial = new Map();
  let lastRefreshAt = 0;
  let closed = false;
  let ws = null;

  async function refreshRobots() {
    lastRefreshAt = Date.now();
    try {
      const robots = await listRobots();
      robotsById = new Map(robots.map((r) => [r.id, r]));
      robotsBySerial = new Map(robots.filter((r) => r.vda5050Serial).map((r) => [r.vda5050Serial, r]));
    } catch (err) {
      console.error('실시간 로봇 위치: 로봇 목록 조회 실패', err);
    }
  }

  function lookupRobot(robotId) {
    const robot = robotsBySerial.get(robotId) ?? robotsById.get(robotId);
    if (!robot && !isTruthRobotId(robotId) && Date.now() - lastRefreshAt > 3000) refreshRobots().then(() => restyle(robotId));
    return robot;
  }

  const lastPoseByRobotId = new Map();
  function restyle(robotId) {
    const pose = lastPoseByRobotId.get(robotId);
    if (pose && featuresByRobotId.has(robotId)) applyPose(robotId, pose);
  }

  // fleetBoard.js에서 고른 로봇을 지도 마커에도 반영한다(selectedRobot.js 참고). truth 고스트
  // 마커는 "<serial>-truth" 키를 쓰므로, 선택이 바뀌면 실제 마커와 고스트 마커 둘 다 다시 그린다.
  let selectedSerial = getSelectedRobotSerial();
  function restyleForSerial(serial) {
    if (!serial) return;
    restyle(serial);
    restyle(`${serial}-truth`);
  }
  const unsubscribeSelection = onSelectedRobotChange((next) => {
    const prev = selectedSerial;
    selectedSerial = next;
    restyleForSerial(prev);
    restyleForSerial(next);
  });

  // pose.mapId 는 로봇이 속한 현장(pathfinder 프로젝트/시뮬레이터 월드) 이름이다(sim-driver의
  // MAP_ID 또는 시뮬레이터 월드 이름, VDA5050 state의 agvPosition.mapId). 다른 현장의 로봇이
  // 이 지도 위에 같은 (x,y)로 잘못 겹쳐 보이지 않도록, 있으면 현재 현장과 대조한다. 없으면
  // (구버전 소스 등, mapId 개념이 없는 로봇) 예전처럼 항상 그린다.
  function belongsHere(pose) {
    return !pose.mapId || pose.mapId === activeProjectName;
  }

  function applyPose(robotId, pose) {
    if (!belongsHere(pose)) {
      const existing = featuresByRobotId.get(robotId);
      if (existing) {
        source.removeFeature(existing);
        featuresByRobotId.delete(robotId);
        lastPoseByRobotId.delete(robotId);
      }
      return;
    }
    let feature = featuresByRobotId.get(robotId);
    if (!feature) {
      feature = new Feature(new Point([pose.x, pose.y]));
      featuresByRobotId.set(robotId, feature);
      source.addFeature(feature);
    } else {
      feature.getGeometry().setCoordinates([pose.x, pose.y]);
    }
    lastPoseByRobotId.set(robotId, pose);
    const robot = lookupRobot(robotId);
    const truth = isTruthRobotId(robotId);
    const sim = !truth && isSimRobotId(robotId);
    const baseId = truth ? robotId.slice(0, -'-truth'.length) : robotId;
    feature.setStyle(
      robotMarkerStyle(
        truth ? TRUTH_ROBOT_COLOR : robot ? undefined : sim ? SIM_ROBOT_COLOR : UNKNOWN_ROBOT_COLOR,
        truth ? undefined : robot?.icon,
        {
          // 유령 마커는 로봇 자체보다 한 단계 작게 그려 "참고용"임을 크기로도 드러낸다.
          sizeMeters: truth ? REFERENCE_SIZE_M * 0.6 : robot?.sizeMeters,
          // OL Icon의 rotation은 화면 기준 시계방향(라디안), pathfinder 좌표계는
          // 수학 표준(반시계 방향이 양의 각도)이라 부호를 뒤집는다.
          rotation: -pose.headingRad,
          // truth 고스트는 라벨 없이(실제 마커와 겹치는 자리라 글자까지 겹치면 더 안 보인다) 점으로만 구분한다.
          // 실제/SIM 라벨은 아이콘 아래로 내려서(labelPlacement) odometry/시뮬레이터 마커끼리도 안 겹치게 한다.
          label: truth ? undefined : sim ? `SIM · ${robot?.name ?? robotId}` : robot?.name ?? robotId,
          labelPlacement: 'below',
          dashed: sim || truth,
          selected: baseId === selectedSerial,
        }
      )
    );
  }

  function connect() {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/api/live-pose/stream`);
    ws.addEventListener('message', (event) => {
      const { robotId, pose } = JSON.parse(event.data);
      applyPose(robotId, pose);
    });
    ws.addEventListener('close', () => {
      if (!closed) setTimeout(connect, RECONNECT_DELAY_MS);
    });
    ws.addEventListener('error', () => ws.close());
  }

  refreshRobots();
  connect();

  return {
    close() {
      closed = true;
      ws?.close();
      unsubscribeSelection();
    },
  };
}
