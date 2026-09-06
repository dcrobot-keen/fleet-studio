import Feature from 'ol/Feature.js';
import PointGeom from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Style from 'ol/style/Style.js';
import CircleStyle from 'ol/style/Circle.js';
import Icon from 'ol/style/Icon.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Text from 'ol/style/Text.js';

// sizeMeters(등록된 로봇의 실제 폭/지름)가 REFERENCE_SIZE_M일 때 기본 아이콘 크기가 되도록
// 비례시킨다. 화면 줌에 따라 실시간으로 정확한 미터 축척을 유지하진 않지만(그러려면 매
// 프레임 재계산이 필요), 로봇 간 크기 차이를 마커에 반영하기엔 충분하다.
// tab.js의 deconfliction 반경 계산도 이 기본값을 그대로 재사용한다.
export const REFERENCE_SIZE_M = 0.5;
const BASE_ICON_SCALE = 0.4;
const BASE_CIRCLE_RADIUS = 7;

// labelPlacement 'overlay'(기본, 예전부터 있던 동작): 마커 중심에 겹쳐서 "아이콘 위 번호"처럼(길찾기
// 데모의 짧은 순번용). 'below': 아이콘 아래로 내리고 배경을 깔아 긴 글자(로봇 이름 등)도 안 겹치고 읽히게.
function labelTextStyle(label, placement) {
  if (label === undefined || label === null) return undefined;
  if (placement === 'below') {
    return new Text({
      text: String(label),
      font: '11px sans-serif',
      fill: new Fill({ color: '#fff' }),
      stroke: new Stroke({ color: '#000', width: 3 }),
      offsetY: 14,
      textBaseline: 'top',
    });
  }
  return new Text({
    text: String(label),
    font: 'bold 12px sans-serif',
    fill: new Fill({ color: '#fff' }),
    stroke: new Stroke({ color: '#000', width: 3 }),
    offsetY: -1, // 마커 중심에 최대한 겹쳐서 "아이콘 위 번호"처럼 보이게
  });
}

// tab.js의 시뮬레이션 애니메이션과 liveRobotPose.js의 실시간 마커가 같은 아이콘
// 렌더링 규칙(등록된 로봇 크기 비례, 회전 등)을 공유하도록 export한다.
export function robotMarkerStyle(
  color,
  iconSrc,
  { paused = false, sizeMeters = REFERENCE_SIZE_M, label, labelPlacement = 'overlay', rotation, dashed = false, selected = false } = {}
) {
  const sizeRatio = sizeMeters / REFERENCE_SIZE_M;
  const text = labelTextStyle(label, labelPlacement);
  const styles = [];

  // 선택 표시: 아이콘보다 한 단계 큰 반투명 고리를 아이콘 뒤에 깐다. 회전(rotation)은 안 준다 --
  // 로봇 몸체가 도는 것과 헷갈리지 않게 고리는 항상 정지된 원으로.
  if (selected) {
    const ringRadius = Math.min(30, Math.max(14, BASE_CIRCLE_RADIUS * sizeRatio * 2.1));
    styles.push(
      new Style({
        image: new CircleStyle({
          radius: ringRadius,
          fill: new Fill({ color: 'rgba(79, 209, 197, 0.18)' }),
          stroke: new Stroke({ color: '#4fd1c5', width: 2 }),
        }),
        zIndex: -1,
      })
    );
  }

  if (iconSrc) {
    // ol/style/Icon의 size 옵션은 "스프라이트 시트에서 잘라올 영역" 지정용이라
    // 단일 아이콘에는 쓰면 안 된다 — shared/robotIcons.mjs가 SVG에 width/height=64를
    // 명시해두므로 자연 크기를 그대로 읽어 scale만으로 최종 크기를 정한다.
    // 하한 0.35(≈22px): TB3 크기(0.2m)의 시뮬레이터 로봇도 아이콘이 점이 아니라 아이콘으로 보이게.
    const scale = Math.min(1.2, Math.max(0.35, BASE_ICON_SCALE * sizeRatio));
    styles.push(new Style({ image: new Icon({ src: iconSrc, scale, opacity: paused ? 0.35 : 1, rotation }), text }));
    return styles;
  }
  const radius = Math.min(18, Math.max(4, BASE_CIRCLE_RADIUS * sizeRatio));
  styles.push(
    new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: paused ? 'rgba(150,150,150,0.6)' : color }),
        // dashed: 시뮬레이터 로봇(실제로 존재하지 않는 가상 개체)을 실제 로봇과
        // 혼동하지 않도록, 색상 외에도 테두리 자체를 점선으로 구분한다.
        stroke: new Stroke({ color: '#fff', width: 2, lineDash: dashed ? [3, 2] : undefined }),
      }),
      text,
    })
  );
  return styles;
}

