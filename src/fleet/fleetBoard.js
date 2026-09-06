// 운영 › 플릿 보드 -- 운영 화면 왼쪽의 로봇 목록. 한 줄에 상태가 다 읽히게
// (이름·연결·주행 상태·배터리·마지막 수신) 만들고, 행을 누르면 그 로봇이 이동 명령의
// 대상이 된다. 취소/일시정지/재개는 선택된 행에만 보인다. 데이터는 서버의
// /api/vda5050/stream 하나만 구독한다(fleetApi.js). 표 형태의 전체 보기(위치·주문·
// 오류 열)는 M2의 로봇 상세 화면으로 간다.
import { forgetFleetRobot, sendFleetInstantAction, subscribeFleetStream, getRobotOrders, getFleetEvents } from './fleetApi.js';
import { listRobots } from '../robots/robotApi.js';
import { activeProjectName } from '../appShared.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CONNECTION_LABEL = { ONLINE: '온라인', OFFLINE: '오프라인', CONNECTIONBROKEN: '연결 끊김', UNKNOWN: '알 수 없음' };

/** 값이 바뀔 때만 textContent 를 쓴다 -- 같은 값이라도 대입하면 텍스트 노드가 새로 만들어져, 누르고 있던 노드를 잃는다. */
function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

/** 상세 패널의 "위치 (x, y, θ)" 값 -- 매 틱 바뀌므로 패널을 다시 만들지 않고 이 문자열만 제자리에서 갱신한다. */
function formatPos(r) {
  const x = r.position?.x != null ? `${r.position.x.toFixed(2)}m` : '-';
  const y = r.position?.y != null ? `${r.position.y.toFixed(2)}m` : '-';
  const deg = r.position?.theta != null ? `${((r.position.theta * 180) / Math.PI).toFixed(1)}°` : '-';
  const posInit = r.position?.positionInitialized ? '초기화됨' : '미초기화';
  return `${x}, ${y}, ${deg} (${posInit})`;
}

/** 상세 패널/버튼의 모양을 정하는 값들만 모은 서명. 이게 같으면 패널을 다시 만들지 않는다(높이 흔들림·주문 이력 재조회 방지). */
function detailSignature(r, reg, s, online) {
  return JSON.stringify([
    online, r.connectionState, r.position?.mapId ?? null, r.position?.positionInitialized ?? null,
    s?.orderId ?? null, s?.lastNodeId ?? null, s?.nodesLeft ?? null, s?.paused ?? null, s?.driving ?? null,
    s?.operatingMode ?? null, s?.safetyState?.eStop ?? null, s?.safetyState?.fieldViolation ?? null,
    s?.batteryCharge != null ? Math.round(s.batteryCharge) : null, s?.batteryVoltage != null ? s.batteryVoltage.toFixed(1) : null,
    s?.errors ?? null, r.lastOrder?.waypoints ?? null, reg?.id ?? null,
  ]);
}

function fmtAge(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return '방금';
  if (ms < 60_000) return `${Math.round(ms / 1000)}초 전`;
  return `${Math.round(ms / 60_000)}분 전`;
}

function detailItem(label, val, isAlert = false) {
  const d = el('div', 'fleet-detail-item');
  d.appendChild(el('span', 'fleet-detail-label', label));
  const b = el('b', 'fleet-detail-val', val);
  if (isAlert) b.style.color = '#e57373';
  d.appendChild(b);
  return d;
}

