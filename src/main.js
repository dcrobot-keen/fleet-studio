import './style.css';
import './theme-s2m.css'; // Fleet Studio 디자인(S2M 목업) 토큰 + 앱 셸, style.css 위에 덮어씀
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import ImageLayer from 'ol/layer/Image.js';
import ImageStatic from 'ol/source/ImageStatic.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { defaults as defaultControls } from 'ol/control.js';
import ScaleLine from 'ol/control/ScaleLine.js';
import MousePosition from 'ol/control/MousePosition.js';
import { createStringXY } from 'ol/coordinate.js';
import { parsePcd } from './pcd.js';
import { createView3D } from './view3d.js';
import { buildHeightBands, createSliceLayers, renderSlicePanel } from './heightSlices.js';
import VectorLayer from 'ol/layer/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { createEditLayer } from './editLayer.js';
import { buildGridLayer } from './grid2d.js';
import { indoorProjection, MAP_SIZE_X, MAP_SIZE_Y, activeProjectId, activeProjectName, pcdSource, importedObstacleSource, liveRobotPoseSource, activeProjectImportedRoom, activeProjectFloorImage, activeProjectSlicemap } from './appShared.js';
import { importedObstacleStyle, createImportedObstaclesPanel } from './importedObstacles.js';
import { loadImportedObstacles } from './importedObstaclesApi.js';
import { startLiveRobotPoseTracking } from './liveRobotPose.js';
import { createPathfindingTab } from './pathfinding/tab.js';
import { createRobotRegistryTab } from './robots/robotRegistry.js';
import { createBrokerSettings } from './fleet/brokerSettings.js';
import { createProjectSelector } from './projects/projectSelector.js';
import { subscribeFleetStream, getFleetConfig } from './fleet/fleetApi.js';
import { openScanWizardModal, initScanWizardModal } from './scanStudio/scanWizardModal.js';
import { consumePendingAlignGroup } from './scanStudio/pendingAlignGroup.js';
import { createAlignWorkspace } from './scanStudio/alignWorkspace.js';
import { createDigitalTwinPanel } from './digitalTwin/digitalTwinPanel.js';
import { createImportDialog, attachDropTarget } from './imports/importDialog.js';
import { getServiceUrl } from './servicesConfig.js';
import { importSlicemapFiles } from './imports/importSlicemap.js';
import { importRobotMapFiles } from './imports/importRobotMap.js';
import { importFloorImageFile } from './imports/importFloorImage.js';
import { createSite3D } from './site3d/site3dView.js';
import { createSimStatusPanel } from './simulation/simStatusPanel.js';
import { createSimViewerFrame } from './simulation/simViewerFrame.js';
import { openRobotDrawer } from './robots/robotDrawer.js';
import { listRobots } from './robots/robotApi.js';

createProjectSelector(document.getElementById('project-selector'));
initScanWizardModal();
document.title = `Pathfinder — ${activeProjectName}`;

const SLICE_HEIGHT_M = 0.5;

// 2D 지도 맨 아래 깔리는 배경 도면. data/에 있는 파일을 vite 에셋으로 바로
// 참조한다(별도 서버/정적 경로 설정 없이 dev·build 양쪽에서 동작).
// 실측 동서(가로) 폭은 25.923m. 이미지 픽셀이 정사각형(3840x3840)이라 남북(세로)도
// 같은 축척(25.923m)으로 가정했다 — 세로 실측이 다르면 BLUEPRINT_HEIGHT_M만
// 따로 바꾸면 된다. world file(정확한 원점 옵셋)이 없어서 우선 지도 원점(0,0)에
// 왼쪽 아래를 맞춰 깔았다 — 실제 배치 지점이 다르면 imageExtent의 원점을
// 옮겨야 한다.
const BLUEPRINT_WIDTH_M = 25.923;
const BLUEPRINT_HEIGHT_M = 25.923;
const BLUEPRINT_URL = new URL('../data/blueprint_9108.jpg', import.meta.url).href;
// 스캔 지도로 만든 프로젝트(from-slicemap + floor)는 앱의 바닥 이미지를 배경으로 깐다 --
// 정합 워크스페이스가 같은 격자로 합성해 publish 한 <group>.floor.png. 없으면 예전 샘플 도면.
const BLUEPRINT_LABEL = activeProjectFloorImage ? '바닥 이미지' : '배경 도면';
const blueprintLayer = new ImageLayer({
  source: new ImageStatic(
    activeProjectFloorImage
      ? { url: activeProjectFloorImage.url, imageExtent: activeProjectFloorImage.extent, projection: indoorProjection }
      : { url: BLUEPRINT_URL, imageExtent: [0, 0, BLUEPRINT_WIDTH_M, BLUEPRINT_HEIGHT_M], projection: indoorProjection }
  ),
  // 샘플 도면은 꺼둔 채 시작(레이어 패널에서 켬); 스캔 바닥 이미지는 프로젝트의 것이라 바로 보인다.
  visible: Boolean(activeProjectFloorImage),
  opacity: activeProjectFloorImage ? 0.85 : 1,
});

