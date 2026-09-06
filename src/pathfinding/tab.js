import OlMap from 'ol/Map.js';
import View from 'ol/View.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import ImageLayer from 'ol/layer/Image.js';
import ImageStatic from 'ol/source/ImageStatic.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Feature from 'ol/Feature.js';
import PointGeom from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import Draw from 'ol/interaction/Draw.js';
import Snap from 'ol/interaction/Snap.js';
import Style from 'ol/style/Style.js';
import CircleStyle from 'ol/style/Circle.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Text from 'ol/style/Text.js';
import { defaults as defaultControls } from 'ol/control.js';
import ScaleLine from 'ol/control/ScaleLine.js';
import { indoorProjection, MAP_SIZE_X, MAP_SIZE_Y, pcdSource, nodeLinkSource, importedObstacleSource, liveRobotPoseSource, activeProjectName, activeProjectFloorImage } from '../appShared.js';
import { sendFleetOrder, subscribeFleetStream, sendFleetInstantAction } from '../fleet/fleetApi.js';
import { createFleetBoard } from '../fleet/fleetBoard.js';
import { setSelectedRobotSerial } from '../fleet/selectedRobot.js';
import { createOperateSidePanel } from '../fleet/operateSidePanel.js';
import { buildGridLayer } from '../grid2d.js';
import { nodeLinkStyle } from '../nodeLinkStyle.js';
import { importedObstacleStyle, createImportedObstaclesPanel } from '../importedObstacles.js';
import { findNodeLinkPath, findObstaclePath, sendDriveRequest, inflationForRobot } from './pathfindingApi.js';
import { animatePathAndRobot, randomPathColor, REFERENCE_SIZE_M as DEFAULT_SIZE_M } from './robotAnimation.js';
import { listRobots } from '../robots/robotApi.js';
import { typeLabel } from '../robots/robotCodes.js';
import { renderSlicePanel } from '../heightSlices.js';

// ros-chromium/robot-os-chromium의 apps/sim-driver + manifests/tb3-sim.manifest.json
// 기본값과 맞춘 시뮬레이터 로봇 id. sim-driver 인스턴스가 하나뿐이므로 지금은
// 상수 하나로 충분하다 -- 여러 시뮬레이터를 동시에 띄우게 되면 그때 선택 UI로 바꾼다.
const SIM_ROBOT_ID = 'tb3-sim-01';

const MODE_CONFIG = {
  nodelink: {
    title: '길찾기 (노드/링크)',
    algorithms: [
      ['astar', 'A*'],
      ['dijkstra', 'Dijkstra'],
    ],
    snapping: true,
    hint: '링크 위를 클릭해 시작점을 찍고, 다시 클릭해 도착점을 찍으세요.',
  },
  obstacle: {
    title: '길찾기 (장애물 회피)',
    algorithms: [
      ['hybridastar', 'Hybrid A*'],
      ['gridastar', 'Grid A*'],
    ],
    snapping: false,
    hint: '지도 빈 공간을 클릭해 시작점을 찍고, 다시 클릭해 도착점을 찍으세요.',
  },
};