function renderRobotDetail(r, reg, s) {
  const detail = el('div', 'fleet-row-detail');
  const grid = el('div', 'fleet-detail-grid');

  const posItem = detailItem('위치 (x, y, θ)', formatPos(r));
  posItem.querySelector('.fleet-detail-val').dataset.field = 'pos'; // render() 가 매 틱 제자리에서 갱신
  grid.appendChild(posItem);
  grid.appendChild(detailItem('좌표계 (mapId)', r.position?.mapId ?? 'default'));

  const orderText = s?.orderId ? `${s.orderId} (노드 ${s.lastNodeId ?? '-'}, 잔여 ${s.nodesLeft ?? 0})` : '주문 없음';
  grid.appendChild(detailItem('현재 주문', orderText));
  grid.appendChild(detailItem('운용 모드', s?.operatingMode ?? 'AUTOMATIC'));

  const eStop = s?.safetyState?.eStop ?? 'NONE';
  const safeText = eStop !== 'NONE' ? `E-STOP (${eStop})` : s?.safetyState?.fieldViolation ? '영역 침범' : '정상';
  grid.appendChild(detailItem('안전 상태', safeText, eStop !== 'NONE'));

  const battVolt = s?.batteryVoltage != null ? `${s.batteryVoltage.toFixed(1)}V` : '';
  const battCharge = s?.batteryCharge != null ? `${s.batteryCharge.toFixed(0)}%` : '';
  const battCombined = [battCharge, battVolt].filter(Boolean).join(' · ') || '-';
  grid.appendChild(detailItem('배터리', battCombined));

  if (reg) {
    grid.appendChild(detailItem('모델 / 속도', `${reg.company ?? r.manufacturer} · 최대 ${reg.speedMps ?? '-'}m/s`));
    grid.appendChild(detailItem('알고리즘 / 반경', `${reg.algorithm ?? '-'} · 반경 ${reg.sizeMeters ?? '-'}m`));
  }
  detail.appendChild(grid);

  if (s?.errors && s.errors.length > 0) {
    const errBox = el('div', 'fleet-detail-errors');
    errBox.appendChild(el('div', 'fleet-detail-errors-title', `오류 목록 (${s.errors.length}건)`));
    for (const e of s.errors) {
      const errItem = el('div', `fleet-detail-error-item ${e.errorLevel === 'FATAL' ? 'fatal' : 'warn'}`);
      errItem.textContent = `[${e.errorLevel ?? 'WARN'}] ${e.errorType}: ${e.errorDescription ?? '-'}`;
      errBox.appendChild(errItem);
    }
    detail.appendChild(errBox);
  }

  // 주문 진행률 바
  if (s?.orderId) {
    const total = (r.lastOrder?.waypoints || (s.nodesLeft ? s.nodesLeft + 1 : 0));
    const left = s.nodesLeft ?? 0;
    const traversed = total > 0 ? Math.max(0, total - left) : 0;
    const pct = total > 0 ? Math.min(100, Math.round((traversed / total) * 100)) : (s.driving ? 50 : 0);
    const progBox = el('div', 'fleet-order-progress-box');
    progBox.innerHTML = `
      <div class="fleet-order-progress-labels">
        <span>주문 진행률: <b>노드 ${s.lastNodeId ?? '시작'}</b> (잔여 ${left}개)</span>
        <span>${pct}%</span>
      </div>
      <div class="fleet-order-progress-bar"><div class="fleet-order-progress-fill" style="width: ${pct}%"></div></div>
    `;
    detail.appendChild(progBox);
  }

  // 최근 주문 이력
  const ordersBox = el('div', 'fleet-detail-orders');
  ordersBox.appendChild(el('div', 'fleet-detail-orders-title', '최근 주문 이력'));
  const ordersList = el('div', 'fleet-detail-orders-list', '주문 이력 조회 중...');
  ordersBox.appendChild(ordersList);
  detail.appendChild(ordersBox);

  getRobotOrders(r.serialNumber)
    .then(({ orders }) => {
      ordersList.replaceChildren();
      if (!orders || orders.length === 0) {
        ordersList.textContent = '기록된 주문이 없습니다.';
        return;
      }
      for (const o of orders.slice(0, 4)) {
        const row = el('div', 'fleet-order-item');
        const statusClass = (o.status || 'SENT').toLowerCase();
        row.innerHTML = `
          <div class="fleet-order-item-header">
            <span class="fleet-order-id">${o.orderId.slice(0, 8)}...</span>
            <span class="fleet-order-badge ${statusClass}">${o.status || 'SENT'}</span>
            <span class="fleet-order-time">${fmtAge(Date.now() - o.sentAt)}</span>
          </div>
          <div class="fleet-order-item-sub">노드 ${o.nodeCount}개 · map: ${o.mapId} ${o.lastNodeId ? `· 위치: ${o.lastNodeId}` : ''}</div>
        `;
        ordersList.appendChild(row);
      }
    })
    .catch(() => { ordersList.textContent = '주문 이력 조회 실패'; });

  return detail;
}