const gridLayer = buildGridLayer(MAP_SIZE_X, MAP_SIZE_Y, 10);

// scan-to-map-studio에서 가져온(import) 장애물 블록 레이어 (공유 소스, appShared.js 참고)
const importedObstacleLayer = new VectorLayer({ source: importedObstacleSource, style: importedObstacleStyle });

// 실시간 로봇 위치 레이어. WebSocket 연결은 여기서 한 번만 시작하고, 길찾기(장애물)
// 탭은 같은 liveRobotPoseSource를 자기 레이어로만 감싼다(appShared.js 참고).
const liveRobotPoseLayer = new VectorLayer({ source: liveRobotPoseSource, zIndex: 20 });
startLiveRobotPoseTracking(liveRobotPoseSource);

const map = new Map({
  target: 'map-canvas', // #map 은 [캔버스 | 도크] 그리드, OL 은 캔버스 칸에만
  layers: [blueprintLayer, gridLayer, importedObstacleLayer, liveRobotPoseLayer],
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
    // 이 extent는 "화면 중심이 벗어날 수 없는 범위"로만 쓴다(constrainOnlyCenter).
    // 기본값(false)이면 확대/축소 배율도 이 extent 안에 다 들어오게 강제되는데,
    // 데이터는 세로가 긴 200x400인데 브라우저 창은 보통 가로로 넓어서(landscape),
    // 그 상태로 축소하면 필요한 배율이 extent의 가로 폭을 넘어버려 OL이 축소를
    // 막아버린다 — 그 결과 세로(400m)를 다 못 보여주고 잘렸다. 그냥 팬 범위만
    // 제한하고 배율 자체는 fit()이 정하는 대로 두면 해결된다.
    constrainOnlyCenter: true,
  }),
  controls: defaultControls().extend([
    new ScaleLine({ units: 'metric' }),
    new MousePosition({
      coordinateFormat: createStringXY(2),
      projection: indoorProjection,
      className: 'mouse-position',
    }),
  ]),
});

// 처음 실행 시 200x400m 공장 부지 전체가 보이도록 뷰를 맞춘다(고정 zoom 대신
// fit을 써서 가로세로 비율이 달라도 항상 전체 부지가 프레임에 들어오게 함).
// updateSize()를 먼저 호출해야 한다 — 생성 직후에는 OL이 아직 컨테이너 크기를
// 측정하지 않은 상태라, 그 전에 fit()을 부르면 잘못된(0에 가까운) 크기 기준으로
// 계산해서 세로(400m)가 다 안 보이는 등 엉뚱한 확대 배율이 나올 수 있다.
map.updateSize();
map.getView().fit([0, 0, MAP_SIZE_X, MAP_SIZE_Y], { padding: [20, 20, 20, 20] });

// 컬러드 PCD(3D) 포인트 클라우드 레이어 ("전체(비분류)" 옵션으로 남겨둠)
const pcdLayer = new WebGLVectorLayer({
  source: pcdSource,
  style: {
    'circle-radius': 2,
    'circle-fill-color': ['color', ['get', 'r'], ['get', 'g'], ['get', 'b']],
    'circle-opacity': 0.9,
  },
});
map.addLayer(pcdLayer);

// 노드/링크/블록 편집 레이어 (GeoJSON 파일 DB에 저장)
const editLayerApi = createEditLayer(map, indoorProjection, document.getElementById('edit-panel'));