export function randomPathColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 75%, 45%)`;
}

function cumulativeLengths(coords) {
  const lens = [0];
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    lens.push(lens[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }
  return lens;
}

function pointAtDistance(coords, lens, d) {
  const total = lens[lens.length - 1];
  if (d <= 0) return { point: coords[0], segmentIndex: 0 };
  if (d >= total) return { point: coords[coords.length - 1], segmentIndex: coords.length - 1 };
  let i = 1;
  while (lens[i] < d) i++;
  const segStart = lens[i - 1];
  const segLen = lens[i] - segStart;
  const t = segLen === 0 ? 0 : (d - segStart) / segLen;
  const [x1, y1] = coords[i - 1];
  const [x2, y2] = coords[i];
  return {
    point: [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t],
    segmentIndex: i - 1,
  };
}

/**
 * 경로를 랜덤 색상 선으로 그리고, 로봇 마커를 실제 metersPerSecond 속도로
 * start->end까지 이동시킨다(지도 좌표계가 m 단위이므로 화면 배율과 무관하게 실속도).
 * 지나간 구간은 선에서 지워진다(trail 삭제).
 * @param {import('ol/Map.js').default} map
 * @param {import('ol/source/Vector.js').default} source
 * @param {Array<[number, number]>} coords
 * @param {{ metersPerSecond?: number, sizeMeters?: number, color?: string, iconSrc?: string, label?: string|number, onDone?: () => void }} [options]
 *   iconSrc가 주어지면 로봇 마커를 원형 점 대신 해당 아이콘(등록된 로봇의 아이콘)으로 그린다.
 *   sizeMeters는 마커 크기에 반영된다(로봇 등록 값 기준, 기본 0.5m).
 *   label이 주어지면 마커 위에 번호/텍스트를 겹쳐 그린다(deconfliction 목록과 대응시키는 용도).
 * @returns {{
 *   stop: () => void,
 *   pause: () => void,
 *   resume: () => void,
 *   isPaused: () => boolean,
 *   getPosition: () => [number, number],
 *   setLabel: (label: string|number) => void,
 * }}
 */
export function animatePathAndRobot(map, source, coords, options = {}) {
  const {
    metersPerSecond = 1.0,
    sizeMeters = REFERENCE_SIZE_M,
    color = randomPathColor(),
    iconSrc,
    label,
    onDone,
  } = options;

  if (coords.length < 2) {
    return {
      stop() {},
      pause() {},
      resume() {},
      isPaused: () => false,
      getPosition: () => coords[0],
      getRemainingPath: () => coords,
      setLabel() {},
      metersPerSecond,
    };
  }

  const pathFeature = new Feature(new LineString(coords));
  pathFeature.setStyle(new Style({ stroke: new Stroke({ color, width: 3 }) }));

  let currentLabel = label;
  const robotFeature = new Feature(new PointGeom(coords[0]));
  robotFeature.setStyle(robotMarkerStyle(color, iconSrc, { sizeMeters, label: currentLabel }));

  source.addFeatures([pathFeature, robotFeature]);

  const lens = cumulativeLengths(coords);
  const total = lens[lens.length - 1];
  let traveled = 0;
  let lastTime = null;
  let rafId = null;
  let stopped = false;
  let paused = false;
  // deconfliction이 "현재 위치"가 아니라 "앞으로 지나갈 구간"을 기준으로 판단할 수
  // 있도록, 매 프레임 갱신되는 현재 위치와 잘라낸 나머지 경로를 별도로 들고 있는다.
  let currentPoint = coords[0];
  let remainingCoords = coords;

  function finish() {
    stopped = true;
    source.removeFeature(pathFeature);
    source.removeFeature(robotFeature);
    if (onDone) onDone();
  }

  function frame(time) {
    if (stopped || paused) return;
    if (lastTime === null) lastTime = time;
    const dt = (time - lastTime) / 1000;
    lastTime = time;

    traveled += metersPerSecond * dt;

    if (total === 0 || traveled >= total) {
      finish();
      return;
    }

    const { point, segmentIndex } = pointAtDistance(coords, lens, traveled);
    currentPoint = point;
    remainingCoords = [point, ...coords.slice(segmentIndex + 1)];
    robotFeature.getGeometry().setCoordinates(point);
    pathFeature.getGeometry().setCoordinates(remainingCoords);

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      source.removeFeature(pathFeature);
      source.removeFeature(robotFeature);
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      robotFeature.setStyle(robotMarkerStyle(color, iconSrc, { paused: true, sizeMeters, label: currentLabel }));
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      robotFeature.setStyle(robotMarkerStyle(color, iconSrc, { paused: false, sizeMeters, label: currentLabel }));
      lastTime = null; // 정지해 있던 시간이 dt로 잡혀 순간이동하지 않도록 리셋
      rafId = requestAnimationFrame(frame);
    },
    isPaused: () => paused,
    getPosition: () => robotFeature.getGeometry().getCoordinates(),
    // 현재 위치부터 목적지까지 남은 경로(polyline). 이미 지나온 구간은 빠져 있으므로
    // 이 경로끼리 비교하면 "이미 지나간 로봇"이 더 이상 충돌 판정에 끼어들지 않는다.
    getRemainingPath: () => remainingCoords,
    // deconfliction 리스트의 번호를 마커 위 라벨과 동기화할 때 사용(우선순위 변경 등).
    setLabel(newLabel) {
      currentLabel = newLabel;
      robotFeature.setStyle(robotMarkerStyle(color, iconSrc, { paused, sizeMeters, label: currentLabel }));
    },
    // deconfliction이 "앞으로 몇 초 안에 실제로 갈 만한 거리"를 계산할 수 있도록
    // 실제 이동 속도도 노출한다.
    metersPerSecond,
  };
}