/**
 * @param {HTMLElement} containerEl
 * @param {{ onSelect?: (robot|null) => void, onStatus?: (text, isError) => void }} opts
 *   onSelect 로 넘기는 robot 은 플릿 레코드(serialNumber, manufacturer, position, state, ...)에
 *   레지스트리 항목이 있으면 `registry` 필드로 붙는다.
 */
export function createFleetBoard(containerEl, { onSelect = () => {}, onStatus = () => {} } = {}) {
  containerEl.classList.add('fleet-board');
  const header = el('div', 'fleet-board-header');
  const title = el('span', 'fleet-board-title', '로봇');
  const brokerDot = el('span', 'fleet-board-broker', '브로커 확인 중');
  header.append(title, brokerDot);

  const globalActions = el('div', 'fleet-board-globals');
  const stopAllBtn = el('button', 'robot-button robot-button-danger', '전체 정지');
  const pauseAllBtn = el('button', 'robot-button', '전체 일시정지');
  const resumeAllBtn = el('button', 'robot-button', '전체 재개');
  globalActions.append(stopAllBtn, pauseAllBtn, resumeAllBtn);

  const list = el('div', 'fleet-board-list');
  // 위임된 클릭/키보드 -- 행(.fleet-row)은 스트림이 올 때마다 통째로 다시 만들어지므로, 행 자체에 리스너를
  // 붙이면 "지금 이 순간의 그 DOM 노드"에 묶인다. list 컨테이너는 절대 교체되지 않으니 여기 하나만 달아두고
  // 클릭 시점에 실제로 화면에 있는 행을 data-serial 로 찾는다 -- 재렌더링 타이밍과 무관하게 항상 맞는다.
  // 선택 판정은 브라우저의 click 합성에 기대지 않는다. Chrome 은 mousedown 과 mouseup 이 같은 요소가 아니면
  // click 을 안 만드는데, 누르고 있는 사이에 위쪽 카드(선택된 로봇의 상세 패널)가 갱신되며 높이가 바뀌면 아래
  // 카드가 밀려 mouseup 이 다른 요소에 떨어진다 -- Playwright 로 사람처럼 눌렀다 떼면 실제로 재현됨(60회 중 2회).
  // 그래서 pointerdown 에서 누른 카드를 기억하고, pointerup 에서 손이 8px 안에서 떨어졌으면 그 카드를 선택한다.
  let press = null; // { serial, x, y, at }
  let pointerSelectedAt = 0;
  list.addEventListener('pointerdown', (e) => {
    press = null;
    if (e.button !== 0 || e.target.closest('button')) return;
    const row = e.target.closest('.fleet-row');
    if (row && list.contains(row)) press = { serial: row.dataset.serial, x: e.clientX, y: e.clientY };
  });
  list.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || e.button !== 0 || e.target.closest('button')) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) return; // 드래그는 클릭이 아니다
    pointerSelectedAt = performance.now();
    select(p.serial === selectedSerial ? null : p.serial);
  });
  list.addEventListener('pointercancel', () => { press = null; });
  // click 은 키보드(Enter/Space → row.click()) 등 포인터 없이 오는 경우의 보조 경로. 방금 pointerup 이 처리한
  // 직후에 따라오는 click 은 무시한다(같은 클릭을 두 번 토글하지 않게).
  list.addEventListener('click', (e) => {
    if (performance.now() - pointerSelectedAt < 400) return;
    const row = e.target.closest('.fleet-row');
    if (!row || !list.contains(row)) return;
    if (e.target.closest('button')) return; // 취소/일시정지/제거 버튼은 자기 핸들러가 처리(stopPropagation)
    const serial = row.dataset.serial;
    select(serial === selectedSerial ? null : serial);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.fleet-row');
    if (!row) return;
    e.preventDefault();
    row.click();
  });
  const empty = el('div', 'fleet-board-empty', '수신한 로봇이 없습니다. 설정에서 브로커를 연결하세요.');

  const eventsWrap = el('div', 'fleet-board-events');
  const eventsHeader = el('div', 'fleet-events-header');
  eventsHeader.appendChild(el('span', 'fleet-events-title', '플릿 이벤트 로그'));
  const eventsToggleBtn = el('button', 'fleet-events-toggle-btn', '접기');
  eventsHeader.appendChild(eventsToggleBtn);
  eventsWrap.appendChild(eventsHeader);

  const eventsBox = el('div', 'fleet-events-box');
  eventsWrap.appendChild(eventsBox);
  containerEl.append(header, globalActions, list, empty, eventsWrap);

  const fleetEvents = [];
  function renderEvents() {
    eventsBox.replaceChildren();
    if (fleetEvents.length === 0) {
      eventsBox.appendChild(el('div', 'fleet-event-empty', '기록된 이벤트가 없습니다.'));
      return;
    }
    for (const ev of fleetEvents.slice(0, 15)) {
      const item = el('div', `fleet-event-item ${(ev.level || 'info').toLowerCase()}`);
      const timeStr = new Date(ev.timestamp).toLocaleTimeString();
      item.innerHTML = `
        <span class="fleet-event-time">${timeStr}</span>
        <span class="fleet-event-badge ${(ev.level || 'info').toLowerCase()}">${ev.type || 'INFO'}</span>
        <span class="fleet-event-bot">${ev.serialNumber}</span>
        <span class="fleet-event-msg">${ev.message}</span>
      `;
      eventsBox.appendChild(item);
    }
  }

  let eventsCollapsed = false;
  eventsToggleBtn.addEventListener('click', () => {
    eventsCollapsed = !eventsCollapsed;
    eventsBox.style.display = eventsCollapsed ? 'none' : 'flex';
    eventsToggleBtn.textContent = eventsCollapsed ? '펼치기' : '접기';
  });

  getFleetEvents()
    .then(({ events }) => {
      if (events && events.length) {
        fleetEvents.splice(0, fleetEvents.length, ...events);
        renderEvents();
      }
    })
    .catch(() => {});

  const robots = new Map(); // key -> record
  let registryBySerial = new Map();
  let brokerStatus = { connected: false };
  let staleAfterMs = 5000;
  let selectedSerial = null;

  async function loadRegistry() {
    try {
      const all = await listRobots();
      registryBySerial = new Map(all.filter((r) => r.vda5050Serial).map((r) => [r.vda5050Serial, r]));
    } catch {
      /* 레지스트리 없이도 목록은 뜬다 */
    }
  }

  function decorate(r) {
    return { ...r, registry: registryBySerial.get(r.serialNumber) ?? null };
  }

  function select(serial) {
    selectedSerial = serial;
    render();
    const r = Array.from(robots.values()).find((x) => x.serialNumber === serial);
    onSelect(r ? decorate(r) : null);
  }

  async function action(r, actionType, button) {
    button.disabled = true;
    try {
      await sendFleetInstantAction(r.manufacturer, r.serialNumber, actionType);
      onStatus(`${r.serialNumber}: ${actionType} 전송`, false);
    } catch (err) {
      onStatus(`${r.serialNumber}: ${actionType} 실패 — ${err.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  stopAllBtn.addEventListener('click', async () => {
    stopAllBtn.disabled = true;
    try {
      const list = Array.from(robots.values()).filter((r) => r.connectionState === 'ONLINE');
      await Promise.all(list.map((r) => sendFleetInstantAction(r.manufacturer, r.serialNumber, 'cancelOrder').catch(() => {})));
      onStatus(`전체 ${list.length}대 비상정지 완료`, false);
    } catch (e) {
      onStatus(`전체 정지 실패: ${e.message}`, true);
    } finally {
      stopAllBtn.disabled = false;
    }
  });

  pauseAllBtn.addEventListener('click', async () => {
    pauseAllBtn.disabled = true;
    try {
      const list = Array.from(robots.values()).filter((r) => r.connectionState === 'ONLINE');
      await Promise.all(list.map((r) => sendFleetInstantAction(r.manufacturer, r.serialNumber, 'startPause').catch(() => {})));
      onStatus(`전체 ${list.length}대 일시정지 전송`, false);
    } catch (e) {
      onStatus(`전체 일시정지 실패: ${e.message}`, true);
    } finally {
      pauseAllBtn.disabled = false;
    }
  });

  resumeAllBtn.addEventListener('click', async () => {
    resumeAllBtn.disabled = true;
    try {
      const list = Array.from(robots.values()).filter((r) => r.connectionState === 'ONLINE');
      await Promise.all(list.map((r) => sendFleetInstantAction(r.manufacturer, r.serialNumber, 'stopPause').catch(() => {})));
      onStatus(`전체 ${list.length}대 재개 전송`, false);
    } catch (e) {
      onStatus(`전체 재개 실패: ${e.message}`, true);
    } finally {
      resumeAllBtn.disabled = false;
    }
  });

  // 로봇이 주행 중이면 위치/state 메시지가 초당 여러 번 들어와서, 메시지마다 바로 render()(list.replaceChildren())를
  // 부르면 카드 DOM이 그만큼 자주 통째로 새로 만들어진다 -- 사용자가 카드를 클릭한 그 순간에 하필 다시 그려지면
  // 클릭이 옛 DOM 노드에 떨어져 씹힌다("카드를 눌러도 선택이 안 됨"). 짧은 지연으로 묶는다.
  // requestAnimationFrame이 아니라 setTimeout을 쓴다 -- 운영 화면은 사용자가 다른 창/탭으로 넘어가 있어도 계속
  // 최신 상태를 유지해야 하는데, rAF는 탭/창이 백그라운드면 브라우저가 통째로 멈춰버린다(그러면 다시 돌아올 때까지
  // render()가 단 한 번도 안 불려 목록이 영영 비어 보인다 -- 실제로 이 문제로 재현/디버깅함).
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 50);
  }
  // 행 DOM을 로봇 serialNumber 로 유지한다(키드 패치) -- 예전에는 render() 마다 list.replaceChildren() 로
  // 전부 새로 만들었는데, 그러면 "지금 이 카드"라는 개념 자체가 렌더 사이클마다 사라진다. 실제 사용자 클릭으로
  // 재현됨: mousedown 시점의 카드가 mouseup 전에 완전히 제거되면 일부 브라우저는 click 이벤트 자체를 안 낸다
  // (위임 리스너를 list 에 달아도 소용없음 -- click 이 아예 안 뜨니까). 그래서 데이터가 안 바뀐 로봇은 같은
  // DOM 노드를 계속 재사용하고, 내용만 바꾼다.
  const rowEntries = new Map(); // serialNumber -> { el, icon, name, sub, side: {pill, batt}, main }
  function ensureRowEntry(serial) {
    let entry = rowEntries.get(serial);
    if (entry) return entry;
    const row = el('div', 'fleet-row');
    row.dataset.serial = serial;
    row.tabIndex = 0;
    const icon = document.createElement('img');
    icon.className = 'fleet-row-icon';
    const main = el('div', 'fleet-row-main');
    const name = el('div', 'fleet-row-name');
    const sub = el('div', 'fleet-row-sub');
    main.append(name, sub);
    const side = el('div', 'fleet-row-side');
    const pill = el('span', 'fleet-pill');
    const batt = el('span', 'fleet-row-batt');
    side.append(pill, batt);
    row.append(icon, main, side);
    entry = { row, icon, main, name, sub, pill, batt, prox: null, err: null, extra: null };
    rowEntries.set(serial, entry);
    return entry;
  }

  // 다른 현장(pathfinder 프로젝트)의 로봇은 같은 브로커를 공유해도 이 보드에 안 보여야 한다
  // (liveRobotPose.js/site3dView.js와 같은 규칙: mapId 없으면 예전처럼 항상 보여준다).
  function belongsHere(r) {
    return !r.position?.mapId || r.position.mapId === activeProjectName;
  }

  function render() {
    const now = Date.now();
    const rows = Array.from(robots.values())
      .filter(belongsHere)
      .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
    title.textContent = `로봇 ${rows.length}`;
    brokerDot.textContent = brokerStatus.connected ? '브로커 연결됨' : '브로커 끊김';
    brokerDot.classList.toggle('on', brokerStatus.connected);
    globalActions.style.display = rows.length > 0 ? 'flex' : 'none';
    empty.hidden = rows.length > 0;

    // 플릿 간 근접 감지 (거리 1.2m 이내면 경고 배지 표시)
    const proximityWarnings = new Map();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (a.position?.x != null && b.position?.x != null && a.connectionState === 'ONLINE' && b.connectionState === 'ONLINE') {
          const dist = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
          if (dist < 1.2) {
            proximityWarnings.set(a.serialNumber, `근접 ${dist.toFixed(2)} m · ${b.serialNumber}`);
            proximityWarnings.set(b.serialNumber, `근접 ${dist.toFixed(2)} m · ${a.serialNumber}`);
          }
        }
      }
    }

    // 사라진 로봇의 행만 지운다 -- 남아있는 로봇의 행은 절대 떼어내지 않는다(클릭 중일 수 있으므로).
    const currentSerials = new Set(rows.map((r) => r.serialNumber));
    for (const [serial, entry] of rowEntries) {
      if (!currentSerials.has(serial)) {
        entry.row.remove();
        rowEntries.delete(serial);
      }
    }

    for (const r of rows) {
      const reg = registryBySerial.get(r.serialNumber);
      const s = r.state;
      const age = r.lastSeen ? now - r.lastSeen : null;
      const stale = age != null && age > staleAfterMs;
      const online = brokerStatus.connected && r.connectionState === 'ONLINE' && !stale;
      const entry = ensureRowEntry(r.serialNumber);
      const { row, icon, main, name, sub, pill, batt } = entry;

      row.classList.toggle('selected', r.serialNumber === selectedSerial);
      row.classList.toggle('offline', !online);

      if (reg?.icon) { if (icon.getAttribute('src') !== reg.icon) icon.src = reg.icon; icon.hidden = false; } else { icon.hidden = true; if (icon.hasAttribute('src')) icon.removeAttribute('src'); }

      // 값이 실제로 바뀔 때만 쓴다. textContent 대입은 값이 같아도 텍스트 노드를 새로 갈아끼우는데, 사용자가
      // 누르고 있는 자리가 바로 이 글자(예: .fleet-row-name)면 Chrome 이 누른 노드를 잃어 click 을 안 만든다.
      setText(name, reg?.name ?? r.serialNumber);
      const conn = CONNECTION_LABEL[r.connectionState] ?? CONNECTION_LABEL.UNKNOWN;
      const stateText = !online ? conn + (stale && r.connectionState === 'ONLINE' ? ' · 오래됨' : '') : !s ? '온라인' : s.paused ? '일시정지' : s.driving ? `주행 중 · 남은 노드 ${s.nodesLeft ?? '-'}` : s.nodesLeft ? '대기' : '유휴';
      setText(sub, `${stateText} · ${fmtAge(age)}`);

      const prox = proximityWarnings.get(r.serialNumber) ?? null;
      if (prox) {
        if (!entry.prox) { entry.prox = el('div', 'fleet-row-prox'); main.appendChild(entry.prox); }
        setText(entry.prox, prox);
      } else if (entry.prox) {
        entry.prox.remove();
        entry.prox = null;
      }

      const lastErr = s?.errors?.length ? s.errors[s.errors.length - 1] : null;
      if (lastErr) {
        if (!entry.err) { entry.err = el('div', 'fleet-row-error'); main.appendChild(entry.err); }
        setText(entry.err, `${lastErr.errorType}${lastErr.errorLevel === 'FATAL' ? ' (FATAL)' : ''}`);
        const title = lastErr.errorDescription ?? '';
        if (entry.err.title !== title) entry.err.title = title;
      } else if (entry.err) {
        entry.err.remove();
        entry.err = null;
      }

      const pillClass = `fleet-pill ${!online ? 'off' : s?.paused ? 'paused' : s?.driving ? 'driving' : 'idle'}`;
      if (pill.className !== pillClass) pill.className = pillClass;
      setText(pill, !online ? '●' : s?.paused ? '∥' : s?.driving ? '▶' : '●');
      setText(batt, s?.batteryCharge != null ? `${s.batteryCharge.toFixed(0)}%` : '');

      // 선택된 행에만 붙는 취소/일시정지/제거 버튼 + 상세 -- 선택된 로봇 하나만 값이 자주 바뀌므로
      // (다른 두 행의 본체는 그대로) 이 부분만 매번 다시 만들어도 클릭 대상 자체엔 영향이 없다.
      if (r.serialNumber === selectedSerial) {
        const sig = detailSignature(r, reg, s, online);
        if (entry.extra && entry.extra.sig === sig) {
          // 모양이 안 바뀜 -> 패널을 그대로 두고 매 틱 바뀌는 위치 글자만 제자리에서 갱신 (높이 불변, 재조회 없음)
          const posEl = entry.extra.detail.querySelector('[data-field="pos"]');
          if (posEl) setText(posEl, formatPos(r));
          if (row.parentNode !== list) list.appendChild(row);
          continue;
        }
        if (entry.extra) entry.extra.remove();
        const actions = el('div', 'fleet-row-actions');
        const cancelBtn = el('button', 'robot-button robot-button-danger', '취소');
        cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); action(r, 'cancelOrder', cancelBtn); });
        const pauseBtn = el('button', 'robot-button', s?.paused ? '재개' : '일시정지');
        // VDA5050: startPause = 일시정지, stopPause = 재개
        pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); action(r, s?.paused ? 'stopPause' : 'startPause', pauseBtn); });
        const forgetBtn = el('button', 'robot-button', '목록에서 제거');
        forgetBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await forgetFleetRobot(r.manufacturer, r.serialNumber);
            robots.delete(r.key);
            select(null);
          } catch (err) {
            onStatus(`제거 실패 — ${err.message}`, true);
          }
        });
        cancelBtn.disabled = pauseBtn.disabled = !online;
        actions.append(cancelBtn, pauseBtn, forgetBtn);
        const detail = renderRobotDetail(r, reg, s);
        row.append(actions, detail);
        entry.extra = { sig, detail, remove: () => { actions.remove(); detail.remove(); } };
      } else if (entry.extra) {
        entry.extra.remove();
        entry.extra = null;
      }

      // 새 행만 붙인다. 이미 붙어 있는 행은 여기서 절대 건드리지 않는다 -- appendChild 는 "이미 있는 자식"이라도
      // 떼었다가 다시 넣는 동작이라(Chrome), 사용자가 마우스를 누르고 있는 동안 그게 일어나면 click 이벤트 자체가
      // 취소된다. Playwright 로 사람처럼 40~160ms 눌렀다 떼면 24회 중 23회 click 이 안 뜨는 걸로 재현됨.
      if (row.parentNode !== list) list.appendChild(row);
    }

    // 정렬 순서가 실제로 달라졌을 때만(로봇 추가/제거 등 드문 경우) 옮긴다.
    const desired = rows.map((r) => r.serialNumber);
    const current = Array.from(list.children).map((c) => c.dataset.serial);
    if (desired.join('\n') !== current.join('\n')) {
      for (const serial of desired) list.appendChild(rowEntries.get(serial).row);
    }
  }

  const stream = subscribeFleetStream((msg) => {
    if (msg.type === 'snapshot') {
      brokerStatus = msg.status;
      staleAfterMs = msg.staleAfterMs ?? staleAfterMs;
      robots.clear();
      for (const r of msg.robots) robots.set(r.key, r);
      if (msg.events && msg.events.length) {
        fleetEvents.splice(0, fleetEvents.length, ...msg.events);
        renderEvents();
      }
      loadRegistry().then(scheduleRender);
    } else if (msg.type === 'robot') {
      const isNew = !robots.has(msg.robot.key);
      robots.set(msg.robot.key, msg.robot);
      if (isNew) setTimeout(() => loadRegistry().then(scheduleRender), 800); // 서버 자동 등록 뒤
      if (msg.robot.serialNumber === selectedSerial) onSelect(decorate(msg.robot));
    } else if (msg.type === 'event' && msg.event) {
      fleetEvents.unshift(msg.event);
      if (fleetEvents.length > 50) fleetEvents.pop();
      renderEvents();
    } else if (msg.type === 'status') {
      brokerStatus = msg.status;
    } else if (msg.type === 'forget') {
      robots.delete(msg.key);
    }
    scheduleRender();
  });
  const ageTimer = setInterval(scheduleRender, 2000);

  return {
    select,
    getSelected: () => { const r = Array.from(robots.values()).find((x) => x.serialNumber === selectedSerial); return r ? decorate(r) : null; },
    robots,
    destroy() { stream.close(); clearInterval(ageTimer); },
  };
}