// "스캔 장애물" 패널: scan-to-map-studio에서 가져온(import) 방을 골라 불러온다.
const importedGeojsonFormat = new GeoJSON({
  dataProjection: indoorProjection,
  featureProjection: indoorProjection,
});
createImportedObstaclesPanel(
  document.getElementById('imported-obstacles-panel'),
  importedGeojsonFormat,
  map
);

// 스캔 지도로 만든 프로젝트(from-slicemap)는 자기 장애물 방을 열자마자 불러오고
// 그 범위로 뷰를 맞춘다 -- 사용자가 패널에서 다시 고르지 않아도 되도록.
if (activeProjectImportedRoom) {
  loadImportedObstacles(activeProjectImportedRoom)
    .then((fc) => {
      importedObstacleSource.clear();
      importedObstacleSource.addFeatures(importedGeojsonFormat.readFeatures(fc));
      const extent = importedObstacleSource.getExtent();
      if (extent.every(Number.isFinite)) map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 7 });
    })
    .catch((err) => console.error('프로젝트 스캔 장애물 자동 로드 실패', err));
}

// PCD를 아직 업로드하지 않은 초기 상태에도 레이어 토글 패널이 보이도록 먼저 한 번 그린다
// (배경 도면 / 노드·링크·블록만 — 높이 슬라이스·원본 PCD는 업로드 후에 채워짐).
renderSlicePanel(document.getElementById('slice-panel'), [], [], [
  { layer: blueprintLayer, label: BLUEPRINT_LABEL },
  { layer: importedObstacleLayer, label: '스캔 장애물' },
  { layer: editLayerApi.layer, label: '노드/링크/블록' },
  { layer: liveRobotPoseLayer, label: '실시간 로봇 위치' },
]);

// 탭 전환: GNB 5대 워크스페이스(지도·로봇·운영·시뮬레이션·설정) + Level 2 서브바 연동
const gnbTabButtons = document.querySelectorAll('.gnb-tab');
const viewEls = document.querySelectorAll('.view');
const view3dEl = document.getElementById('view3d-points'); // three.js 포인트클라우드 뷰의 컨테이너 (현장 3D 는 iframe)

// 워크스페이스 맥락별 Level 2 서브바
const subnavPanes = {
  maps: document.getElementById('subnav-maps'),
  robots: document.getElementById('subnav-robots'),
  operate: document.getElementById('subnav-operate'),
  simulation: document.getElementById('subnav-simulation'),
  settings: document.getElementById('subnav-settings'),
};

const mapSubnavTabs = document.querySelectorAll('#subnav-maps .subnav-tab');

let view3d = null;
let currentPoints = [];
let sliceLayers = [];
let operateTab = null;
let simulationTab = null;
let robotsTab = null;
let settingsTab = null;
let alignWorkspace = null;
let digitalTwinPanel = null;
let mapsSub = '2d';

// 탭 = 정보 구조(플릿 스튜디오 기획서 §5): 지도(2D/3D) · 로봇 · 운영 · 시뮬레이션 · 설정.
function showView(key) {
  viewEls.forEach((el) => el.classList.toggle('active', el.dataset.view === key));
}

