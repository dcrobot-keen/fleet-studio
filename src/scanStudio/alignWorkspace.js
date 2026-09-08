// 지도 › 정합 (네이티브) -- scan-to-map-studio 의 다중 스캔 정합 워크스페이스를 iframe 대신
// Fleet Studio 안에서 OpenLayers 로 그린다 (architecture-improvements ⑱, 2단계).
//
// 데이터·계산은 전부 스튜디오 서버에 둔다: GET /api/groups/{g}/workspace 로 스캔별 슬라이스
// (코드 격자, b64)·정합·바닥 이미지·게이트를 받고, 지표는 POST .../metrics, ICP 는 POST .../icp,
// 저장은 PUT .../alignment (서버가 합성 슬라이스맵을 다시 만들어 시뮬레이터 worlds/ 로 publish).
// 정합 규약은 studio/merge_slicemaps.py 와 같다: 슬라이스 평면 (x, y) = (x_arkit, -z_arkit),
// 적용 = yaw 만큼 CCW 회전 후 (offsetX, -offsetZ) 이동.
//
// 각 스캔은 ol/source/ImageCanvas 레이어 하나다: 요청된 extent 를 캔버스에 그릴 때 위 변환을
// DOMMatrix 로 합성해 슬라이스 셀 이미지와 앱 바닥 이미지를 회전·이동시켜 그린다.
import OlMap from 'ol/Map.js';
import View from 'ol/View.js';
import ImageLayer from 'ol/layer/Image.js';
import ImageCanvasSource from 'ol/source/ImageCanvas.js';
import PointerInteraction from 'ol/interaction/Pointer.js';
import Projection from 'ol/proj/Projection.js';
import { defaults as defaultControls } from 'ol/control.js';
import ScaleLine from 'ol/control/ScaleLine.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Style from 'ol/style/Style.js';
import CircleStyle from 'ol/style/Circle.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Text from 'ol/style/Text.js';
import {
  listGroups, prepareGroup, deleteGroup, getGroupWorkspace, postGroupMetrics, postGroupIcp, putGroupAlignment,
  getGroupAlignmentHistory, getGroupAlignmentHistoryEntry,
  groupFileUrl, getGroupMergedSlicemap, getGroupMergedFloorMeta,
} from './scanStudioApi.js';
import { listProjects, createProjectFromSlicemap, updateProjectFromSlicemap } from '../projects/projectApi.js';
import { getVpsScanStatus, listVpsRooms, uploadVpsScan } from '../fleet/vpsApi.js';

/** @typedef {import('./scanEngine.gen').components['schemas']} Schemas */

// 기준 스캔은 항상 이 색 하나로 고정. 나머지 스캔은 선택 여부와 무관하게 스캔마다 고유한
// 색을 계속 유지한다(옛날엔 "선택됨"/"그 외" 두 그룹으로만 색을 나눠서, 스캔이 3개 이상이면
// "그 외"끼리 색이 겹쳐 지금 뭘 보고 있는지 구분이 안 됐다 -- 정합 작업 자체가 안 되는 수준).
const REF_COLOR = [79, 209, 197];
const OTHER_PALETTE = [
  [235, 111, 146], [124, 179, 235], [212, 163, 74], [142, 209, 125],
  [178, 140, 235], [235, 158, 90], [111, 201, 209], [201, 111, 201],
];
const alignProjection = new Projection({ code: 'scan-align-plane', units: 'm', extent: [-500, -500, 500, 500] });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const b64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const deg = (rad) => (rad * 180) / Math.PI;

// 슬라이스 평면 정합 (== merge_slicemaps.ScanAlignment.apply_xy)
function applyXY(a, x, y) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return [c * x - s * y + a.ox, s * x + c * y - a.oz];
}

/**
 * @param {HTMLElement} rootEl
 * @param {{ onToast?: (message: string) => void }} [opts]
 */