function markerStyle(role) {
  return new Style({
    image: new CircleStyle({
      radius: 8,
      fill: new Fill({ color: role === 'start' ? '#2ecc71' : '#e74c3c' }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
    text: new Text({
      text: role === 'start' ? 'S' : 'E',
      fill: new Fill({ color: '#fff' }),
      font: 'bold 11px sans-serif',
    }),
  });
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y;
    if (intersects) {
      const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * 길찾기 탭 하나(노드/링크 모드 또는 장애물 회피 모드)를 컨테이너에 구성한다.
 * @param {HTMLElement} mapEl
 * @param {HTMLElement} panelEl
 * @param {'nodelink' | 'obstacle'} mode
 */
/**
 * variant 'demo' (기본): 시뮬레이션 화면 -- 시작/도착점을 찍어 애니메이션 로봇을 굴리고
 *   충돌 회피(정지/재탐색)를 본다. 실제 로봇 이동 명령 박스도 함께 있다.
 * variant 'operate': 운영 화면 -- 왼쪽에 플릿 보드(로봇 목록·상태·취소/일시정지)와 이동
 *   명령만 두고, 데모용 컨트롤과 시작/도착점 클릭은 숨긴다. 지도 클릭은 "목적지 클릭"
 *   모드에서만 살아 있다. (M1: 화면 재배치, doc/vda5050-rcs.md · 플릿 스튜디오 기획서)
 */
export function createPathfindingTab(mapEl, panelEl, mode, { variant = 'demo', sideEl = null } = {}) {
  const config = MODE_CONFIG[mode];
  const isOperate = variant === 'operate';
  let fleetBoard = null;

  const floorLayer = new WebGLVectorLayer({
    source: pcdSource,
    filter: ['between', ['get', 'z'], 0, 0.5],
    style: {
      'circle-radius': 1.5,
      'circle-fill-color': ['color', ['get', 'r'], ['get', 'g'], ['get', 'b']],
      'circle-opacity': 0.6,
    },
  });
  // 스캔 프로젝트의 바닥 이미지(앱 floorplan 합성) -- 2D 뷰와 같은 파일, 이동 명령을 내릴 때
  // 실제 바닥이 보여야 목적지를 고르기 쉽다. 없는 프로젝트면 레이어를 만들지 않는다.
  const floorImageLayer = activeProjectFloorImage
    ? new ImageLayer({
        source: new ImageStatic({ url: activeProjectFloorImage.url, imageExtent: activeProjectFloorImage.extent, projection: indoorProjection }),
        opacity: 0.85,
      })
    : null;
  const graphLayer = new VectorLayer({ source: nodeLinkSource, style: nodeLinkStyle });
  const importedObstacleLayer = new VectorLayer({ source: importedObstacleSource, style: importedObstacleStyle });
  // WebSocket 연결은 main.js가 한 번만 시작한다 — 여기서는 같은 공유 소스를 감싸기만 함.
  const liveRobotPoseLayer = new VectorLayer({ source: liveRobotPoseSource, zIndex: 20 });
  const interactionSource = new VectorSource();
  const interactionLayer = new VectorLayer({ source: interactionSource, zIndex: 10 });
  const conflictSource = new VectorSource();
  const conflictLayer = new VectorLayer({ source: conflictSource, zIndex: 15 });

  const map = new OlMap({
    target: mapEl,
    layers: [
      buildGridLayer(MAP_SIZE_X, MAP_SIZE_Y, 10),
      ...(floorImageLayer ? [floorImageLayer] : []),
      floorLayer,
      graphLayer,
      importedObstacleLayer,
      liveRobotPoseLayer,
      interactionLayer,
      conflictLayer,
    ],
    view: new View({
      projection: indoorProjection,
      center: [MAP_SIZE_X / 2, MAP_SIZE_Y / 2],
      zoom: 1,
      minZoom: 0,
      maxZoom: 8,
      extent: [
        -MAP_SIZE_X * 0.2,
        -MAP_SIZE_Y * 0.2,
        MAP_SIZE_X * 1.2,
        MAP_SIZE_Y * 1.2,
      ],
      // center만 제한 — 안 그러면 세로가 긴 데이터(200x400)를 가로로 넓은
      // 브라우저 창에 맞출 때 extent 폭 제약이 축소를 막아 세로가 잘린다.
      constrainOnlyCenter: true,
    }),
    controls: defaultControls().extend([new ScaleLine({ units: 'metric' })]),
  });
  // 처음 열릴 때 200x400m 공장 부지 전체가 보이도록 맞춘다(데이터가 있으면
  // fitToData()가 나중에 그 범위로 다시 맞춘다). updateSize()를 먼저 호출해
  // OL이 컨테이너의 실제 크기를 측정한 뒤 fit이 계산되도록 한다.
  map.updateSize();
  map.getView().fit([0, 0, MAP_SIZE_X, MAP_SIZE_Y], { padding: [20, 20, 20, 20] });

  // 레이어 on/off 패널 (2D 지도의 레이어 패널과 같은 컴포넌트 재사용).
  // .slice-panel은 top/right에 고정되어 있어 좌측의 pathfinding-panel과 겹치지 않는다.
  // 레이어 토글은 지도 위 상자 대신 "표시" 버튼 → 팝오버 (레이어 + 색 범례). 바깥을 누르면 닫힌다.
  const layersPanelEl = document.createElement('div');
  mapEl.appendChild(layersPanelEl);
  renderSlicePanel(layersPanelEl, [], [], [
    ...(floorImageLayer ? [{ layer: floorImageLayer, label: '바닥 이미지' }] : []),
    { layer: floorLayer, label: '바닥 PCD (0.5m)' },
    { layer: graphLayer, label: '노드/링크/블록' },
    { layer: importedObstacleLayer, label: '스캔 장애물' },
    { layer: liveRobotPoseLayer, label: '실시간 로봇 위치' },
  ]);
  layersPanelEl.classList.add('s2m-popover');
  layersPanelEl.hidden = true;
  if (isOperate) {
    // 운영 기본: 편집용 노드/링크는 꺼 둔다 (필요하면 팝오버에서 켠다)
    graphLayer.setVisible(false);
    for (const row of layersPanelEl.querySelectorAll('.slice-row')) {
      if (row.textContent.includes('노드/링크')) { const cb = row.querySelector('input'); if (cb) cb.checked = false; }
    }
  }
  const legend = document.createElement('div');
  legend.className = 's2m-legend';
  legend.innerHTML = '<div class="slice-panel-title">범례</div>' + [
    ['계획 경로', 'background: repeating-linear-gradient(90deg, #ff9800 0 6px, transparent 6px 10px); height: 3px; border-radius: 0'],
    ['목적지', 'background: #e74c3c; border: 2px solid #fff'],
    ['로봇 (등록 아이콘 · 이름)', 'background: #4fd1c5'],
    ['스캔 장애물 (벽 · 가구)', 'background: transparent; border: 2px solid #ef4444; border-radius: 2px'],
    ['다른 로봇 = 계획 시 장애물', 'background: #8b96a8'],
  ].map(([label, sw]) => `<div class="s2m-legend__row"><span class="s2m-legend__sw" style="${sw}"></span><span>${label}</span></div>`).join('');
  layersPanelEl.appendChild(legend);
  const layersBtn = document.createElement('button');
  layersBtn.className = 's2m-map-btn';
  layersBtn.type = 'button';
  layersBtn.title = '표시할 레이어와 범례';
  layersBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/></svg><span>표시</span>';
  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    layersPanelEl.hidden = !layersPanelEl.hidden;
    layersBtn.classList.toggle('active', !layersPanelEl.hidden);
  });
  document.addEventListener('pointerdown', (e) => {
    if (layersPanelEl.hidden) return;
    if (layersPanelEl.contains(e.target) || layersBtn.contains(e.target)) return;
    layersPanelEl.hidden = true;
    layersBtn.classList.remove('active');
  });
  mapEl.appendChild(layersBtn);

  const geojsonFormat = new GeoJSON({
    dataProjection: indoorProjection,
    featureProjection: indoorProjection,
  });

  // "스캔 장애물" 패널: scan-to-map-studio에서 가져온 방을 골라 importedObstacleSource에
  // 불러온다. 이 소스는 여러 탭이 공유하므로 다른 탭(2D 지도)에서 불러와도 여기 즉시 반영된다.
  const importedObstaclesPanelEl = document.createElement('div');
  mapEl.appendChild(importedObstaclesPanelEl);
  createImportedObstaclesPanel(importedObstaclesPanelEl, geojsonFormat, map);

  const draw = new Draw({ source: interactionSource, type: 'Point' });
  map.addInteraction(draw);
  if (isOperate) draw.setActive(false); // 운영 화면은 "목적지 클릭" 모드에서만 지도 클릭을 받는다
  if (config.snapping) {
    map.addInteraction(new Snap({ source: nodeLinkSource }));
  }

  let pendingRole = 'start';
  let pendingStartCoord = null;
  const activeAnimations = [];
  const robotsById = new Map();
  const validAlgorithms = new Set(config.algorithms.map(([value]) => value));

  // --- Deconfliction 1단계: 근접 감지 + pause/resume ---
  // 동시에 여러 start/end 쌍을 만들 수 있으므로, 로봇 마커끼리 너무 가까워지면
  // 나중에 출발한(우선순위 낮은) 쪽을 잠깐 멈춰 충돌을 피한다.
  // 재탐색(re-routing)은 다음 단계 — 지금은 감지+정지까지만.
  //
  // 판정은 "현재 위치끼리의 거리"가 아니라 "남은 경로(remaining path)끼리의 최근접
  // 거리"로 한다. animatePathAndRobot이 매 프레임 이미 지나온 구간을 잘라낸
  // getRemainingPath()를 제공하므로, 두 로봇의 남은 경로 polyline 사이 최단 거리를
  // 구해 그 값을 기준으로 삼는다. 이렇게 하면:
  //   - 한 로봇이 교차 지점을 이미 지나쳤다면 그 지점은 더 이상 그 로봇의 남은
  //     경로에 포함되지 않으므로, 상대 로봇이 그 지점에 다가가도 더 이상 막지 않는다
  //     (현재 좌표만 비교하면 "이미 지나간" 로봇도 계속 막고 있는 경우가 생겼다).
  //   - 정지 반경(pauseRadius) 안으로 들어오는 순간 막고, 벗어나는 순간 지연 없이
  //     바로 풀린다(별도의 hysteresis 대기 없음) — 위험 판단 기준이 사라지면 즉시
  //     resume.
  //
  // 매 틱마다 "현재 활성 상태인" 모든 상위 우선순위 로봇을 기준으로 다시 판정한다 —
  // 그래야 막고 있던 로봇이 먼저 도착해서 activeAnimations에서 빠졌을 때도(경로 종료)
  // 그 즉시 대기 중이던 로봇이 자동으로 풀린다. 특정 쌍만 한 번 판정하고 끝내면,
  // 상대가 사라진 뒤에도 그 판정이 갱신되지 않아 영원히 멈춰있는(사실상 데드락처럼
  // 보이는) 상태가 됐었다.
  //
  // conflict(pauseRadius 이내로 좁혀진 쌍)가 발생하는 동안에는 남은 경로끼리 가장
  // 가까워지는 두 지점 사이에 실선을 긋고 그 위에 실측 거리를 표시해, pause 판정의
  // 근거를 화면에서 바로 확인할 수 있게 한다.
  let nextAnimId = 1;
  const conflictLineFeatures = new Map(); // "id1:id2" -> LineString Feature
  let lastPausedCount = 0;

  const CHECK_INTERVAL_MS = 200;
  const PAUSE_SIZE_MULTIPLIER = 2; // pauseRadius = 이 값 * (higherSize + lowerSize)
  const MAX_PROXIMITY_SAMPLES = 150; // 긴 경로에서 최근접 거리 계산 비용을 제한
  // 남은 경로 "전체"를 그대로 비교하면, 로봇이 아직 한참 멀리 있어도 그 경로가
  // 나중에 지나갈 어느 먼 지점이 우연히 다른 로봇 경로와 가깝다는 이유만으로
  // 미리 멈춰버린다(로봇 3대 이상 있는 환경에서 실제로 확인된 문제: A가 아직
  // 경로 초반인데 A의 경로 후반부와 우연히 가까운 C가 A가 그 지점에 도달하기도
  // 전부터 멈춰서, 실질적으로 A의 앞선 conflict—B와의 건—가 끝날 때까지 함께
  // 묶여 대기하는 것처럼 보였다). 그래서 비교 범위를 "가까운 미래"로 제한한다:
  // 각 로봇의 남은 경로를, "현재 속도로 LOOKAHEAD_SECONDS 안에 실제로 갈 수 있는
  // 거리"만큼만 잘라서 그 구간끼리만 최근접 거리를 잰다. 거리를 속도에 비례시키는
  // 이유: 느린 로봇(Atlas 0.2m/s)은 몇 초 안에 얼마 못 가므로 먼 미래 지점을 미리
  // 볼 필요가 없고, 빠른 로봇(SPOT 1.2m/s)은 같은 시간에 더 멀리 가므로 그만큼
  // 더 미리 봐야 한다. 이렇게 하면 각 conflict 쌍이 실제로 서로 가까워질 때가
  // 되어서야(정확히는 각자 그 지점에 다가갈 때) 독립적으로 판정되고, 다른 쌍의
  // 사정과 뒤섞이지 않는다.
  const LOOKAHEAD_SECONDS = 4;
  const MIN_LOOKAHEAD_M = 1; // 거의 정지한 로봇도 최소한의 여유는 두고 판정
  const MAX_LOOKAHEAD_M = 15; // 매우 빠른 로봇이 경로 전체를 다 들여다보지 않도록 상한

  function lookaheadDistance(metersPerSecond) {
    const speed = metersPerSecond ?? 1.0;
    return Math.min(MAX_LOOKAHEAD_M, Math.max(MIN_LOOKAHEAD_M, speed * LOOKAHEAD_SECONDS));
  }

  // 경로 점이 너무 많으면(장애물 회피 모드는 cellSize 단위로 촘촘함) 균등 간격으로
  // 솎아내 O(n*m) 최근접 거리 계산 비용을 억제한다.
  function downsample(coords) {
    if (coords.length <= MAX_PROXIMITY_SAMPLES) return coords;
    const stride = Math.ceil(coords.length / MAX_PROXIMITY_SAMPLES);
    const out = [];
    for (let i = 0; i < coords.length; i += stride) out.push(coords[i]);
    const last = coords[coords.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }

  // 경로를 현재 위치(coords[0])부터 maxDist(m)까지만 잘라낸다 — 그보다 먼
  // 구간은 "아직 갈 일 없는 미래"로 보고 충돌 판정에서 제외한다.
  function truncatePath(coords, maxDist) {
    if (coords.length === 0) return coords;
    const out = [coords[0]];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const [x1, y1] = coords[i - 1];
      const [x2, y2] = coords[i];
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      if (acc + segLen >= maxDist) {
        const remain = maxDist - acc;
        const t = segLen === 0 ? 0 : remain / segLen;
        out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
        return out;
      }
      out.push([x2, y2]);
      acc += segLen;
    }
    return out; // 전체 길이가 이미 maxDist보다 짧음
  }

  function pointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const x = x1 + t * dx;
    const y = y1 + t * dy;
    return { distance: Math.hypot(px - x, py - y), x, y };
  }

  // 세 점 o,a,b의 방향(부호 있는 넓이의 2배): >0 반시계, <0 시계, 0 일직선.
  function orientation(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  function onSegment(a, b, p) {
    return (
      Math.min(a[0], b[0]) - 1e-9 <= p[0] &&
      p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
      Math.min(a[1], b[1]) - 1e-9 <= p[1] &&
      p[1] <= Math.max(a[1], b[1]) + 1e-9
    );
  }

  // 두 선분이 실제로 만나면 그 교차점을, 아니면 null을 반환한다.
  function segmentIntersectionPoint(p1, p2, p3, p4) {
    const d1 = orientation(p3, p4, p1);
    const d2 = orientation(p3, p4, p2);
    const d3 = orientation(p1, p2, p3);
    const d4 = orientation(p1, p2, p4);
    const proper = ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    const touching =
      (d1 === 0 && onSegment(p3, p4, p1)) ||
      (d2 === 0 && onSegment(p3, p4, p2)) ||
      (d3 === 0 && onSegment(p1, p2, p3)) ||
      (d4 === 0 && onSegment(p1, p2, p4));
    if (!proper && !touching) return null;

    const denom = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(denom) < 1e-9) {
      // 평행하게 맞닿은(collinear touching) 경우 — 닿아있는 끝점 하나를 그대로 쓴다.
      if (d1 === 0) return p1;
      if (d2 === 0) return p2;
      if (d3 === 0) return p3;
      return p4;
    }
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / denom;
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  }

  // 두 선분 사이의 최단 거리와, 그 최단 거리를 만든 두 지점을 구한다. 선분이
  // 서로 교차하면 거리는 0. vertex(끝점)만 표본으로 삼는 point-to-segment와
  // 달리, 두 선분이 서로의 "중간"에서 만나는 경우(교점이 어느 쪽 끝점도 아닌
  // 경우)도 놓치지 않는다 — 노드/링크 모드처럼 정점이 듬성듬성한 직선 경로도
  // 정확히 판정하기 위함이다.
  function segmentDistance(p1, p2, p3, p4) {
    const ip = segmentIntersectionPoint(p1, p2, p3, p4);
    if (ip) return { distance: 0, pointA: ip, pointB: ip };

    let best = null;
    const consider = (from, seg1, seg2) => {
      const r = pointToSegment(from[0], from[1], seg1[0], seg1[1], seg2[0], seg2[1]);
      if (!best || r.distance < best.distance) {
        best = { distance: r.distance, pointA: null, pointB: null, _from: from, _onto: [r.x, r.y] };
      }
    };
    consider(p1, p3, p4);
    consider(p2, p3, p4);
    consider(p3, p1, p2);
    consider(p4, p1, p2);

    // best._from이 A쪽 점이면(p1/p2) pointA=from,pointB=onto, B쪽 점이면(p3/p4) 반대.
    const fromIsA = best._from === p1 || best._from === p2;
    return {
      distance: best.distance,
      pointA: fromIsA ? best._from : best._onto,
      pointB: fromIsA ? best._onto : best._from,
    };
  }

  // 두 남은-경로 polyline 사이의 최단 거리와, 그 최단 거리를 만든 두 지점을 구한다.
  function closestApproach(coordsA, coordsB) {
    const a = downsample(coordsA);
    const b = downsample(coordsB);
    if (a.length < 2 || b.length < 2) {
      const p = a[0];
      const q = b[0];
      if (a.length < 2 && b.length < 2) {
        return { distance: Math.hypot(p[0] - q[0], p[1] - q[1]), pointA: p, pointB: q };
      }
      const single = a.length < 2 ? p : q;
      const line = a.length < 2 ? b : a;
      let best = { distance: Infinity, pointA: single, pointB: single };
      for (let i = 1; i < line.length; i++) {
        const r = pointToSegment(single[0], single[1], line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
        if (r.distance < best.distance) {
          best =
            a.length < 2
              ? { distance: r.distance, pointA: single, pointB: [r.x, r.y] }
              : { distance: r.distance, pointA: [r.x, r.y], pointB: single };
        }
      }
      return best;
    }

    let best = { distance: Infinity, pointA: a[0], pointB: b[0] };
    for (let i = 1; i < a.length; i++) {
      for (let j = 1; j < b.length; j++) {
        const r = segmentDistance(a[i - 1], a[i], b[j - 1], b[j]);
        if (r.distance < best.distance) best = r;
      }
    }
    return best;
  }

  // 두 경로가 "실제로 겹치는 쌍"인지 판단한다. 이론적으로는 정확한 선분 교차
  // 판정을 쓰고 싶지만, 실제 경로는 그리드 A*(cellSize 단위 계단식) / Hybrid A*
  // 조향 곡선으로 나오기 때문에 두 로봇의 경로가 눈으로는 분명히 교차해도
  // 두 polyline이 수학적으로 정확히 한 점에서 만나는 경우는 거의 없다(살짝
  // 스쳐 지나가듯 근접만 함). 그래서 "정확한 교차" 대신 "아주 가깝게(그리드
  // 오차 수준 이내로) 스쳐가는 지점이 있는가"로 판단한다 — 나란히 일정 간격을
  // 유지하며 가는 평행 경로는 이 좁은 허용치 안으로 절대 들어오지 않으므로
  // 여전히 걸러진다.
  const PATH_OVERLAP_TOLERANCE_M = 0.5;

  function pathsOverlap(coordsA, coordsB) {
    return closestApproach(coordsA, coordsB).distance < PATH_OVERLAP_TOLERANCE_M;
  }

  function conflictLineStyle(distance) {
    return new Style({
      stroke: new Stroke({ color: '#e74c3c', width: 2, lineDash: [6, 4] }),
      text: new Text({
        text: `${distance.toFixed(2)}m`,
        font: 'bold 12px sans-serif',
        fill: new Fill({ color: '#fff' }),
        stroke: new Stroke({ color: '#c0392b', width: 3 }),
        overflow: true,
      }),
    });
  }

  function showConflictLine(key, posA, posB, distance) {
    let feature = conflictLineFeatures.get(key);
    if (!feature) {
      feature = new Feature(new LineString([posA, posB]));
      conflictLineFeatures.set(key, feature);
      conflictSource.addFeature(feature);
    } else {
      feature.getGeometry().setCoordinates([posA, posB]);
    }
    feature.setStyle(conflictLineStyle(distance));
  }

  function hideConflictLine(key) {
    const feature = conflictLineFeatures.get(key);
    if (feature) {
      conflictSource.removeFeature(feature);
      conflictLineFeatures.delete(key);
    }
  }

  function checkConflicts() {
    let debugMsg = '';
    const conflictingKeys = new Set();
    // priority가 작을수록 우선순위가 높다(리스트 드래그앤드롭으로 즉시 바뀔 수 있음) —
    // 배열 순서(activeAnimations의 push 순서) 대신 매 틱 이 값 기준으로 정렬해서 비교한다.
    const sorted = [...activeAnimations].sort((a, b) => a.priority - b.priority);

    for (let j = 0; j < sorted.length; j++) {
      const lower = sorted[j];
      const lowerSize = lower.sizeMeters ?? DEFAULT_SIZE_M;
      let blocked = false;

      for (let i = 0; i < j; i++) {
        // i < j: priority가 더 작은(=더 앞선) 쪽이 우선순위가 높다.
        const higher = sorted[i];
        const higherSize = higher.sizeMeters ?? DEFAULT_SIZE_M;

        const higherLookahead = truncatePath(
          higher.getRemainingPath(),
          lookaheadDistance(higher.metersPerSecond)
        );
        const lowerLookahead = truncatePath(
          lower.getRemainingPath(),
          lookaheadDistance(lower.metersPerSecond)
        );

        const pauseRadius = PAUSE_SIZE_MULTIPLIER * (higherSize + lowerSize);
        const key = `${higher.id}:${lower.id}`;

        // 경로가 실제로 겹치지 않으면(평행하게 나란히 가는 경우 등) 아무리
        // 가까워도 막지 않는다 — 반경 거리 비교는 경로가 겹치는 쌍에만 적용.
        // "겹치는지"는 남은 경로 전체(잘라내기 전)를 기준으로 판단해 언젠가
        // 스쳐가는 지점이 있는지만 확인하고, 실제 pause 판정용 거리(d)는
        // 근시일 내 구간(lookahead)만으로 계산해 타이밍을 맞춘다.
        let d = Infinity;
        let pointA;
        let pointB;
        let pairBlocked = false;
        if (pathsOverlap(higher.getRemainingPath(), lower.getRemainingPath())) {
          ({ distance: d, pointA, pointB } = closestApproach(higherLookahead, lowerLookahead));
          pairBlocked = d < pauseRadius;
        }
        if (pairBlocked) blocked = true;

        if (pairBlocked) {
          conflictingKeys.add(key);
          showConflictLine(key, pointA, pointB, d);
        } else {
          hideConflictLine(key);
        }

        // 진단용: 실제로 이 틱에서 계산된 값을 콘솔에 남긴다. 예상과 다른 거리에서
        // pause가 걸리면 여기 로그로 실측치(d/pauseRadius)를 바로 확인할 수 있다.
        if (pairBlocked && !lower.isPaused()) {
          console.log(
            `[deconflict] pause 로봇#${lower.id} <- #${higher.id}: 남은경로 최근접거리=${d.toFixed(2)}m, pauseRadius=${pauseRadius.toFixed(2)}m`
          );
          debugMsg = ` (실측 ${d.toFixed(2)}m / 기준 ${pauseRadius.toFixed(2)}m)`;
        }
      }

      // 위험 기준(pauseRadius 이내)이 사라지는 즉시 pause/resume을 갱신한다 —
      // 별도의 대기(hysteresis) 없이 이번 틱 판정을 그대로 반영. 다만 재탐색(reroute)
      // 모드에서는 정지 대신 새 경로를 찾도록 attemptReroute에 위임한다.
      if (blocked) {
        if (conflictModeSelect.value === 'reroute') {
          if (!lower.rerouteInFlight) attemptReroute(lower); // fire-and-forget
        } else if (!lower.isPaused()) {
          lower.pause();
        }
      } else if (lower.isPaused() && !lower.rerouteInFlight) {
        console.log(`[deconflict] resume 로봇#${lower.id}`);
        lower.resume();
      }
    }

    // 이번 틱에 더 이상 활성 쌍이 아니거나(둘 중 하나 종료) 더 이상 conflict가 아닌
    // 이전 충돌선은 정리한다.
    for (const key of conflictLineFeatures.keys()) {
      if (!conflictingKeys.has(key)) hideConflictLine(key);
    }

    const pausedCount = activeAnimations.filter((a) => a.isPaused()).length;
    if (pausedCount !== lastPausedCount) {
      lastPausedCount = pausedCount;
      setStatus(
        pausedCount > 0
          ? `충돌 회피: 로봇 ${pausedCount}대 대기 중${debugMsg}`
          : '충돌 회피 해제, 계속 진행'
      );
    }
  }
  setInterval(checkConflicts, CHECK_INTERVAL_MS);

  let pendingStartFeature = null;

  draw.on('drawend', (evt) => {
    const coord = evt.feature.getGeometry().getCoordinates();
    if (commandMode) {
      // Draw는 drawend 뒤에 피처를 소스에 넣으므로 다음 틱에 지운다 -- 목적지 핀은
      // sendMoveCommand 가 따로 그린다.
      setTimeout(() => interactionSource.removeFeature(evt.feature), 0);
      setCommandMode(false);
      sendMoveCommand(coord);
      return;
    }
    evt.feature.set('role', pendingRole);
    evt.feature.setStyle(markerStyle(pendingRole));

    if (pendingRole === 'start') {
      pendingStartCoord = coord;
      pendingStartFeature = evt.feature;
      pendingRole = 'end';
      setStatus('도착점을 클릭하세요.');
    } else {
      const startCoord = pendingStartCoord;
      const startFeature = pendingStartFeature;
      pendingRole = 'start';
      pendingStartCoord = null;
      pendingStartFeature = null;
      requestPath(startCoord, coord, [startFeature, evt.feature]);
    }
  });

  // 활성 경로 목록의 우선순위를 0..n-1로 다시 매긴다(현재 priority 순서를 유지한
  // 채 빈 자리만 메움) — 경로가 하나 끝나거나(splice) 재탐색으로 교체될 때마다
  // 호출해서, 드래그앤드롭 정렬과 checkConflicts가 항상 연속된 값을 보게 한다.
  function renumberPriorities() {
    const sorted = [...activeAnimations].sort((a, b) => a.priority - b.priority);
    sorted.forEach((a, idx) => {
      a.priority = idx;
    });
  }

  // 경로 요청에 실제로 쓰이는 장애물 block만 골라낸다 -- 참고용 room-outline
  // (kind: "room-outline")은 장애물이 아니므로 여기서 제외한다.
  function importedBlockFeatures() {
    return importedObstacleSource.getFeatures().filter((f) => f.get('kind') === 'block');
  }

  async function requestPath(startCoord, endCoord, markerFeatures = []) {
    setStatus('경로 계산 중...');
    const featureCollection = geojsonFormat.writeFeaturesObject([
      ...nodeLinkSource.getFeatures(),
      ...importedBlockFeatures(),
    ]);
    const start = { x: startCoord[0], y: startCoord[1] };
    const end = { x: endCoord[0], y: endCoord[1] };
    const algorithm = algorithmSelect.value;
    const selectedRobot = robotsById.get(robotSelect.value) || null;

    try {
      const result =
        mode === 'nodelink'
          ? await findNodeLinkPath({ featureCollection, start, end, algorithm })
          : await findObstaclePath({ featureCollection, start, end, algorithm, cellSize: 0.2, inflationM: inflationForRobot(selectedRobot?.sizeMeters, DEFAULT_SIZE_M) });

      const id = nextAnimId++;
      const color = randomPathColor();
      const anim = animatePathAndRobot(map, interactionSource, result.path, {
        color,
        iconSrc: selectedRobot?.icon,
        metersPerSecond: selectedRobot?.speedMps,
        sizeMeters: selectedRobot?.sizeMeters,
        label: id, // 리스트의 번호와 동일 — 재탐색으로 경로가 바뀌어도 이 번호는 유지된다.
        onDone: () => {
          const idx = activeAnimations.indexOf(anim);
          if (idx !== -1) activeAnimations.splice(idx, 1);
          renumberPriorities();
          // 목적지에 도착하면 이번 경로의 start/end 핀도 함께 지운다.
          markerFeatures.forEach((f) => f && interactionSource.removeFeature(f));
          renderActiveList();
        },
      });
      anim.id = id;
      anim.color = color;
      anim.priority = activeAnimations.length; // 새로 시작한 경로는 일단 맨 뒤(최저 우선순위)
      anim.robotName = selectedRobot?.name ?? null;
      anim.algorithm = algorithm;
      anim.selectedRobot = selectedRobot;
      anim.endCoord = endCoord;
      anim.markerFeatures = markerFeatures;
      anim.pathCoords = result.path; // "시뮬레이터로 실행" 버튼이 그대로 drive-request로 보낼 원본 경로
      anim.rerouteInFlight = false;
      anim.sizeMeters = selectedRobot?.sizeMeters ?? DEFAULT_SIZE_M;
      activeAnimations.push(anim);
      renderActiveList();
      const robotNote = selectedRobot ? ` — ${selectedRobot.name}` : '';
      setStatus(`경로 거리: ${result.distance.toFixed(2)}m (${result.algorithm})${robotNote}`);
    } catch (err) {
      console.error(err);
      setStatus(`경로 탐색 실패: ${err.message}`);
    }
  }

  // --- re-routing: 충돌 시 정지 대신 현재 위치에서 목적지까지 새 경로를 다시 찾는다.
  // 상위 우선순위 로봇들의 "현재 위치"를 임시 원형 장애물로 취급해 그 주변을
  // 피해가도록 만든다(영구 장애물이 아니라 이번 재탐색 1회에만 쓰는 임시 데이터).
  function circlePolygonFeature(cx, cy, radius, sides = 12) {
    const coords = [];
    for (let i = 0; i <= sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      coords.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
    }
    return new Feature(new Polygon([coords]));
  }

  const REROUTE_BLOCK_RADIUS_MULTIPLIER = 1.5;

  async function attemptReroute(entry) {
    if (entry.rerouteInFlight) return;
    entry.rerouteInFlight = true;
    entry.pause();
    renderActiveList();

    try {
      const currentPos = entry.getPosition();
      const entrySize = entry.sizeMeters ?? DEFAULT_SIZE_M;
      const higherEntries = activeAnimations.filter((a) => a !== entry && a.priority < entry.priority);
      const blockFeatures = higherEntries.map((h) => {
        const [hx, hy] = h.getPosition();
        const hSize = h.sizeMeters ?? DEFAULT_SIZE_M;
        return circlePolygonFeature(hx, hy, REROUTE_BLOCK_RADIUS_MULTIPLIER * (hSize + entrySize));
      });

      const featureCollection = geojsonFormat.writeFeaturesObject([
        ...nodeLinkSource.getFeatures(),
        ...importedBlockFeatures(),
        ...blockFeatures,
      ]);
      const start = { x: currentPos[0], y: currentPos[1] };
      const end = { x: entry.endCoord[0], y: entry.endCoord[1] };

      const result =
        mode === 'nodelink'
          ? await findNodeLinkPath({ featureCollection, start, end, algorithm: entry.algorithm })
          : await findObstaclePath({ featureCollection, start, end, algorithm: entry.algorithm, cellSize: 0.2, inflationM: inflationForRobot(entry.sizeMeters, DEFAULT_SIZE_M) });

      // 기다리는 동안 초기화(reset)되었거나 이미 목적지에 도착해 정리된 경우 결과를 버린다.
      if (!activeAnimations.includes(entry)) return;

      entry.stop();
      const idx = activeAnimations.indexOf(entry);
      const newAnim = animatePathAndRobot(map, interactionSource, result.path, {
        color: entry.color,
        iconSrc: entry.selectedRobot?.icon,
        metersPerSecond: entry.selectedRobot?.speedMps,
        sizeMeters: entry.sizeMeters,
        label: entry.id,
        onDone: () => {
          const i2 = activeAnimations.indexOf(newAnim);
          if (i2 !== -1) activeAnimations.splice(i2, 1);
          renumberPriorities();
          entry.markerFeatures?.forEach((f) => f && interactionSource.removeFeature(f));
          renderActiveList();
        },
      });
      newAnim.id = entry.id;
      newAnim.color = entry.color;
      newAnim.priority = entry.priority;
      newAnim.robotName = entry.robotName;
      newAnim.algorithm = entry.algorithm;
      newAnim.selectedRobot = entry.selectedRobot;
      newAnim.endCoord = entry.endCoord;
      newAnim.markerFeatures = entry.markerFeatures;
      newAnim.pathCoords = result.path;
      newAnim.sizeMeters = entry.sizeMeters;
      newAnim.rerouteInFlight = false;

      if (idx !== -1) {
        activeAnimations[idx] = newAnim;
      } else {
        activeAnimations.push(newAnim);
      }
      setStatus(`로봇#${entry.id} 재탐색 완료 (${result.distance.toFixed(2)}m)`);
      renderActiveList();
    } catch (err) {
      if (!activeAnimations.includes(entry)) return;
      console.error('재탐색 실패', err);
      entry.rerouteInFlight = false;
      setStatus(`로봇#${entry.id} 재탐색 실패: ${err.message}`);
      renderActiveList();
    }
  }

  function reset() {
    activeAnimations.forEach((a) => a.stop());
    activeAnimations.length = 0;
    nextAnimId = 1;
    lastPausedCount = 0;
    conflictLineFeatures.clear();
    conflictSource.clear();
    interactionSource.clear();
    pendingRole = 'start';
    pendingStartCoord = null;
    renderActiveList();
    setStatus(config.hint);
  }

  function randomPointOnGraph() {
    const links = nodeLinkSource
      .getFeatures()
      .filter((f) => f.getGeometry().getType() === 'LineString');
    if (links.length === 0) return null;
    const line = links[Math.floor(Math.random() * links.length)].getGeometry();
    const coords = line.getCoordinates();
    let total = 0;
    const lens = [0];
    for (let i = 1; i < coords.length; i++) {
      total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
      lens.push(total);
    }
    const target = Math.random() * total;
    let i = 1;
    while (i < lens.length && lens[i] < target) i++;
    const segStart = lens[i - 1];
    const segLen = lens[i] - segStart || 1;
    const t = (target - segStart) / segLen;
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  }

  function randomFreePoint() {
    const extent = pcdSource.getExtent();
    const hasExtent = extent.every(Number.isFinite);
    const [minX, minY, maxX, maxY] = hasExtent ? extent : [0, 0, MAP_SIZE_X, MAP_SIZE_Y];
    const blocks = nodeLinkSource
      .getFeatures()
      .filter((f) => f.getGeometry().getType() === 'Polygon')
      .map((f) => f.getGeometry().getCoordinates()[0]);

    for (let attempt = 0; attempt < 30; attempt++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);
      if (!blocks.some((ring) => pointInRing(x, y, ring))) {
        return [x, y];
      }
    }
    return [minX + (maxX - minX) / 2, minY + (maxY - minY) / 2];
  }

  function generateRandomPair() {
    const pick = mode === 'nodelink' ? randomPointOnGraph : randomFreePoint;
    const start = pick();
    const end = pick();
    if (!start || !end) {
      setStatus('랜덤 지점을 생성할 데이터(링크)가 없습니다.');
      return;
    }

    const startFeature = new Feature(new PointGeom(start));
    startFeature.set('role', 'start');
    startFeature.setStyle(markerStyle('start'));
    const endFeature = new Feature(new PointGeom(end));
    endFeature.set('role', 'end');
    endFeature.setStyle(markerStyle('end'));
    interactionSource.addFeatures([startFeature, endFeature]);

    requestPath(start, end, [startFeature, endFeature]);
  }

  // --- 툴바 UI ---
  panelEl.innerHTML = '';
  panelEl.classList.add('pathfinding-panel');

  const title = document.createElement('div');
  title.className = 'pathfinding-panel-title';
  title.textContent = isOperate ? '플릿 보드' : `시나리오 · ${config.title}`;
  panelEl.appendChild(title);

  const robotSelect = document.createElement('select');
  robotSelect.className = 'pathfinding-select';
  const customOption = document.createElement('option');
  customOption.value = '';
  customOption.textContent = '로봇: 사용자 지정 (알고리즘 직접 선택)';
  robotSelect.appendChild(customOption);
  if (!isOperate) panelEl.appendChild(robotSelect);

  const algorithmSelect = document.createElement('select');
  algorithmSelect.className = 'pathfinding-select';
  config.algorithms.forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    algorithmSelect.appendChild(opt);
  });
  if (!isOperate) panelEl.appendChild(algorithmSelect);

  robotSelect.addEventListener('change', () => {
    const robot = robotsById.get(robotSelect.value);
    if (robot) {
      algorithmSelect.value = robot.algorithm;
      algorithmSelect.disabled = true;
    } else {
      algorithmSelect.disabled = false;
    }
  });

  async function loadRobots() {
    try {
      const robots = await listRobots();
      robots
        .filter((r) => validAlgorithms.has(r.algorithm))
        .forEach((robot) => {
          robotsById.set(robot.id, robot);
          const opt = document.createElement('option');
          opt.value = robot.id;
          opt.textContent = `${robot.name} (${typeLabel(robot.type)})`;
          robotSelect.appendChild(opt);
        });
    } catch (err) {
      console.error('로봇 목록을 불러오지 못했습니다.', err);
    }
  }
  loadRobots();

  // --- 실제 로봇 이동 명령 (VDA5050) --------------------------------------
  // 레지스트리에 vda5050Serial 이 있는 로봇(플릿 브리지가 자동 등록한 시뮬레이터 로봇
  // 포함)을 고르고 "목적지 클릭"을 누른 뒤 지도를 클릭하면, 로봇의 현재 위치(플릿
  // 스트림)에서 그 지점까지 경로를 찾아 order 로 보낸다. 경로는 주황 점선으로 남고
  // 로봇 마커(실시간 위치 레이어)가 실제로 따라가는 것을 본다. doc/vda5050-rcs.md.
  const commandBox = document.createElement('div');
  commandBox.className = 'pathfinding-command';
  const commandTitle = document.createElement('div');
  commandTitle.className = 'pathfinding-command-title';
  commandTitle.textContent = '실제 로봇 이동 명령 (VDA5050)';
  const commandSelect = document.createElement('select');
  commandSelect.className = 'pathfinding-select';
  const commandBtn = document.createElement('button');
  commandBtn.className = 'pathfinding-button pathfinding-command-button';
  commandBtn.textContent = '목적지 클릭';
  const commandStatus = document.createElement('div');
  commandStatus.className = 'pathfinding-command-status';
  // 운영 화면(플릿 스튜디오 디자인): 명령 UI는 지도 아래 액션 바(선택 로봇 · 목적지 지정 ·
  // 일시정지 · 주문 취소 · 진행률)로 가고, 왼쪽 레일에는 플릿 보드만, 오른쪽(sideEl)에는
  // 주문 목록/현장 요약 패널이 붙는다. 시뮬레이션 화면은 예전처럼 명령 박스를 패널에 둔다.
  let actionBar = null;
  let sidePanel = null;
  if (isOperate) {
    commandBtn.textContent = '목적지 지정';
    actionBar = buildActionBar();
    mapEl.appendChild(actionBar.el);
    const boardEl = document.createElement('div');
    panelEl.appendChild(boardEl);
    // 플릿 보드는 선택된 로봇의 스트림 갱신마다 onSelect 를 다시 부른다 -- 선택이 실제로
    // 바뀐 때만 상태 문구를 바꿔야 "경로 계산 중/전송/실패" 메시지가 덮이지 않는다.
    let lastSelectedSerial = null;
    fleetBoard = createFleetBoard(boardEl, {
      onSelect: (r) => {
        if (r?.registry && commandRobotsById.has(r.registry.id)) commandSelect.value = r.registry.id;
        const serial = r?.serialNumber ?? null;
        setSelectedRobotSerial(serial); // 지도 마커에 선택 표시(liveRobotPose.js)
        if (serial !== lastSelectedSerial) {
          lastSelectedSerial = serial;
          commandStatus.textContent = r ? `${r.registry?.name ?? r.serialNumber} 선택됨` : '';
        }
        updateActionBar();
      },
      onStatus: (text) => { commandStatus.textContent = text; },
    });
    if (sideEl) sidePanel = createOperateSidePanel(sideEl);
  } else {
    // 시뮬레이션(데모) 화면에는 실제 로봇 명령 박스를 두지 않는다 -- 운영 화면의 일이다(중복 제거).
    // 요소는 만들어 두되 붙이지 않아 아래 명령 로직(commandSelect 등)은 그대로 동작한다.
    commandBox.append(commandTitle, commandSelect, commandBtn, commandStatus);
  }

  let commandMode = false;
  const fleetBySerial = new Map(); // serialNumber -> 플릿 레코드(position, connectionState, state)
  const commandRobotsById = new Map(); // 레지스트리 id -> robot (vda5050Serial 있는 것만)
  const commandFeatures = new Map(); // serialNumber -> [경로 LineString, 목적지 핀]
  let brokerConnected = false;

  function setCommandMode(on) {
    commandMode = on;
    if (isOperate) draw.setActive(on);
    commandBtn.classList.toggle('active', on);
    commandBtn.textContent = on ? '지도를 클릭하세요 (취소)' : isOperate ? '목적지 지정' : '목적지 클릭';
    if (on) commandStatus.textContent = '목적지를 지도에서 클릭하세요.';
  }
  commandBtn.addEventListener('click', () => setCommandMode(!commandMode));

  // VDA5050 instantActions 표준 의미: startPause = 일시정지, stopPause = 재개 (2026-09-06 로봇·RCS 양쪽 정정).
  const PAUSE_ACTION = 'startPause';
  const RESUME_ACTION = 'stopPause';

  function buildActionBar() {
    const el = document.createElement('div');
    el.className = 's2m-actionbar';
    const who = document.createElement('div');
    who.className = 's2m-actionbar__who';
    const name = document.createElement('div');
    name.className = 's2m-actionbar__name';
    name.textContent = '로봇을 선택하세요';
    const serial = document.createElement('div');
    serial.className = 's2m-actionbar__serial';
    serial.textContent = '왼쪽 목록에서 선택';
    who.append(name, serial);
    const pill = document.createElement('span');
    pill.className = 's2m-pill s2m-pill--dim';
    pill.textContent = '-';
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'pathfinding-button';
    pauseBtn.textContent = '일시정지';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'pathfinding-button s2m-actionbar__danger';
    cancelBtn.textContent = '주문 취소';
    const spacer = document.createElement('div');
    spacer.className = 's2m-actionbar__spacer';
    const progress = document.createElement('div');
    progress.className = 's2m-progress';
    progress.hidden = true;
    const progressBar = document.createElement('div');
    progressBar.className = 's2m-progress__bar';
    const progressFill = document.createElement('div');
    progressFill.className = 's2m-progress__fill';
    progressBar.appendChild(progressFill);
    const progressText = document.createElement('span');
    progress.append(progressBar, progressText);
    commandSelect.classList.add('s2m-actionbar__select');
    commandSelect.hidden = true; // 대상 로봇은 왼쪽 플릿 보드 행을 눌러 고른다(셀렉트는 로직용으로만 남김)
    commandStatus.classList.add('s2m-actionbar__status');
    el.append(who, pill, commandSelect, commandBtn, pauseBtn, cancelBtn, spacer, progress, commandStatus);

    const selectedFleet = () => {
      const robot = commandRobotsById.get(commandSelect.value);
      return robot ? fleetBySerial.get(robot.vda5050Serial) : null;
    };
    async function instant(btn, type, label) {
      const fleet = selectedFleet();
      if (!fleet) {
        commandStatus.textContent = '로봇을 먼저 선택하세요.';
        return;
      }
      btn.disabled = true;
      try {
        await sendFleetInstantAction(fleet.manufacturer, fleet.serialNumber, type);
        commandStatus.textContent = `${fleet.serialNumber}: ${label} 전송`;
      } catch (err) {
        commandStatus.textContent = `${fleet.serialNumber}: ${label} 실패 — ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    }
    pauseBtn.addEventListener('click', () => {
      const paused = selectedFleet()?.state?.paused;
      instant(pauseBtn, paused ? RESUME_ACTION : PAUSE_ACTION, paused ? '재개' : '일시정지');
    });
    cancelBtn.addEventListener('click', () => instant(cancelBtn, 'cancelOrder', '주문 취소'));
    commandSelect.addEventListener('change', () => updateActionBar());
    return { el, name, serial, pill, pauseBtn, cancelBtn, progress, progressFill, progressText };
  }

  function updateActionBar() {
    if (!actionBar) return;
    const robot = commandRobotsById.get(commandSelect.value);
    const fleet = robot ? fleetBySerial.get(robot.vda5050Serial) : null;
    const s = fleet?.state;
    const online = brokerConnected && fleet?.connectionState === 'ONLINE';
    actionBar.name.textContent = robot?.name ?? '로봇을 선택하세요';
    actionBar.serial.textContent = robot ? `${robot.vda5050Serial} · ${fleet?.manufacturer ?? robot.company ?? ''}` : '왼쪽 목록에서 선택';
    let pillText = '-';
    let pillClass = 's2m-pill--dim';
    if (robot) {
      if (!online) pillText = '오프라인';
      else if ((s?.safetyState?.eStop ?? 'NONE') !== 'NONE') { pillText = 'E-STOP'; pillClass = 's2m-pill--danger'; }
      else if (s?.paused) { pillText = '일시정지'; pillClass = 's2m-pill--warn'; }
      else if (s?.driving) { pillText = '주행 중'; pillClass = 's2m-pill--success'; }
      else { pillText = '유휴'; pillClass = 's2m-pill--accent'; }
    }
    actionBar.pill.textContent = pillText;
    actionBar.pill.className = `s2m-pill ${pillClass}`;
    actionBar.pauseBtn.textContent = s?.paused ? '재개' : '일시정지';
    actionBar.pauseBtn.disabled = !online;
    actionBar.cancelBtn.disabled = !online || !s?.orderId;
    const total = fleet?.lastOrder?.waypoints ?? 0;
    const left = s?.nodesLeft ?? 0;
    if (online && s?.orderId && total > 0 && left > 0) {
      const pct = Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
      actionBar.progress.hidden = false;
      actionBar.progressFill.style.width = `${pct}%`;
      actionBar.progressText.textContent = `주문 ${String(s.orderId).slice(0, 8)} · ${total - left}/${total} 노드 · ${pct}%`;
    } else {
      actionBar.progress.hidden = true;
    }
  }

  // 오른쪽 사이드 패널 + 액션 바를 플릿 스트림의 현재 상태로 맞춘다.
  // 운영 알림 배너: 스트림 상태를 한 줄로 (브로커 · E-STOP · FATAL 오류 · 연결 끊김 · 근접 · 일시정지)
  const alertsEl = isOperate ? document.getElementById('operate-alerts') : null;
  function renderAlerts() {
    if (!alertsEl) return;
    const items = [];
    if (!brokerConnected) items.push({ tone: 'danger', text: 'MQTT 브로커 연결 없음 — 로봇 상태와 명령이 전달되지 않습니다', hint: '설정 › 연결' });
    const robots = Array.from(fleetBySerial.values());
    const name = (r) => Array.from(commandRobotsById.values()).find((x) => x.vda5050Serial === r.serialNumber)?.name ?? r.serialNumber;
    for (const r of robots) {
      const st = r.state;
      if (brokerConnected && r.connectionState === 'CONNECTIONBROKEN') items.push({ tone: 'warn', text: `${name(r)} 연결 끊김`, serial: r.serialNumber });
      if (!st) continue;
      if ((st.safetyState?.eStop ?? 'NONE') !== 'NONE') items.push({ tone: 'danger', text: `${name(r)} E-STOP (${st.safetyState.eStop})`, serial: r.serialNumber });
      for (const e of st.errors ?? []) {
        if (e.errorLevel === 'FATAL') items.push({ tone: 'danger', text: `${name(r)} ${e.errorType}: ${e.errorDescription ?? ''}`.trim(), serial: r.serialNumber });
      }
      if (st.paused) items.push({ tone: 'info', text: `${name(r)} 일시정지 중`, serial: r.serialNumber });
    }
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const a = robots[i], b = robots[j];
        if (a.position?.x == null || b.position?.x == null || a.connectionState !== 'ONLINE' || b.connectionState !== 'ONLINE') continue;
        const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        if (d < 1.2) items.push({ tone: 'warn', text: `${name(a)} · ${name(b)} 근접 ${d.toFixed(2)} m`, serial: a.serialNumber });
      }
    }
    alertsEl.replaceChildren();
    for (const it of items.slice(0, 6)) {
      const chip = document.createElement(it.serial ? 'button' : 'span');
      chip.className = `s2m-alert s2m-alert--${it.tone}`;
      chip.textContent = it.text;
      if (it.hint) chip.title = it.hint;
      if (it.serial) {
        chip.title = '플릿 보드에서 선택';
        chip.addEventListener('click', () => fleetBoard?.select(it.serial));
      }
      alertsEl.appendChild(chip);
    }
    if (items.length > 6) alertsEl.appendChild(Object.assign(document.createElement('span'), { className: 's2m-alert s2m-alert--info', textContent: `+${items.length - 6}` }));
  }

  // 주행 중인 로봇은 위치/state 메시지가 초당 여러 번 들어온다 -- 메시지마다 바로 syncSide()(알림 배너
  // replaceChildren 포함)를 부르면 배너 높이가 그만큼 자주 바뀌어 아래 플릿 보드가 들썩이고, 그 순간 카드를
  // 누르면 클릭이 다른 자리로 간다. 짧은 지연으로 묶는다. requestAnimationFrame이 아니라 setTimeout을 쓴다 --
  // 운영 화면은 사용자가 다른 창/탭에 가 있어도 계속 최신 상태를 유지해야 하는데, rAF는 탭/창이 백그라운드면
  // 브라우저가 통째로 멈춰버려서 돌아올 때까지 화면이 낡은 채로 멈춘다(fleetBoard.js 에서 실제로 이 문제로 재현/디버깅함).
  let syncSideTimer = null;
  function scheduleSyncSide() {
    if (syncSideTimer) return;
    syncSideTimer = setTimeout(() => {
      syncSideTimer = null;
      syncSide();
    }, 50);
  }
  function syncSide() {
    updateActionBar();
    renderAlerts();
    if (!sidePanel) return;
    const registryBySerial = new Map();
    for (const r of commandRobotsById.values()) registryBySerial.set(r.vda5050Serial, r);
    sidePanel.update({ robots: Array.from(fleetBySerial.values()), brokerConnected, registryBySerial });
  }

  function refreshCommandOptions() {
    const prev = commandSelect.value;
    commandSelect.replaceChildren();
    if (commandRobotsById.size === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'VDA5050 로봇 없음 (플릿 탭에서 브로커 연결)';
      commandSelect.appendChild(opt);
      commandBtn.disabled = true;
      return;
    }
    for (const robot of commandRobotsById.values()) {
      const fleet = fleetBySerial.get(robot.vda5050Serial);
      const online = brokerConnected && fleet?.connectionState === 'ONLINE';
      const opt = document.createElement('option');
      opt.value = robot.id;
      opt.textContent = `${robot.name} · ${robot.vda5050Serial} (${online ? '온라인' : '오프라인'})`;
      commandSelect.appendChild(opt);
    }
    if (prev && commandRobotsById.has(prev)) commandSelect.value = prev;
    commandBtn.disabled = false;
  }

  async function loadCommandRobots() {
    try {
      const robots = await listRobots();
      commandRobotsById.clear();
      for (const r of robots) if (r.vda5050Serial) commandRobotsById.set(r.id, r);
      refreshCommandOptions();
      syncSide();
    } catch (err) {
      console.error('이동 명령 로봇 목록 조회 실패', err);
    }
  }

  const fleetStream = subscribeFleetStream((msg) => {
    if (msg.type === 'snapshot') {
      brokerConnected = msg.status?.connected === true;
      fleetBySerial.clear();
      for (const r of msg.robots) fleetBySerial.set(r.serialNumber, r);
      loadCommandRobots();
      scheduleSyncSide();
      sidePanel?.loadHistory(msg.robots.map((r) => r.serialNumber));
    } else if (msg.type === 'robot') {
      const isNew = !fleetBySerial.has(msg.robot.serialNumber);
      fleetBySerial.set(msg.robot.serialNumber, msg.robot);
      if (isNew) setTimeout(loadCommandRobots, 800); // 서버 자동 등록 뒤 다시 읽기
      else refreshCommandOptions();
      scheduleSyncSide();
      // 주문을 다 끝냈으면(남은 노드 0, 주행 아님) 그려둔 계획 경로를 지운다.
      const st = msg.robot.state;
      if (st && st.nodesLeft === 0 && !st.driving && commandFeatures.has(msg.robot.serialNumber)) {
        clearCommandFeatures(msg.robot.serialNumber);
        commandStatus.textContent = `${msg.robot.serialNumber}: 도착 (${st.lastNodeId || '-'})`;
      }
    } else if (msg.type === 'status') {
      brokerConnected = msg.status?.connected === true;
      refreshCommandOptions();
      scheduleSyncSide();
    } else if ((msg.type === 'order' || msg.type === 'order_update') && msg.order) {
      sidePanel?.upsertOrder(msg.order);
    }
  });

  function clearCommandFeatures(serial) {
    for (const f of commandFeatures.get(serial) ?? []) interactionSource.removeFeature(f);
    commandFeatures.delete(serial);
  }

  // 다른 활성 플릿 로봇들의 현재 위치를 장애물 블록(kind: "block")으로 변환해
  // 플래너에 함께 넘긴다. 로봇들이 서로를 겹치거나 통과해 지나가는 경로 생성을 방지.
  function otherRobotObstacleFeatures(excludeSerial) {
    const features = [];
    for (const [serial, fleet] of fleetBySerial.entries()) {
      if (serial === excludeSerial || !fleet.position || typeof fleet.position.x !== 'number') continue;
      // 다른 현장의 mapId면 이 현장 장애물로 넣지 않는다 (다른 좌표계라 같은 x,y가 무의미).
      if (fleet.position.mapId && fleet.position.mapId !== activeProjectName) continue;
      const otherReg = commandRobotsById.get(serial) ?? null;
      const r = (otherReg?.sizeMeters ?? 0.35) * 0.7;
      const x = fleet.position.x;
      const y = fleet.position.y;
      const ring = [
        [x - r, y - r],
        [x + r, y - r],
        [x + r, y + r],
        [x - r, y + r],
        [x - r, y - r],
      ];
      const feat = new Feature({ geometry: new Polygon([ring]) });
      feat.set('kind', 'block');
      feat.set('name', `robot-${serial}`);
      features.push(feat);
    }
    return features;
  }

  // 이동 명령의 계획 경로(주황 점선) -- M3 커밋(5e4f761)에서 정의가 실수로 지워져
  // 경로 계산 뒤 ReferenceError 로 주문이 나가지 않던 것을 되살림.
  const COMMAND_PATH_STYLE = new Style({ stroke: new Stroke({ color: '#ff9800', width: 3, lineDash: [8, 6] }) });

  async function sendMoveCommand(goalCoord) {
    const robot = commandRobotsById.get(commandSelect.value);
    if (!robot) {
      commandStatus.textContent = '이동시킬 로봇을 고르세요.';
      return;
    }
    const fleet = fleetBySerial.get(robot.vda5050Serial);
    if (!fleet?.position) {
      commandStatus.textContent = `${robot.name}: 현재 위치를 아직 받지 못했습니다 (브로커/로봇 연결 확인).`;
      return;
    }
    commandStatus.textContent = `${robot.name}: 경로 계산 중...`;
    const otherRobots = otherRobotObstacleFeatures(robot.vda5050Serial);
    const featureCollection = geojsonFormat.writeFeaturesObject([
      ...nodeLinkSource.getFeatures(),
      ...importedBlockFeatures(),
      ...otherRobots,
    ]);
    const start = { x: fleet.position.x, y: fleet.position.y };
    const end = { x: goalCoord[0], y: goalCoord[1] };
    const algorithm = validAlgorithms.has(robot.algorithm) ? robot.algorithm : algorithmSelect.value;
    try {
      const result =
        mode === 'nodelink'
          ? await findNodeLinkPath({ featureCollection, start, end, algorithm })
          : await findObstaclePath({
              featureCollection,
              start,
              end,
              algorithm,
              // 실제 주행이라 촘촘한 격자(0.1 m) + 로봇 반경 인플레이션: 벽에 붙은 경로가 나오면
              // 순수 추종(lookahead 0.3 m)이 모서리를 깎아 몸체가 벽에 걸린다.
              cellSize: 0.1,
              inflationM: inflationForRobot(robot.sizeMeters, DEFAULT_SIZE_M),
            });
      clearCommandFeatures(robot.vda5050Serial);
      const line = new Feature(new LineString(result.path));
      line.setStyle(COMMAND_PATH_STYLE);
      const pin = new Feature(new PointGeom(goalCoord));
      pin.setStyle(markerStyle('end'));
      interactionSource.addFeatures([line, pin]);
      commandFeatures.set(robot.vda5050Serial, [line, pin]);
      const sent = await sendFleetOrder(fleet.manufacturer, fleet.serialNumber, result.path, { mapId: activeProjectName });
      commandStatus.textContent = `${robot.name}: order ${String(sent.orderId).slice(0, 8)}… 전송 (${result.distance.toFixed(2)} m, 노드 ${result.path.length}개, ${result.algorithm})`;
    } catch (err) {
      console.error('이동 명령 실패', err);
      commandStatus.textContent = `${robot.name}: 실패 — ${err.message}`;
    }
  }

  const conflictModeRow = document.createElement('div');
  conflictModeRow.className = 'pathfinding-conflict-mode';
  const conflictModeLabel = document.createElement('span');
  conflictModeLabel.textContent = '충돌 시:';
  const conflictModeSelect = document.createElement('select');
  conflictModeSelect.className = 'pathfinding-select';
  [
    ['pause', '정지 후 재개'],
    ['reroute', '재탐색 (re-routing)'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    conflictModeSelect.appendChild(opt);
  });
  conflictModeRow.append(conflictModeLabel, conflictModeSelect);
  if (!isOperate) panelEl.appendChild(conflictModeRow);

  const activeListEl = document.createElement('div');
  activeListEl.className = 'pathfinding-active-list';
  if (!isOperate) panelEl.appendChild(activeListEl);

  // 드래그 중인 항목의 id — dragover/drop 핸들러끼리 공유하는 상태.
  let draggedAnimId = null;

  function reorderPriority(draggedId, targetId) {
    const sorted = [...activeAnimations].sort((a, b) => a.priority - b.priority);
    const fromIdx = sorted.findIndex((a) => a.id === draggedId);
    const toIdx = sorted.findIndex((a) => a.id === targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const [moved] = sorted.splice(fromIdx, 1);
    sorted.splice(toIdx, 0, moved);
    sorted.forEach((a, idx) => {
      a.priority = idx;
    });
    renderActiveList();
  }

  // 로봇을 선택하는 콤보 박스 밑에, 현재 길찾기 진행 중인 경로를 실시간으로
  // 보여준다 — 각 항목은 해당 경로 선과 같은 색 스와치 + 생성 번호(#id, 마커
  // 아이콘 위 숫자와 동일)를 표시하고, 드래그앤드롭으로 우선순위를 바꿀 수 있다.
  function renderActiveList() {
    activeListEl.innerHTML = '';
    const sorted = [...activeAnimations].sort((a, b) => a.priority - b.priority);

    if (sorted.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pathfinding-list-empty';
      empty.textContent = '진행 중인 경로 없음';
      activeListEl.appendChild(empty);
      return;
    }

    sorted.forEach((anim, rank) => {
      const row = document.createElement('div');
      row.className = 'pathfinding-list-row';
      row.draggable = true;
      row.dataset.animId = String(anim.id);

      const swatch = document.createElement('span');
      swatch.className = 'pathfinding-list-swatch';
      swatch.style.background = anim.color;

      const idBadge = document.createElement('span');
      idBadge.className = 'pathfinding-list-id';
      idBadge.textContent = `#${anim.id}`;

      const priorityBadge = document.createElement('span');
      priorityBadge.className = 'pathfinding-list-priority';
      priorityBadge.textContent = `우선순위 ${rank + 1}`;

      const nameEl = document.createElement('span');
      nameEl.className = 'pathfinding-list-name';
      let nameText = anim.robotName || '사용자 지정';
      if (anim.rerouteInFlight) nameText += ' (재탐색 중...)';
      else if (anim.isPaused()) nameText += ' (대기 중)';
      nameEl.textContent = nameText;

      const simBtn = document.createElement('button');
      simBtn.className = 'pathfinding-list-sim-button';
      simBtn.textContent = '시뮬레이터로 실행';
      // 등록 로봇에 VDA5050 serial 이 있으면 그 로봇으로(order), 아니면 예전 기본 시뮬레이터 id로.
      const targetRobotId = anim.selectedRobot?.vda5050Serial || SIM_ROBOT_ID;
      simBtn.title = `이 경로를 ${targetRobotId} 로 전송 (VDA5050 order 또는 drive-request 릴레이)`;
      // 드래그앤드롭 정렬용 row.draggable=true 아래 버튼이라, 클릭이 드래그로
      // 오인되지 않도록 mousedown 전파를 막는다.
      simBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      simBtn.addEventListener('click', async () => {
        if (!anim.pathCoords) return;
        simBtn.disabled = true;
        try {
          const sent = await sendDriveRequest(targetRobotId, anim.pathCoords);
          // 서버가 로봇이 VDA5050(MQTT)로 온라인이면 order로, 아니면 예전 WebSocket 릴레이로 보낸다.
          const via = sent.transport === 'vda5050' ? `VDA5050 order ${String(sent.orderId).slice(0, 8)}…` : 'drive-request 릴레이';
          setStatus(`로봇#${anim.id} 경로를 ${targetRobotId} 로 전송했습니다 (${via}).`);
        } catch (err) {
          console.error('시뮬레이터 전송 실패', err);
          setStatus(`시뮬레이터 전송 실패: ${err.message}`);
        } finally {
          simBtn.disabled = false;
        }
      });

      row.append(swatch, idBadge, priorityBadge, nameEl, simBtn);
      activeListEl.appendChild(row);

      row.addEventListener('dragstart', () => {
        draggedAnimId = anim.id;
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        draggedAnimId = null;
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (draggedAnimId === null || draggedAnimId === anim.id) return;
        reorderPriority(draggedAnimId, anim.id);
      });
    });
  }
  renderActiveList();

  const buttonRow = document.createElement('div');
  buttonRow.className = 'pathfinding-button-row';
  const randomBtn = document.createElement('button');
  randomBtn.className = 'pathfinding-button';
  randomBtn.textContent = '랜덤 생성';
  randomBtn.addEventListener('click', generateRandomPair);
  const resetBtn = document.createElement('button');
  resetBtn.className = 'pathfinding-button';
  resetBtn.textContent = '초기화';
  resetBtn.addEventListener('click', reset);
  buttonRow.append(randomBtn, resetBtn);
  if (!isOperate) panelEl.appendChild(buttonRow);

  const statusEl = document.createElement('div');
  statusEl.className = 'pathfinding-status';
  panelEl.appendChild(statusEl);

  function setStatus(text) {
    statusEl.textContent = text;
  }
  setStatus(isOperate ? '왼쪽 목록에서 로봇을 고르고 "목적지 지정" 뒤 지도를 클릭하세요.' : config.hint);

  function resize() {
    map.updateSize();
  }

  function fitToData() {
    // PCD -> 스캔 장애물 -> 프로젝트 평면 순으로 맞출 범위를 고른다 (스캔 프로젝트는 PCD 가 없다).
    let extent = pcdSource.getExtent();
    if (!extent.every(Number.isFinite)) extent = importedObstacleSource.getExtent();
    if (!extent.every(Number.isFinite)) extent = [0, 0, MAP_SIZE_X, MAP_SIZE_Y];
    map.updateSize();
    map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 7 });
  }

  return { map, resize, fitToData, reset };
}