function activateMapsSub(sub) {
  mapsSub = sub;
  mapSubnavTabs.forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  showView(sub);
  if (sub === '2d') {
    map.updateSize();
    return;
  }
  if (sub === 'align') {
    if (!alignWorkspace) {
      alignWorkspace = createAlignWorkspace(document.getElementById('view-align'), {
        onToast: showFleetToast,
        onTrainingDone: () => digitalTwinPanel?.refresh(),
      });
    }
    // 스캔 위저드가 방금 등록한 그룹을 넘겨줬으면(pendingAlignGroup.js), 그룹이 여러 개라 자동으로
    // 안 열리는 경우에도 곧장 그 그룹을 연다. show()가 먼저 드롭다운을 채워야 하므로 그 뒤에 연다.
    const pendingGroup = consumePendingAlignGroup();
    alignWorkspace.show().then(() => {
      if (pendingGroup) alignWorkspace.loadGroup(pendingGroup);
    });
    return;
  }
  if (sub === 'texture') {
    if (!digitalTwinPanel) digitalTwinPanel = createDigitalTwinPanel(document.getElementById('view-texture'));
    else digitalTwinPanel.refresh();
    return;
  }
  if (sub === 'studio') {
    const frame = document.getElementById('studio-frame');
    const link = document.getElementById('link-studio-external');
    const studioUrl = getServiceUrl('studio');
    if (frame && (!frame.src || !frame.src.includes('8000'))) frame.src = studioUrl;
    if (link) link.href = studioUrl;
    return;
  }
  // 3D: 현장 3D(네이티브 three.js) 또는 포인트클라우드
  if (view3dMode === 'points') {
    if (!view3d) {
      view3d = createView3D(view3dEl);
      if (currentPoints.length) view3d.setPoints(currentPoints);
    }
    requestAnimationFrame(() => view3d.resize());
  } else {
    if (!site3d) {
      site3d = createSite3D(document.getElementById('site3d'), {
        obstacleSource: importedObstacleSource,
        floorImage: activeProjectFloorImage,
        slicemap: activeProjectSlicemap,
        sizeX: MAP_SIZE_X,
        sizeY: MAP_SIZE_Y,
        scanFileUrl: (scan, file) => `/scan-files/${encodeURIComponent(scan)}/${file}`,
      });
    }
    requestAnimationFrame(() => site3d.resize());
  }
}
let site3d = null;

// 지도 › 3D 토글: 현장 3D / 포인트클라우드
let view3dMode = 'site';
function setView3dMode(mode) {
  view3dMode = mode;
  for (const b of document.querySelectorAll('[data-view3d]')) b.classList.toggle('active', b.dataset.view3d === mode);
  const siteEl = document.getElementById('site3d');
  if (siteEl) siteEl.hidden = mode !== 'site';
  if (view3dEl) view3dEl.hidden = mode !== 'points';
  const note = document.getElementById('view3d-note');
  if (note) note.textContent = mode === 'site' ? '벽 · 바닥 이미지 · 스캔 메시 · 플릿 로봇(실기·시뮬)' : `가져온 포인트클라우드 ${currentPoints.length.toLocaleString()}개`;
  if (mode === 'points' && mapsSub === '3d') activateMapsSub('3d');
}
for (const b of document.querySelectorAll('[data-view3d]')) b.addEventListener('click', () => { if (!b.disabled) setView3dMode(b.dataset.view3d); });
setView3dMode('site'); // 초기: 현장 3D 컨테이너를 보이게 (HTML 은 hidden 으로 시작)

// 스튜디오 프로젝트 새로고침 버튼
const studioRefreshBtn = document.getElementById('btn-studio-refresh');
if (studioRefreshBtn) {
  studioRefreshBtn.addEventListener('click', () => {
    window.location.reload();
  });
}

// 시뮬레이션 주 영역: 3D 뷰(시뮬레이터 뷰어 임베드) / 2D 데모(회피 애니메이션 지도) 토글, 로봇 시점 전환
const simMapEl = document.getElementById('simulation-map');
let simDemoFitted = false;
const simViewBtns = document.querySelectorAll('.sim-view-btn');
simViewBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.simview;
    simViewBtns.forEach((b) => b.classList.toggle('active', b === btn));
    if (simMapEl) simMapEl.hidden = view !== '2d';
    const frame = document.getElementById('sim-frame');
    if (frame) frame.hidden = view !== '3d';
    if (view === '2d') requestAnimationFrame(() => {
      simulationTab?.resize();
      if (!simDemoFitted) { simulationTab?.fitToData(); simDemoFitted = true; } // 숨긴 채 만들어져 처음엔 크기 0 이었다
    });
  });
});
createSimViewerFrame({ projectId: activeProjectId });