export function createAlignWorkspace(rootEl, { onToast = (_message) => {} } = {}) {
  rootEl.classList.add('align-ws');
  rootEl.innerHTML = `
    <aside class="align-ws__rail">
      <section class="align-ws__section">
        <div class="align-ws__title">스캔 그룹</div>
        <div class="align-ws__row">
          <select id="aw-group" class="pathfinding-select" title="scan-to-map-studio 그룹 (STUDIO_GROUPS_DIR)"></select>
          <button id="aw-load" class="robot-button robot-button-primary">열기</button>
          <button id="aw-delete-group" class="robot-button" title="선택된 그룹을 통째로 삭제합니다.">🗑 삭제</button>
        </div>
        <div id="aw-group-note" class="align-ws__note">스튜디오에서 그룹 목록을 읽는 중…</div>
      </section>
      <section class="align-ws__section">
        <div class="align-ws__title">스캔 <span id="aw-count" class="align-ws__count"></span></div>
        <div id="aw-layers" class="align-ws__layers"></div>
      </section>
      <section class="align-ws__section" id="aw-floor-row" hidden>
        <label class="align-ws__check"><input type="checkbox" id="aw-floor" checked> 앱 바닥 이미지</label>
        <input type="range" id="aw-floor-alpha" min="0" max="1" step="0.05" value="0.9" title="바닥 이미지 투명도">
      </section>
      <section class="align-ws__section align-ws__help">
        <b>드래그</b> 선택 스캔 이동 · <b>Alt+휠</b> / <b>[ ]</b> 회전(0.5°, Shift 5°)<br>
        <b>방향키</b> 1 cm 이동(Shift 10 cm) · <b>F</b> 전체 보기 · 기준 스캔은 고정
      </section>
    </aside>
    <div class="align-ws__map" id="aw-map" tabindex="0"></div>
    <aside class="align-ws__side">
      <section class="align-ws__section">
        <div class="align-ws__title">선택 스캔</div>
        <div id="aw-sel-name" class="align-ws__selname">–</div>
        <div class="align-ws__grid3">
          <label>offsetX (m)<input id="aw-in-x" type="number" step="0.01" class="robot-input"></label>
          <label>offsetZ (m)<input id="aw-in-z" type="number" step="0.01" class="robot-input"></label>
          <label>yaw (°)<input id="aw-in-yaw" type="number" step="0.5" class="robot-input"></label>
        </div>
        <div class="align-ws__row align-ws__rot">
          <button class="robot-button" data-rot="-5">↺ 5°</button><button class="robot-button" data-rot="-0.5">↺ 0.5°</button>
          <button class="robot-button" data-rot="0.5">↻ 0.5°</button><button class="robot-button" data-rot="5">↻ 5°</button>
        </div>
        <div class="align-ws__row">
          <button id="aw-icp" class="robot-button robot-button-primary" title="현재 자세에서 다른 스캔들의 벽에 ICP 로 미세 정합">ICP 미세 정합</button>
          <button id="aw-icp-undo" class="robot-button" hidden>ICP 취소</button>
          <button id="aw-revert" class="robot-button">되돌리기</button>
        </div>
        <div id="aw-icp-note" class="align-ws__note"></div>
        <div class="align-ws__row">
          <button id="aw-pin" class="robot-button" title="선택 스캔의 한 점을 찍고, 다른 스캔에서 같은 물리적 지점을 찍는다 (벽에 자동 스냅). 2쌍 이상이면 회전·이동을 한 번에 맞춘다">핀 찍기</button>
          <button id="aw-pin-fit" class="robot-button" disabled title="핀 쌍으로 2-D 강체 정합 (Kabsch)">핀으로 정합</button>
          <button id="aw-pin-clear" class="robot-button" hidden>핀 지우기</button>
        </div>
        <div id="aw-pins" class="align-ws__note"></div>
        <label class="align-ws__check"><input type="checkbox" id="aw-approve"> 이 스캔의 정합을 승인</label>
      </section>
      <section class="align-ws__section">
        <div class="align-ws__title">정합 지표 <span id="aw-metrics-state" class="align-ws__count"></span></div>
        <div id="aw-metrics" class="s2m-stats"></div>
        <div class="align-ws__note">겹침 &lt; 1.5 m 이면 판단 보류 · inlier ≥ 0.60 · conflict ≤ 0.12 가 목표 (스튜디오 게이트와 동일)</div>
      </section>
      <section class="align-ws__section">
        <div class="align-ws__title">저장 · 합성</div>
        <button id="aw-save" class="robot-button robot-button-primary" disabled>서버에 저장 → 합성 슬라이스맵 반영</button>
        <label class="align-ws__check" title="같은 이름의 현장 프로젝트가 있으면 저장 직후 새 합성 지도로 갱신한다 (id·노드링크 유지)"><input type="checkbox" id="aw-auto-project" checked> 저장 시 현장 프로젝트 자동 갱신</label>
        <div id="aw-save-result" class="align-ws__note"></div>
        <div class="align-ws__row">
          <select id="aw-history" class="pathfinding-select" title="이 그룹의 저장 기록 -- 저장할 때마다 그 직전 상태가 남는다"></select>
          <button id="aw-history-load" class="robot-button" disabled title="고른 시점의 정합 값을 화면에 불러온다(그 자체로는 저장 안 됨 -- 확인 후 아래 저장 버튼을 눌러야 반영된다)">이 시점 불러오기</button>
        </div>
        <div id="aw-history-note" class="align-ws__note"></div>
        <img id="aw-merged" class="align-ws__merged" alt="" hidden>
        <button id="aw-project" class="robot-button" hidden>이 합성 지도로 현장 프로젝트 만들기 / 갱신</button>
        <div id="aw-project-note" class="align-ws__note"></div>
      </section>
    </aside>`;
  /** 워크스페이스 안의 요소 (id). DOM 프로퍼티를 자유롭게 쓰도록 any 로 둔다.
   * @type {(id: string) => any} */
  const $ = (id) => rootEl.querySelector(`#${id}`);

  // ---- state -------------------------------------------------------------
  let ws = null;           // 서버 payload
  let groupName = null;    // 그룹 폴더 이름(API 키). ws.group 은 앱이 적은 표시용 제목일 수 있다
  let layers = [];         // 아래 buildLayers()
  let selected = null;
  let showFloor = true;
  let floorAlpha = 0.9;
  let icpUndo = null;
  let pinMode = false;
  /** @type {{ src: number[], ref: number[] | null, srcSnapped?: boolean, refSnapped?: boolean }[]} src = 선택 스캔 로컬 좌표, ref = 평면(기준) 좌표 */
  let pins = [];
  let metricsTimer = null;
  let metricsSeq = 0;

  // ---- map ---------------------------------------------------------------
  const mapEl = $('aw-map');
  const map = new OlMap({
    target: mapEl,
    layers: [],
    view: new View({ projection: alignProjection, center: [0, 0], zoom: 4, minZoom: 0, maxZoom: 12 }),
    controls: defaultControls({ rotate: false }).extend([new ScaleLine({ units: 'metric' })]),
  });

  // 핀(대응점) 레이어: 선택 스캔의 점(주황, 현재 정합으로 변환) · 상대 스캔의 점(민트) · 잇는 선
  const pinSource = new VectorSource();
  const pinStyle = (feature) => {
    const kind = feature.get('kind');
    if (kind === 'link') return new Style({ stroke: new Stroke({ color: 'rgba(231,236,243,.8)', width: 1.5, lineDash: [4, 4] }) });
    const color = kind === 'src' ? '#f5a623' : '#4fd1c5';
    return new Style({
      image: new CircleStyle({ radius: 6, fill: new Fill({ color }), stroke: new Stroke({ color: '#0b0e13', width: 2 }) }),
      text: new Text({ text: String(feature.get('n')), offsetX: 10, offsetY: -10, font: '600 11px ui-monospace, monospace', fill: new Fill({ color: '#e7ecf3' }), stroke: new Stroke({ color: '#0b0e13', width: 3 }) }),
    });
  };
  map.addLayer(new VectorLayer({ source: pinSource, style: pinStyle, zIndex: 50 }));
  function refreshPins() {
    pinSource.clear();
    pins.forEach((pin, i) => {
      const a = selected ? applyXY(selected.align, pin.src[0], pin.src[1]) : null;
      if (a) { const f = new Feature(new Point(a)); f.set('kind', 'src'); f.set('n', i + 1); pinSource.addFeature(f); }
      if (pin.ref) { const f = new Feature(new Point(pin.ref)); f.set('kind', 'ref'); f.set('n', i + 1); pinSource.addFeature(f); }
      if (a && pin.ref) { const f = new Feature(new LineString([a, pin.ref])); f.set('kind', 'link'); pinSource.addFeature(f); }
    });
    const box = $('aw-pins');
    box.replaceChildren();
    for (const [i, pin] of pins.entries()) {
      let res = '';
      if (pin.ref && selected) { const [x, y] = applyXY(selected.align, pin.src[0], pin.src[1]); res = ` · 잔차 ${Math.hypot(x - pin.ref[0], y - pin.ref[1]).toFixed(3)} m`; }
      const snapNote = pin.ref ? ` (${pin.srcSnapped ? '벽' : '자유점'} → ${pin.refSnapped ? '벽' : '자유점'})` : pin.srcSnapped ? ' (벽에 스냅)' : ' (자유점)';
      box.appendChild(el('div', null, `핀 ${i + 1}${snapNote}${pin.ref ? res : ' — 다른 스캔에서 같은 지점을 클릭'}`));
    }
    const complete = pins.filter((p) => p.ref).length;
    $('aw-pin-fit').disabled = complete < 2 || !selected || selected.isRef;
    $('aw-pin-clear').hidden = pins.length === 0;
    if (pinMode) box.appendChild(el('div', 'align-ws__note--warn', complete === pins.length ? '핀 모드: 선택 스캔 위의 점을 클릭하세요 (Esc 종료)' : '핀 모드: 다른 스캔에서 같은 지점을 클릭하세요'));
  }
  function setPinMode(on) {
    pinMode = on;
    $('aw-pin').classList.toggle('active', on);
    mapEl.classList.toggle('align-ws__map--pin', on);
    refreshPins();
  }

  function layerImage(L) {
    if (L.img) return L.img;
    const cv = document.createElement('canvas');
    cv.width = L.cols; cv.height = L.rows;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(L.cols, L.rows);
    const [R, G, B] = L.color;
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const v = L.codes[r * L.cols + c];
        const o = ((L.rows - 1 - r) * L.cols + c) * 4; // row 0 = min y 가 아래
        let alpha = 0;
        if (v === 1) alpha = 34; else if (v === 2) alpha = 165; else if (v === 3) alpha = 240;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);
    L.img = cv;
    return cv;
  }

  function roleOf(L) { return L.isRef ? 'ref' : L === selected ? 'sel' : 'other'; }

  function makeSource(L) {
    return new ImageCanvasSource({
      projection: alignProjection,
      ratio: 1.3,
      canvasFunction: (extent, resolution, pixelRatio, size) => {
        const cv = document.createElement('canvas');
        cv.width = Math.round(size[0]); cv.height = Math.round(size[1]);
        if (!L.visible) return cv;
        const ctx = cv.getContext('2d');
        const scale = cv.width / (extent[2] - extent[0]);
        const V = new DOMMatrix([scale, 0, 0, -scale, -scale * extent[0], cv.height + scale * extent[1]]);
        const a = L.align, c = Math.cos(a.yaw), s = Math.sin(a.yaw);
        const A = new DOMMatrix([c, s, -s, c, a.ox, -a.oz]);
        const role = roleOf(L);
        const emphasis = role !== 'other';
        if (showFloor && L.floorImg && L.floorImg.complete && L.floorImg.naturalWidth > 0) {
          // floorplan 픽셀 (col,row) -> 평면 (originX + col*res, -(originTopZ + row*res)); 위 행 = 최대 y
          const f = L.floor;
          const Fm = new DOMMatrix([f.resolution, 0, 0, -f.resolution, f.originX, -f.originTopZ]);
          const MF = V.multiply(A).multiply(Fm);
          ctx.setTransform(MF);
          ctx.imageSmoothingEnabled = true;
          ctx.globalAlpha = floorAlpha * (emphasis ? 1 : 0.65);
          ctx.drawImage(L.floorImg, 0, 0, f.width, f.height);
        }
        const Lm = new DOMMatrix([L.res, 0, 0, -L.res, L.origin[0], L.origin[1] + L.rows * L.res]);
        const M = V.multiply(A).multiply(Lm);
        ctx.setTransform(M);
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = emphasis ? 1 : 0.7;
        ctx.drawImage(layerImage(L), 0, 0, L.cols, L.rows);
        return cv;
      },
    });
  }

  function refreshLayer(L) { L.source.changed(); }
  function refreshAll() { for (const L of layers) refreshLayer(L); }
  // 기준 스캔은 항상 맨 아래, 지금 고른 스캔은 항상 맨 위(편집 대상이 안 가려지게). 그 사이
  // "그 외" 스캔들의 순서는 layers 배열 순서를 그대로 쌓기 순서로 쓴다 -- moveLayer()가
  // 배열 순서를 바꿔주므로, 사용자가 원하는 스캔을 원하는 스캔 위/아래로 직접 옮길 수 있다.
  function restack() {
    let z = 5;
    for (const L of layers) {
      if (L.isRef) L.olLayer.setZIndex(1);
      else if (L === selected) L.olLayer.setZIndex(100);
      else L.olLayer.setZIndex(z++);
    }
  }

  /** 기준이 아닌 스캔을 layers 배열(=쌓기 순서)에서 한 칸 앞(-1)/뒤(+1)로 옮긴다. */
  function moveLayer(L, dir) {
    const others = layers.filter((x) => !x.isRef);
    const oi = others.indexOf(L);
    const ni = oi + dir;
    if (oi === -1 || ni < 0 || ni >= others.length) return;
    [others[oi], others[ni]] = [others[ni], others[oi]];
    layers = [...layers.filter((x) => x.isRef), ...others];
    restack();
    renderLayerList();
  }

  function fitAll() {
    if (!layers.length) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const L of layers) {
      const x0 = L.origin[0], y0 = L.origin[1], x1 = x0 + L.cols * L.res, y1 = y0 + L.rows * L.res;
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        const [px, py] = applyXY(L.align, x, y);
        minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
      }
    }
    map.updateSize();
    map.getView().fit([minx, miny, maxx, maxy], { padding: [30, 30, 30, 30] });
  }

  // ---- interactions -----------------------------------------------------
  // 평면 좌표가 스캔 L 의 관측된 셀(unknown 아님) 위인가 -- 드래그 시작 판정
  function insideScan(L, x, y) {
    const c = Math.cos(L.align.yaw), s = Math.sin(L.align.yaw);
    const dx = x - L.align.ox, dy = y + L.align.oz;
    const lx = c * dx + s * dy, ly = -s * dx + c * dy; // inverse of applyXY
    const col = Math.floor((lx - L.origin[0]) / L.res), row = Math.floor((ly - L.origin[1]) / L.res);
    if (col < 0 || row < 0 || col >= L.cols || row >= L.rows) return false;
    return L.codes[row * L.cols + col] !== 0;
  }
  function inverseXY(a, x, y) {
    const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
    const dx = x - a.ox, dy = y + a.oz;
    return [c * dx + s * dy, -s * dx + c * dy];
  }
  function nearestWall(L, x, y, maxD) {
    let best = null, bd = maxD;
    for (let i = 0; i < L.walls.length; i += 2) {
      const [px, py] = applyXY(L.align, L.walls[i], L.walls[i + 1]);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = [px, py]; }
    }
    return best;
  }
  function centroidRef(L) {
    let sx = 0, sy = 0;
    const n = L.walls.length / 2;
    for (let i = 0; i < L.walls.length; i += 2) { sx += L.walls[i]; sy += L.walls[i + 1]; }
    return applyXY(L.align, sx / n, sy / n);
  }
  function markDirty(method) {
    if (!selected) return;
    selected.dirty = true; selected.method = method; selected.approved = false;
    $('aw-save').disabled = false;
  }
  function afterMove() {
    refreshLayer(selected);
    updatePanel();
    renderLayerList();
    refreshPins();
    scheduleMetrics();
  }
  function rotateSelected(dyaw) { // 벽 무게중심을 축으로 회전 (스캔이 멀리 날아가지 않게)
    if (!selected || selected.isRef) return;
    const L = selected;
    const [cx, cy] = centroidRef(L);
    L.align.yaw += dyaw;
    const [nx, ny] = centroidRef(L);
    L.align.ox += cx - nx; L.align.oz -= cy - ny;
    markDirty('manual'); afterMove();
  }
  function nudge(dx, dy) {
    if (!selected || selected.isRef) return;
    selected.align.ox += dx; selected.align.oz -= dy;
    markDirty('manual'); afterMove();
  }

  class DragScan extends PointerInteraction {
    handleDownEvent(evt) {
      if (pinMode || !selected || selected.isRef || !selected.visible) return false;
      const [x, y] = evt.coordinate;
      const tol = Math.max(0.35, map.getView().getResolution() * 10);
      if (!insideScan(selected, x, y) && !nearestWall(selected, x, y, tol)) return false;
      this.start = { x, y, ox: selected.align.ox, oz: selected.align.oz };
      return true;
    }
    handleDragEvent(evt) {
      const [x, y] = evt.coordinate;
      selected.align.ox = this.start.ox + (x - this.start.x);
      selected.align.oz = this.start.oz - (y - this.start.y); // 평면 dy = -d(offsetZ)
      markDirty('manual');
      refreshLayer(selected); updatePanel();
    }
    handleUpEvent() { renderLayerList(); scheduleMetrics(); return false; }
  }
  map.addInteraction(new DragScan());
  map.on('singleclick', (evt) => {
    if (!pinMode || !selected || selected.isRef) return;
    const [x, y] = evt.coordinate;
    const snapTol = Math.max(0.25, map.getView().getResolution() * 8);
    const cur = pins[pins.length - 1];
    if (!cur || cur.ref) {
      // 새 쌍: 첫 클릭 = 선택 스캔 위의 점 (벽에 스냅)
      const snap = nearestWall(selected, x, y, snapTol);
      const pt = snap ?? [x, y];
      pins.push({ src: inverseXY(selected.align, pt[0], pt[1]), ref: null, srcSnapped: Boolean(snap), refSnapped: false });
    } else {
      // 둘째 클릭 = 다른 스캔의 같은 물리적 지점 (그 스캔 벽에 스냅)
      let snap = null;
      for (const o of layers) { if (o === selected || !o.visible) continue; const sn = nearestWall(o, x, y, snapTol); if (sn) { snap = sn; break; } }
      cur.ref = snap ?? [x, y];
      cur.refSnapped = Boolean(snap);
    }
    refreshPins();
  });
  $('aw-pin').addEventListener('click', () => { if (selected && !selected.isRef) setPinMode(!pinMode); });
  $('aw-pin-clear').addEventListener('click', () => { pins = []; refreshPins(); });
  $('aw-pin-fit').addEventListener('click', () => {
    // == scan_alignment_metrics.pin_fit: 2-D Kabsch 닫힌 해 (src 로컬 -> ref 평면)
    const pairs = pins.filter((pin) => pin.ref);
    if (pairs.length < 2 || !selected || selected.isRef) return;
    let sx = 0, sy = 0, tx = 0, ty = 0;
    for (const pin of pairs) { sx += pin.src[0]; sy += pin.src[1]; tx += pin.ref[0]; ty += pin.ref[1]; }
    sx /= pairs.length; sy /= pairs.length; tx /= pairs.length; ty /= pairs.length;
    let num = 0, den = 0;
    for (const pin of pairs) {
      const ax = pin.src[0] - sx, ay = pin.src[1] - sy, bx = pin.ref[0] - tx, by = pin.ref[1] - ty;
      num += ax * by - ay * bx; den += ax * bx + ay * by;
    }
    const yaw = Math.atan2(num, den), c = Math.cos(yaw), sn = Math.sin(yaw);
    const ox = tx - (c * sx - sn * sy), oy = ty - (sn * sx + c * sy);
    selected.align = { ox, oz: -oy, yaw };
    markDirty('pins');
    setPinMode(false);
    afterMove();
  });
  mapEl.addEventListener('wheel', (e) => {
    if (!e.altKey || !selected) return;
    e.preventDefault(); e.stopPropagation();
    rotateSelected(-Math.sign(e.deltaY) * (e.shiftKey ? 5 : 0.5) * Math.PI / 180);
  }, { capture: true, passive: false });
  document.addEventListener('keydown', (e) => {
    if (rootEl.offsetParent === null) return; // 이 화면이 보일 때만
    const tag = /** @type {HTMLElement|null} */ (e.target)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'f' || e.key === 'F') { fitAll(); return; }
    if (e.key === 'Escape' && pinMode) { setPinMode(false); return; }
    if (!selected) return;
    const step = e.shiftKey ? 0.1 : 0.01, rot = (e.shiftKey ? 5 : 0.5) * Math.PI / 180;
    if (e.key === 'ArrowLeft') nudge(-step, 0); else if (e.key === 'ArrowRight') nudge(step, 0);
    else if (e.key === 'ArrowUp') nudge(0, step); else if (e.key === 'ArrowDown') nudge(0, -step);
    else if (e.key === '[') rotateSelected(rot); else if (e.key === ']') rotateSelected(-rot); else return;
    e.preventDefault();
  });
  for (const btn of /** @type {NodeListOf<HTMLButtonElement>} */ (rootEl.querySelectorAll('[data-rot]'))) {
    btn.addEventListener('click', () => rotateSelected(-Number(btn.dataset.rot) * Math.PI / 180));
  }
  for (const [id, k] of [['aw-in-x', 'ox'], ['aw-in-z', 'oz'], ['aw-in-yaw', 'yaw']]) {
    $(id).addEventListener('change', (e) => {
      if (!selected || selected.isRef) return;
      let v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      if (k === 'yaw') v = (v * Math.PI) / 180;
      selected.align[k] = v;
      markDirty('manual'); afterMove();
    });
  }
  $('aw-floor').addEventListener('change', (e) => { showFloor = e.target.checked; refreshAll(); });
  $('aw-floor-alpha').addEventListener('input', (e) => { floorAlpha = Number(e.target.value); refreshAll(); });
  $('aw-approve').addEventListener('change', (e) => {
    if (!selected) return;
    selected.approved = e.target.checked;
    renderLayerList();
    $('aw-save').disabled = false;
  });
  $('aw-revert').addEventListener('click', () => {
    if (!selected) return;
    selected.align = { ...selected.loaded }; selected.method = selected.loadedMethod;
    selected.dirty = false; selected.approved = false; icpUndo = null;
    $('aw-icp-undo').hidden = true; $('aw-icp-note').textContent = '';
    pins = [];
    afterMove();
  });

  // ---- metrics (server) ---------------------------------------------------
  /** 다른 스캔들의 현재 자세 (metrics/icp 요청의 `others`)
   * @returns {Record<string, Schemas['Alignment']>} */
  function othersOf(L) {
    /** @type {Record<string, Schemas['Alignment']>} */
    const others = {};
    for (const o of layers) if (o !== L) others[o.id] = { offsetX: o.align.ox, offsetZ: o.align.oz, yawRadians: o.align.yaw };
    return others;
  }
  function scheduleMetrics() {
    clearTimeout(metricsTimer);
    if (!selected || selected.isRef || !ws) { renderMetrics(); return; }
    $('aw-metrics-state').textContent = '계산 중…';
    metricsTimer = setTimeout(async () => {
      const L = selected, seq = ++metricsSeq;
      try {
        const m = await postGroupMetrics(groupName, {
          scan: L.id, alignment: { offsetX: L.align.ox, offsetZ: L.align.oz, yawRadians: L.align.yaw }, others: othersOf(L),
        });
        if (seq !== metricsSeq) return;
        L.metrics = m;
        $('aw-metrics-state').textContent = '';
        renderMetrics();
      } catch (err) {
        if (seq !== metricsSeq) return;
        $('aw-metrics-state').textContent = `지표 실패: ${err.message}`;
      }
    }, 250);
  }
  function stat(label, value, tone) {
    const box = el('div', 's2m-stat');
    box.appendChild(el('div', 's2m-stat__label', label));
    box.appendChild(el('div', `s2m-stat__val${tone ? ` s2m-stat__val--${tone}` : ''}`, value));
    return box;
  }
  function renderMetrics() {
    const box = $('aw-metrics');
    box.replaceChildren();
    if (!selected) return;
    if (selected.isRef) { box.appendChild(el('div', 'align-ws__note', '기준 스캔은 고정 -- 지표 없음')); return; }
    const m = selected.metrics;
    if (!m) { box.appendChild(el('div', 'align-ws__note', '아직 계산되지 않음')); return; }
    const G = ws.gates;
    const locked = m.overlap_m < G.overlapLockM;
    box.append(
      stat('겹침 (m)', m.overlap_m.toFixed(2), locked ? 'warn' : 'accent'),
      stat('inlier', m.inlier.toFixed(3), locked ? null : m.inlier >= G.inlierMin ? 'success' : 'danger'),
      stat('conflict', m.conflict.toFixed(3), locked ? null : m.conflict <= G.conflictMax ? 'success' : 'danger'),
      stat('RMSE (m)', m.rmse_m == null ? '-' : m.rmse_m.toFixed(3)),
    );
    if (locked) box.appendChild(el('div', 'align-ws__note align-ws__note--warn', '겹치는 벽이 1.5 m 미만 -- inlier/conflict 로 판단하지 마세요.'));
  }

  // ---- panel / list -----------------------------------------------------
  function updatePanel() {
    const L = selected;
    $('aw-sel-name').textContent = L ? `${L.id}${L.isRef ? ' · 기준 (고정)' : ''}` : '–';
    for (const id of ['aw-in-x', 'aw-in-z', 'aw-in-yaw']) $(id).disabled = !L || L.isRef;
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (rootEl.querySelectorAll('[data-rot]'))) b.disabled = !L || L.isRef;
    $('aw-icp').disabled = !L || L.isRef;
    $('aw-revert').disabled = !L || L.isRef;
    $('aw-approve').disabled = !L || L.isRef;
    if (!L) return;
    if (document.activeElement !== $('aw-in-x')) $('aw-in-x').value = L.align.ox.toFixed(3);
    if (document.activeElement !== $('aw-in-z')) $('aw-in-z').value = L.align.oz.toFixed(3);
    if (document.activeElement !== $('aw-in-yaw')) $('aw-in-yaw').value = deg(L.align.yaw).toFixed(2);
    $('aw-approve').checked = L.approved;
  }
  function renderLayerList() {
    const list = $('aw-layers');
    list.replaceChildren();
    $('aw-count').textContent = layers.length ? String(layers.length) : '';
    const others = layers.filter((x) => !x.isRef);
    for (const L of layers) {
      const row = el('div', `align-ws__layer${L === selected ? ' selected' : ''}${L.isRef ? ' ref' : ''}`);
      const sw = el('span', 'align-ws__sw');
      sw.style.background = `rgb(${L.color.join(',')})`;
      const main = el('div', 'align-ws__layer-main');
      main.appendChild(el('div', 'align-ws__layer-name', L.id));
      const meta = L.isRef ? '기준 (고정)' : `${L.method}${L.approved ? ' · 승인' : ''}${L.dirty ? ' · 수정됨' : ''}`;
      main.appendChild(el('div', 'align-ws__layer-meta', meta));
      if (L.vpsStatus) main.appendChild(el('div', 'align-ws__layer-meta', L.vpsStatus));

      const controls = el('div', 'align-ws__layer-controls');
      if (!L.isRef) {
        const oi = others.indexOf(L);
        const upBtn = el('button', 'align-ws__layer-order', '▲');
        upBtn.type = 'button'; upBtn.title = '한 칸 위로(다른 스캔 앞에 그려짐)'; upBtn.disabled = oi <= 0;
        upBtn.addEventListener('click', (e) => { e.stopPropagation(); moveLayer(L, -1); });
        const downBtn = el('button', 'align-ws__layer-order', '▼');
        downBtn.type = 'button'; downBtn.title = '한 칸 아래로(다른 스캔 뒤로 숨음)'; downBtn.disabled = oi >= others.length - 1;
        downBtn.addEventListener('click', (e) => { e.stopPropagation(); moveLayer(L, 1); });
        controls.append(upBtn, downBtn);
      }
      const vpsBtn = el('button', 'align-ws__layer-vps', '📡');
      vpsBtn.type = 'button';
      vpsBtn.title = '이 스캔의 원본 zip을 VPS 서버에 등록합니다 (room_id = 스캔 id)';
      vpsBtn.disabled = Boolean(L.vpsBusy);
      vpsBtn.addEventListener('click', (e) => { e.stopPropagation(); openVpsUploadDialog(L); });
      controls.append(vpsBtn);
      const vis = document.createElement('input');
      vis.type = 'checkbox'; vis.checked = L.visible; vis.title = '표시';
      vis.addEventListener('click', (e) => e.stopPropagation());
      vis.addEventListener('change', () => { L.visible = vis.checked; refreshLayer(L); scheduleMetrics(); });
      controls.append(vis);

      row.append(sw, main, controls);
      row.addEventListener('click', () => select(L));
      list.appendChild(row);
    }
  }

  // ---- VPS 등록 ("이 스캔을 위치 보정용으로 쓸 수 있게") ---------------------------------
  // room_id는 업로드 시 준 이름 그대로라, scan-engine 쪽 정합의 스캔 id(L.id)와 반드시 같아야
  // frames.py의 GroupFrames가 이 스캔을 그룹 정합 좌표로 바르게 옮긴다 -- 그래서 이 액션은
  // (스캔 id가 이미 확정된) 여기 정합 워크스페이스에 두고, 위저드에는 안 둔다.
  function openVpsUploadDialog(L) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) startVpsUpload(L, file);
    });
    input.click();
  }

  async function startVpsUpload(L, file) {
    try {
      const status = await getVpsScanStatus(L.id).catch(() => null);
      if (status && ['unzipping', 'building', 'registering'].includes(status.status)) {
        alert(`'${L.id}'는 이미 VPS 등록이 진행 중입니다 (${status.status}). 잠시 후 다시 시도하세요.`);
        return;
      }
      let replace = false;
      try {
        replace = (await listVpsRooms()).rooms.some((r) => r.room_id === L.id);
      } catch { /* 목록 조회 실패는 무시하고 새 등록으로 진행 */ }
      if (!confirm(`'${L.id}' 스캔을 VPS 서버에 ${replace ? '다시 ' : ''}등록할까요?${replace ? '\n(기존 room을 덮어씁니다)' : ''}`)) return;

      L.vpsBusy = true;
      L.vpsStatus = 'VPS: 업로드 중…';
      renderLayerList();
      await uploadVpsScan(L.id, file, { replace });
      L.vpsStatus = 'VPS: 빌드 중…';
      renderLayerList();
      pollVpsStatus(L);
    } catch (err) {
      L.vpsBusy = false;
      L.vpsStatus = `VPS: 등록 실패 — ${err.message}`;
      renderLayerList();
    }
  }

  function pollVpsStatus(L) {
    const timer = setInterval(async () => {
      try {
        const s = await getVpsScanStatus(L.id);
        if (s.status === 'done' || s.status === 'failed') {
          clearInterval(timer);
          L.vpsBusy = false;
          L.vpsStatus = s.status === 'done' ? `VPS: 완료 (room ${s.room_id})` : `VPS: 실패 — ${s.error ?? '알 수 없는 오류'}`;
        } else {
          L.vpsStatus = `VPS: ${s.status}…`;
        }
        renderLayerList();
      } catch { /* 폴링 한 번 실패는 무시, 다음 tick 재시도 */ }
    }, 2000);
  }

  function select(L) {
    selected = L;
    if (pinMode) setPinMode(false);
    pins = [];
    refreshPins();
    restack();
    refreshAll();
    renderLayerList();
    updatePanel();
    $('aw-icp-note').textContent = '';
    $('aw-icp-undo').hidden = true; icpUndo = null;
    if (L && !L.isRef && !L.metrics) scheduleMetrics(); else renderMetrics();
  }

  // ---- ICP --------------------------------------------------------------
  $('aw-icp').addEventListener('click', async () => {
    if (!selected || selected.isRef || !ws) return;
    const L = selected;
    $('aw-icp').disabled = true; $('aw-icp-note').textContent = 'ICP 계산 중…';
    try {
      const res = await postGroupIcp(groupName, {
        scan: L.id, alignment: { offsetX: L.align.ox, offsetZ: L.align.oz, yawRadians: L.align.yaw }, others: othersOf(L),
      });
      icpUndo = { layer: L, align: { ...L.align }, method: L.method };
      L.align = { ox: res.alignment.offsetX, oz: res.alignment.offsetZ, yaw: res.alignment.yawRadians };
      L.metrics = res.after;
      markDirty('icp');
      refreshLayer(L); updatePanel(); renderLayerList(); renderMetrics();
      const a = res.after, b = res.before;
      const worse = a.conflict > b.conflict + 0.05 || a.inlier < b.inlier - 0.1;
      $('aw-icp-note').textContent = `ICP: ${(res.moved_m * 100).toFixed(0)} cm, ${res.rotated_deg.toFixed(1)}° 이동 · inlier ${b.inlier.toFixed(2)}→${a.inlier.toFixed(2)}, conflict ${b.conflict.toFixed(2)}→${a.conflict.toFixed(2)}${worse ? ' — 나빠졌습니다. 취소를 권합니다.' : ''}`;
      $('aw-icp-note').classList.toggle('align-ws__note--warn', worse);
      $('aw-icp-undo').hidden = false;
    } catch (err) {
      $('aw-icp-note').textContent = `ICP 실패: ${err.message}`;
    } finally {
      $('aw-icp').disabled = !selected || selected.isRef;
    }
  });
  $('aw-icp-undo').addEventListener('click', () => {
    if (!icpUndo) return;
    const u = icpUndo; icpUndo = null;
    u.layer.align = { ...u.align }; u.layer.method = u.method; u.layer.metrics = null;
    $('aw-icp-undo').hidden = true; $('aw-icp-note').textContent = '';
    afterMove();
  });

  // ---- save -> merged -> pathfinder project -------------------------------
  function buildAlignmentDoc() {
    const out = { format: 'scan-group-alignment-v1', group: ws.group ?? groupName, reference: ws.reference, up_axis_convention: 'top = -z', alignments: {} };
    const now = new Date().toISOString();
    for (const L of layers) {
      if (L.isRef) continue;
      const m = L.metrics;
      out.alignments[L.id] = {
        offsetX: +L.align.ox.toFixed(4), offsetZ: +L.align.oz.toFixed(4), yawRadians: +L.align.yaw.toFixed(6),
        method: L.method,
        ...(m ? { metrics: { overlap_m: m.overlap_m, inlier: m.inlier, conflict: m.conflict, rmse_m: m.rmse_m } } : {}),
        approved: L.approved, ...(L.approved ? { approved_at: now } : {}),
      };
    }
    return out;
  }
  $('aw-save').addEventListener('click', async () => {
    if (!ws) return;
    const btn = $('aw-save');
    btn.disabled = true;
    $('aw-save-result').textContent = '저장 중… (서버가 합성 슬라이스맵을 다시 만듭니다)';
    try {
      const res = await putGroupAlignment(groupName, buildAlignmentDoc());
      for (const L of layers) { L.loaded = { ...L.align }; L.loadedMethod = L.method; L.dirty = false; }
      renderLayerList();
      const pending = layers.filter((L) => !L.isRef && !L.approved).length;
      $('aw-save-result').textContent = `저장됨 · 합성 ${res.merged_summary}${pending ? ` · 승인 안 된 스캔 ${pending}개` : ' · 모든 스캔 승인'}${res.published ? ` · 시뮬레이터로 내보냄 (${res.published.split(/[\\/]/).pop()})` : ' · publish 경로(STUDIO_PUBLISH_DIR) 미설정'}`;
      const img = $('aw-merged');
      img.src = `${groupFileUrl(groupName, 'merged.png')}?t=${Date.now()}`;
      img.hidden = false;
      $('aw-project').hidden = false;
      onToast(`'${groupName}' 정합 저장 · 합성 슬라이스맵 갱신${res.published ? ' · 시뮬레이터 월드 반영' : ''}`);
      refreshHistory(); // 방금 저장 직전 상태가 기록에 새로 추가됨
      if ($('aw-auto-project').checked) await applyMergedToProject({ onlyIfExists: true });
    } catch (err) {
      $('aw-save-result').textContent = `저장 실패: ${err.message}`;
      btn.disabled = false;
    }
  });
  /** 합성 슬라이스맵(+바닥 이미지)으로 같은 이름의 현장 프로젝트를 만들거나 갱신
   * @param {{ onlyIfExists?: boolean }} [opts] */
  async function applyMergedToProject({ onlyIfExists = false } = {}) {
    if (!ws) return;
    const btn = $('aw-project');
    btn.disabled = true;
    $('aw-project-note').textContent = '합성 슬라이스맵과 바닥 이미지를 읽는 중…';
    try {
      const existing = (await listProjects()).find((p) => p.name === groupName);
      if (!existing && onlyIfExists) {
        $('aw-project-note').textContent = `'${groupName}' 이름의 현장 프로젝트가 없습니다. 아래 버튼으로 만들 수 있습니다.`;
        return;
      }
      const slicemap = await getGroupMergedSlicemap(groupName);
      let floor;
      try {
        const meta = await getGroupMergedFloorMeta(groupName);
        const blob = await (await fetch(`${groupFileUrl(groupName, 'merged.floor.png')}?t=${Date.now()}`)).blob();
        const png = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
        floor = { png, meta };
      } catch { /* 바닥 이미지 없는 그룹 */ }
      const project = existing
        ? await updateProjectFromSlicemap(existing.id, { name: groupName, slicemap, floor })
        : await createProjectFromSlicemap({ name: groupName, slicemap, floor });
      const url = new URL(location.href);
      url.searchParams.set('project', project.id);
      $('aw-project-note').innerHTML = `${existing ? '현장 프로젝트를 갱신했습니다' : '현장 프로젝트를 만들었습니다'}: <b>${project.name}</b> (장애물 ${project.featureCount ?? '-'}개) · <a href="${url.toString()}">열기 ↗</a>`;
      onToast(`${project.name}: ${existing ? '현장 프로젝트 갱신' : '현장 프로젝트 생성'} 완료`);
    } catch (err) {
      $('aw-project-note').textContent = `프로젝트 반영 실패: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }
  $('aw-project').addEventListener('click', () => applyMergedToProject());
  try { $('aw-auto-project').checked = localStorage.getItem('alignAutoProject') !== '0'; } catch {}
  $('aw-auto-project').addEventListener('change', (e) => { try { localStorage.setItem('alignAutoProject', e.target.checked ? '1' : '0'); } catch {} });

  // ---- loading ------------------------------------------------------------
  function buildLayers(payload) {
    for (const L of layers) map.removeLayer(L.olLayer);
    let otherIdx = 0;
    layers = payload.layers.map((raw) => {
      const codes = b64(raw.data);
      const walls = [];
      for (let r = 0; r < raw.rows; r++) {
        for (let c = 0; c < raw.cols; c++) {
          const v = codes[r * raw.cols + c];
          if (v === 3 || v === 2) walls.push(raw.origin[0] + (c + 0.5) * raw.resolution, raw.origin[1] + (r + 0.5) * raw.resolution);
        }
      }
      const a = raw.alignment;
      const al = { ox: a.offsetX, oz: a.offsetZ, yaw: a.yawRadians };
      const isRef = raw.id === payload.reference;
      const L = {
        id: raw.id, cols: raw.cols, rows: raw.rows, res: raw.resolution, origin: raw.origin, codes,
        walls: new Float64Array(walls), visible: true,
        align: { ...al }, loaded: { ...al }, method: a.method, loadedMethod: a.method,
        approved: Boolean(a.approved), dirty: false, img: null,
        color: isRef ? REF_COLOR : OTHER_PALETTE[otherIdx++ % OTHER_PALETTE.length],
        isRef,
        metrics: raw.metrics ?? null,
        floor: raw.floor ?? null, floorImg: null,
      };
      L.source = makeSource(L);
      L.olLayer = new ImageLayer({ source: L.source });
      map.addLayer(L.olLayer);
      if (L.floor) {
        const img = new Image();
        img.onload = () => refreshLayer(L);
        img.src = L.floor.dataUrl;
        L.floorImg = img;
      }
      return L;
    });
    $('aw-floor-row').hidden = !layers.some((L) => L.floor);
    selected = layers.find((L) => !L.isRef) ?? layers[0] ?? null;
    restack();
    renderLayerList();
    updatePanel();
    renderMetrics();
    $('aw-save').disabled = layers.length === 0;
    $('aw-merged').hidden = true; $('aw-project').hidden = true;
    $('aw-save-result').textContent = ''; $('aw-project-note').textContent = '';
    // 뷰가 막 보이기 시작한 프레임에는 컨테이너 크기가 0 일 수 있어 한 번 더 맞춘다
    requestAnimationFrame(fitAll);
    setTimeout(fitAll, 300);
  }

  async function loadGroup(name) {
    const note = $('aw-group-note');
    note.textContent = `'${name}' 여는 중…`;
    try {
      let status = (await listGroups()).find((g) => g.name === name);
      if (status && !status.ready) {
        note.textContent = `'${name}' 스캔 슬라이스를 준비하는 중… (스캔당 수십 초)`;
        status = await prepareGroup(name);
      }
      ws = await getGroupWorkspace(name);
      groupName = name;
      buildLayers(ws);
      note.textContent = `${ws.layers.length}개 스캔 · 기준 ${ws.reference}${status?.has_merged ? ' · 합성본 있음' : ''}`;
      if (status?.has_merged) { $('aw-merged').src = `${groupFileUrl(name, 'merged.png')}?t=${Date.now()}`; $('aw-merged').hidden = false; $('aw-project').hidden = false; }
      refreshHistory();
    } catch (err) {
      note.textContent = `열기 실패: ${err.message}`;
    }
  }

  async function refreshGroups() {
    const sel = $('aw-group');
    const note = $('aw-group-note');
    try {
      const groups = await listGroups();
      const prev = sel.value;
      sel.replaceChildren();
      for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = g.name;
        opt.textContent = `${g.name} · 스캔 ${g.scans.length}${g.ready ? '' : ' (준비 필요)'}${g.has_alignment ? ' · 정합됨' : ''}`;
        sel.appendChild(opt);
      }
      if (prev && groups.some((g) => g.name === prev)) sel.value = prev;
      note.textContent = groups.length ? '그룹을 골라 "열기"를 누르세요.' : '그룹이 없습니다. 스캔 위저드로 다중 스캔 zip 을 올리면 여기 나타납니다.';
      return groups;
    } catch (err) {
      note.textContent = `스튜디오 서버(:8000)에 연결할 수 없습니다: ${err.message}`;
      return [];
    }
  }
  $('aw-load').addEventListener('click', () => { if ($('aw-group').value) loadGroup($('aw-group').value); });
  $('aw-delete-group').addEventListener('click', async () => {
    const name = $('aw-group').value;
    if (!name) return;
    if (!confirm(`'${name}' 그룹을 삭제할까요?\n스캔 데이터와 정합 결과가 모두 사라지며 되돌릴 수 없습니다.`)) return;
    const note = $('aw-group-note');
    try {
      await deleteGroup(name);
      if (groupName === name) {
        buildLayers({ layers: [], reference: null }); // 지금 열려있던 그룹이면 캔버스도 비운다
        groupName = null;
        refreshHistory();
      }
      await refreshGroups();
      onToast(`'${name}' 그룹을 삭제했습니다.`);
    } catch (err) {
      note.textContent = `삭제 실패: ${err.message}`;
    }
  });

  // ---- 저장 기록: 저장할 때마다 그 직전 상태가 .history/ 에 남는다(studio/groups.py
  // save_alignment) -- 드래그/ICP/핀을 시행착오하다 잘못 저장해도 몇 걸음 전으로 돌아갈 수
  // 있게. "불러오기"는 화면에만 반영하고 자동 저장은 하지 않는다 -- 확인하고 나서 직접
  // 저장 버튼을 눌러야 실제로 반영되고, 그 저장 자체도 새 기록 한 칸을 남긴다.
  function formatHistoryTimestamp(ts) {
    // "YYYYMMDDTHHMMSSffffffZ" (UTC, studio/groups.py의 strftime 포맷)
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d{6}Z$/.exec(ts);
    if (!m) return ts;
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    if (Number.isNaN(date.getTime())) return ts;
    return date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function refreshHistory() {
    const sel = $('aw-history');
    const btn = $('aw-history-load');
    const note = $('aw-history-note');
    sel.replaceChildren();
    if (!groupName) { btn.disabled = true; note.textContent = ''; return; }
    try {
      const hist = await getGroupAlignmentHistory(groupName);
      if (!hist.length) {
        const opt = document.createElement('option');
        opt.textContent = '저장 기록 없음';
        sel.appendChild(opt);
        btn.disabled = true;
        note.textContent = '아직 저장한 적이 없습니다 -- 저장할 때마다 그 직전 상태가 여기 남습니다.';
        return;
      }
      for (const h of hist) {
        const opt = document.createElement('option');
        opt.value = h.timestamp;
        opt.textContent = `${formatHistoryTimestamp(h.timestamp)} · 승인 ${h.approved.length}/${h.scans}`;
        sel.appendChild(opt);
      }
      btn.disabled = false;
      note.textContent = `저장 ${hist.length}번 기록됨 (최신순)`;
    } catch (err) {
      const opt = document.createElement('option');
      opt.textContent = '기록 조회 실패';
      sel.appendChild(opt);
      btn.disabled = true;
      note.textContent = `기록 조회 실패: ${err.message}`;
    }
  }

  /** 과거 저장 기록(doc)의 정합 값을 지금 열려있는 레이어들에 그대로 얹는다 -- 저장은 안 함. */
  function applyAlignmentDoc(doc) {
    for (const L of layers) {
      if (L.isRef) continue;
      const a = doc.alignments?.[L.id];
      if (!a) continue;
      L.align = { ox: a.offsetX, oz: a.offsetZ, yaw: a.yawRadians };
      L.method = a.method ?? 'app';
      L.approved = Boolean(a.approved);
      L.dirty = true;
      L.metrics = null;
    }
    refreshAll();
    renderLayerList();
    updatePanel();
    renderMetrics();
    $('aw-save').disabled = layers.length === 0; // 불러온 값도 결국 markDirty와 같은 "저장 전" 상태
  }

  $('aw-history-load').addEventListener('click', async () => {
    const ts = $('aw-history').value;
    const note = $('aw-history-note');
    if (!ts || !groupName) return;
    try {
      const doc = await getGroupAlignmentHistoryEntry(groupName, ts);
      applyAlignmentDoc(doc);
      note.textContent = `${formatHistoryTimestamp(ts)} 시점을 화면에 불러왔습니다 -- 확인 후 저장을 눌러야 반영됩니다.`;
    } catch (err) {
      note.textContent = `불러오기 실패: ${err.message}`;
    }
  });

  // devtools 진단용 (rootEl.__alignWorkspace)
  Object.defineProperty(rootEl, '__alignWorkspace', { value: { get layers() { return layers; }, get selected() { return selected; }, get pins() { return pins; }, nearestWall, map }, configurable: true });

  let started = false;
  return {
    map,
    async show() {
      map.updateSize();
      if (!started) {
        started = true;
        const groups = await refreshGroups();
        if (groups.length === 1) loadGroup(groups[0].name);
      } else if (layers.length) {
        requestAnimationFrame(() => map.updateSize());
      }
    },
    resize() { map.updateSize(); },
    refreshGroups,
    loadGroup,
  };
}