// 화면 헤더(crumb · 설명 · 상태 핀). 핀은 플릿 스트림이 채운다(아래 recountFleet).
const SCREEN_META = {
  maps: { label: '지도', desc: '2D/3D · 정합 스튜디오 · 스캔 지도 프로젝트' },
  robots: { label: '로봇', desc: '기기 목록 · 모델 카탈로그 · VDA5050 연결' },
  operate: { label: '운영', desc: '플릿 보드 · 지도 클릭 이동 · 주문/이벤트' },
  simulation: { label: '시뮬레이션', desc: '회피 데모 · 시뮬레이터 뷰어' },
  settings: { label: '설정', desc: '브로커 · 서비스 주소 · 좌표 규약' },
};
let currentTabKey = 'maps';
const screenCrumbSite = document.getElementById('screen-crumb-site');
const screenCrumbView = document.getElementById('screen-crumb-view');
const screenDesc = document.getElementById('screen-desc');
const navSiteTitle = document.getElementById('nav-site-title');
if (screenCrumbSite) screenCrumbSite.textContent = activeProjectName;
if (navSiteTitle) navSiteTitle.textContent = `현장 ${activeProjectName}`;
function updateScreenHeader() {
  const meta = SCREEN_META[currentTabKey] ?? SCREEN_META.maps;
  if (screenCrumbView) screenCrumbView.textContent = meta.label;
  if (screenDesc) screenDesc.textContent = meta.desc;
}
updateScreenHeader();

function activateTab(tabKey) {
  currentTabKey = tabKey;
  updateScreenHeader();
  // 리본(서브탭 줄)은 서브뷰가 둘 이상인 지도·로봇에만. 나머지 화면은 본문이 상단 바 바로 아래에 붙는다.
  document.body.classList.toggle('no-ribbon', tabKey !== 'maps' && tabKey !== 'robots');
  gnbTabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabKey));

  // 해당 워크스페이스의 Level 2 서브바만 활성화
  Object.entries(subnavPanes).forEach(([key, pane]) => {
    if (pane) pane.style.display = key === tabKey ? 'flex' : 'none';
  });

  if (tabKey === 'maps') {
    activateMapsSub(mapsSub);
    return;
  }
  showView(tabKey);

  if (tabKey === 'operate') {
    if (!operateTab) {
      operateTab = createPathfindingTab(document.getElementById('operate-map'), document.getElementById('operate-panel'), 'obstacle', {
        variant: 'operate',
        sideEl: document.getElementById('operate-side'),
      });
      operateTab.fitToData();
      setTimeout(() => operateTab?.fitToData(), 600); // 첫 프레임에 크기가 아직 0 이거나 장애물이 늦게 오는 경우
    }
    operateTab.resize();
    return;
  }

  if (tabKey === 'simulation') {
    if (!simulationTab) {
      simulationTab = createPathfindingTab(document.getElementById('simulation-map'), document.getElementById('simulation-panel'), 'obstacle', { variant: 'demo' });
      simulationTab.fitToData();
      createSimStatusPanel(document.getElementById('simulation-status'));
    }
    simulationTab.resize();
    return;
  }

  if (tabKey === 'robots') {
    if (!robotsTab) {
      robotsTab = createRobotRegistryTab(document.getElementById('robots'));
    } else {
      robotsTab.refresh?.();
    }
    return;
  }

  if (tabKey === 'settings') {
    if (!settingsTab) {
      settingsTab = createBrokerSettings(document.getElementById('settings'));
    }
  }
}

gnbTabButtons.forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
mapSubnavTabs.forEach((btn) => btn.addEventListener('click', () => activateMapsSub(btn.dataset.sub)));

// 지도 › 가져오기: 진입점 하나(버튼 + 지도 위 드롭). 종류별 처리는 src/imports.
const importDialog = createImportDialog({
  onScan: (file) => openScanWizardModal({ file }),
  onSlicemap: async (files) => {
    const project = await importSlicemapFiles(files);
    showFleetToast(`현장 프로젝트 생성: ${project.name}`);
    const url = new URL(location.href);
    url.searchParams.set('project', project.id);
    location.href = url.toString();
  },
  onPcd: (file) => loadPcdFile(file),
  onRobotMap: async (files) => {
    const { project, stats, warnings } = await importRobotMapFiles(files);
    showFleetToast(`로봇 지도 → 현장 ${project.name}: ${stats.cols}×${stats.rows}, 점유 ${stats.occupied.toLocaleString()}셀${warnings.length ? ` · ${warnings.join(' · ')}` : ''}`);
    const url = new URL(location.href);
    url.searchParams.set('project', project.id);
    setTimeout(() => { location.href = url.toString(); }, 1200);
  },
  onImage: async (file, metersPerPixel) => {
    const { project, sizeX, sizeY } = await importFloorImageFile(file, { metersPerPixel });
    showFleetToast(`도면 → 현장 ${project.name}: ${sizeX.toFixed(1)} × ${sizeY.toFixed(1)} m`);
    const url = new URL(location.href);
    url.searchParams.set('project', project.id);
    setTimeout(() => { location.href = url.toString(); }, 1200);
  },
  onToast: showFleetToast,
});
document.getElementById('btn-import')?.addEventListener('click', () => importDialog.open());
for (const id of ['map', 'view3d', 'view-align']) {
  const el = document.getElementById(id);
  if (el) attachDropTarget(el, importDialog, { isActive: () => currentTabKey === 'maps' });
}

// scan-to-map-studio 정합 워크스페이스(iframe)에서 정합 저장 완료 시 부모 창 통지 수신
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'scan-studio:saved') {
    const { group, published } = e.data;
    console.log('[Fleet Studio] Scan alignment saved event received:', e.data);
    showFleetToast(`'${group}' 정합 결과가 저장되었습니다.${published ? ' 새 스캔 지도로 즉시 전환할 수 있습니다.' : ''}`);
  }
});

function showFleetToast(message, duration = 4500) {
  const existing = document.querySelector('.fleet-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'fleet-toast';
  toast.innerHTML = `<span class="fleet-toast-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg></span> <span>${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// 로봇 탭 서브내비게이션 연동
const robotDevBtn = document.getElementById('subnav-robot-dev-btn');
const robotModelBtn = document.getElementById('subnav-robot-model-btn');
if (robotDevBtn && robotModelBtn) {
  robotDevBtn.addEventListener('click', () => {
    robotDevBtn.classList.add('active');
    robotModelBtn.classList.remove('active');
    if (!robotsTab) robotsTab = createRobotRegistryTab(document.getElementById('robots'));
    robotsTab.setSubTab?.('devices');
  });
  robotModelBtn.addEventListener('click', () => {
    robotModelBtn.classList.add('active');
    robotDevBtn.classList.remove('active');
    if (!robotsTab) robotsTab = createRobotRegistryTab(document.getElementById('robots'));
    robotsTab.setSubTab?.('models');
  });
}

// 실시간 GNB 텔레메트리 (MQTT 브로커 상태 & 온라인 로봇 대수)
const gnbMqttBadge = document.getElementById('gnb-mqtt-badge');
const gnbFleetCount = document.getElementById('gnb-fleet-count');

function updateMqttStatus(connected) {
  if (!gnbMqttBadge) return;
  gnbMqttBadge.className = `gnb-status-pill ${connected ? 'online' : 'offline'}`;
  const textEl = gnbMqttBadge.querySelector('.status-text');
  if (textEl) textEl.textContent = connected ? 'MQTT 온라인 (1883)' : 'MQTT 미연결';
}

const screenPill = document.getElementById('screen-pill');
function updateFleetOnlineCount(count, total = count) {
  if (gnbFleetCount) gnbFleetCount.textContent = `${count}대 온라인`;
  if (screenPill) {
    screenPill.textContent = total ? `로봇 ${total}대 · 온라인 ${count}` : '로봇 없음';
    screenPill.className = `s2m-pill ${count > 0 ? 's2m-pill--accent' : total ? 's2m-pill--warn' : 's2m-pill--dim'}`;
  }
}

getFleetConfig()
  .then((data) => {
    if (data?.status) updateMqttStatus(data.status.connected);
  })
  .catch(() => updateMqttStatus(false));

// 배지는 스트림의 로봇 레코드(connectionState)를 그대로 세어 갱신한다 -- 스냅샷 한 번이
// 아니라 robot/forget 이벤트마다.
// 주의: 이 파일의 `Map`은 OpenLayers 지도 클래스라(import) JS Map 대신 일반 객체를 쓴다.
const gnbRobots = {}; // key -> 플릿 레코드
function recountFleet() {
  const all = Object.values(gnbRobots);
  updateFleetOnlineCount(all.filter((r) => r.connectionState === 'ONLINE').length, all.length);
}
subscribeFleetStream((msg) => {
  if (msg.type === 'status' && msg.status) {
    updateMqttStatus(msg.status.connected);
  } else if (msg.type === 'snapshot') {
    if (msg.status) updateMqttStatus(msg.status.connected);
    for (const k of Object.keys(gnbRobots)) delete gnbRobots[k];
    for (const r of msg.robots || []) gnbRobots[r.key] = r;
    recountFleet();
  } else if (msg.type === 'robot') {
    gnbRobots[msg.robot.key] = msg.robot;
    recountFleet();
  } else if (msg.type === 'forget') {
    delete gnbRobots[msg.key];
    recountFleet();
  }
});

/**
 * 새로 로드된 PCD 포인트를 2D 지도(높이 슬라이스 포함)와 3D 뷰 양쪽에 동시에 반영한다.
 * 업로드로 파일이 바뀔 때마다 이 함수 하나로 두 뷰의 좌표/레이어가 함께 갱신된다.
 */
function applyPoints(points, label) {
  currentPoints = points;
  const pointsBtn = document.getElementById('btn-view3d-points');
  if (pointsBtn) { pointsBtn.disabled = false; pointsBtn.title = `${points.length.toLocaleString()}개 포인트`; }
  setView3dMode('points');

  // 2D: 원본 포인트 레이어 갱신
  pcdSource.clear();
  pcdSource.addFeatures(
    points.map(
      (p) =>
        new Feature({
          geometry: new Point([p.x, p.y]),
          r: p.r,
          g: p.g,
          b: p.b,
          z: p.z,
        })
    )
  );
  pcdLayer.setVisible(false);

  // 2D: 기존 높이 슬라이스 레이어 제거 후 새 데이터 기준으로 재생성
  sliceLayers.forEach((layer) => map.removeLayer(layer));
  const bands = buildHeightBands(points, SLICE_HEIGHT_M);
  sliceLayers = createSliceLayers(pcdSource, bands);
  sliceLayers.forEach((layer) => map.addLayer(layer));
  renderSlicePanel(document.getElementById('slice-panel'), bands, sliceLayers, [
    { layer: blueprintLayer, label: BLUEPRINT_LABEL },
    { layer: editLayerApi.layer, label: '노드/링크/블록' },
    { layer: importedObstacleLayer, label: '스캔 장애물' },
    { layer: liveRobotPoseLayer, label: '실시간 로봇 위치' },
    { layer: pcdLayer, label: `전체 (비분류) — ${label}`, checked: false },
  ]);

  // 2D: 새 데이터의 실제 좌표 범위에 맞춰 뷰 자동 이동/줌
  const extent = pcdSource.getExtent();
  map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 7 });

  // 3D: 뷰가 이미 열려 있으면 즉시 반영 (열려있지 않으면 다음에 열 때 currentPoints로 초기화됨)
  if (view3d) {
    view3d.setPoints(points);
  }

  setPcdStatus(`${label}: ${points.length}개 포인트`);
  console.log(`PCD 적용 완료 (${label}): ${points.length}개 포인트`);
}

// 상단 공용 PCD 업로드: 파일이 바뀌면 2D/3D 뷰가 함께 갱신된다.
// 기본값으로 자동 로드되는 PCD는 없음 — 업로드 전까지는 빈 지도 상태를 유지한다.
function setPcdStatus(text) {
  // 리본의 상태 문구는 없어졌다(가져오기 대화상자/토스트가 대신한다). 콘솔에만 남긴다.
  console.log('[PCD]', text);
}

/** 가져오기 대화상자의 'pcd' 분기: 파일 하나를 읽어 3D 포인트 + 높이 슬라이스 레이어로 */
async function loadPcdFile(file) {
  setPcdStatus(`${file.name} 로딩 중...`);
  const buffer = await file.arrayBuffer();
  const { points } = parsePcd(buffer);
  applyPoints(points, file.name);
  showFleetToast(`${file.name}: 포인트 ${points.length.toLocaleString()}개`);
  activateMapsSub('3d');
}

// 3D 뷰 패널: 포인트 / 메쉬 표시 전환
const btnViewPoints = document.getElementById('btn-view-points');
const btnViewMesh = document.getElementById('btn-view-mesh');
const meshStatusEl = document.getElementById('mesh-status');

function setMeshStatus(text) {
  meshStatusEl.textContent = text;
}

function setViewModeButtons(mode) {
  btnViewPoints.classList.toggle('active', mode === 'points');
  btnViewMesh.classList.toggle('active', mode === 'mesh');
}

btnViewPoints.addEventListener('click', () => {
  if (!view3d) return;
  view3d.setDisplayMode('points');
  setViewModeButtons('points');
});

btnViewMesh.addEventListener('click', () => {
  if (!view3d) return;
  setMeshStatus('메쉬 생성 중...');
  // 버튼 클릭 피드백이 먼저 그려지도록 다음 프레임에 무거운 변환을 실행
  requestAnimationFrame(() => {
    try {
      const { triangleCount, grid } = view3d.convertToMesh({ voxelSize: 0.08 });
      setViewModeButtons('mesh');
      setMeshStatus(`삼각형 ${triangleCount}개 (격자 ${grid.nx}x${grid.ny}x${grid.nz})`);
    } catch (err) {
      console.error(err);
      setMeshStatus(`변환 실패: ${err.message}`);
    }
  });
});

// 딥링크: ?tab=maps|robots|operate|simulation|settings (&sub=2d|3d|align) -- 화면 캡처·북마크용.
// 탭 상태가 URL 에 없던 것을 여기서만 읽는다(URL 을 바꾸지는 않음).
{
  const q = new URLSearchParams(location.search);
  const tab = q.get('tab');
  const sub = q.get('sub');
  if (sub && ['2d', '3d', 'align'].includes(sub)) mapsSub = sub;
  if (tab && ['maps', 'robots', 'operate', 'simulation', 'settings'].includes(tab)) activateTab(tab);
  else if (sub) activateMapsSub(sub);
  // &detail=<시리얼|이름>: 로봇 상세 드로어를 바로 연다 (캡처·공유용)
  const detail = q.get('detail');
  if (tab === 'robots' && detail) {
    listRobots().then((all) => { const r = all.find((x) => x.vda5050Serial === detail || x.name === detail); if (r) openRobotDrawer(r); }).catch(() => {});
  }
}

// 왼쪽 내비 하단: 버전 · 빌드, 서비스 상태 점 (API · 플래너 · scan-engine · MQTT).
// 상단 배지는 MQTT 만 보여 주는데, 나머지 셋이 죽으면 화면이 조용히 깨진다 -- 여기서 한눈에 보이게.
{
  const versionEl = document.getElementById('nav-version');
  const healthEl = document.getElementById('nav-health');
  const hash = typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev';
  if (versionEl) versionEl.textContent = `Fleet Studio v0.9 · ${hash}`;
  if (healthEl) {
    const services = [
      { key: 'api', label: 'API', url: '/api/projects' },
      { key: 'planner', label: '플래너', url: '/api/path/health' },
      { key: 'engine', label: 'scan-engine', url: '/scan-engine/api/groups' },
      { key: 'vps', label: 'VPS', url: '/api/vps/health' }, // vps.mjs가 업스트림이 죽어도 항상 200을 주므로, 아래 probe()가 이미 하는 "fetch가 안 던지면 up" 판정이 그대로 맞다
      { key: 'mqtt', label: 'MQTT' },
    ];
    const items = new Map();
    for (const svc of services) {
      const item = document.createElement('span');
      item.className = 'nav-health__item';
      item.dataset.state = 'unknown';
      item.innerHTML = `<i></i>${svc.label}`;
      healthEl.appendChild(item);
      items.set(svc.key, item);
    }
    async function probe(svc) {
      try {
        await fetch(svc.url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(3000) });
        return 'up';
      } catch {
        return 'down';
      }
    }
    async function refreshHealth() {
      for (const svc of services) {
        if (!svc.url) continue;
        const state = await probe(svc);
        const item = items.get(svc.key);
        item.dataset.state = state;
        item.title = `${svc.label}: ${state === 'up' ? '응답' : '응답 없음'} (${svc.url})`;
      }
      const mqttUp = document.getElementById('gnb-mqtt-badge')?.classList.contains('online');
      const mqttItem = items.get('mqtt');
      mqttItem.dataset.state = mqttUp ? 'up' : 'down';
      mqttItem.title = mqttUp ? 'MQTT 브로커 연결됨' : 'MQTT 브로커 연결 없음 (설정 › 브로커)';
    }
    refreshHealth();
    setInterval(refreshHealth, 10000);
  }
}
