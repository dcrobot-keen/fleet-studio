// 시뮬레이션 레일 맨 위의 시뮬레이터 카드 -- 지금까지 deploy/.env 를 손으로 고치고 터미널에서 docker compose 를
// 다시 실행해야 했던 일(어떤 월드를 로드할지 · 로봇을 몇 대 띄울지 · 시작/정지)을 화면에서 하게 해준다.
// server/simControl.mjs 참고. brokerSettings.js 의 카드 관례(el/field/textInput, robot-button 버튼)를 그대로 따른다.
// 원래 설정 탭에 있었지만 "켜고 끄는" 것은 그 화면에 두기로 해서(IA 2차 5단계) 시뮬레이션 화면으로 옮겼다.
import { getSimWorlds, getSimConfig, startSim, stopSim, getSimStatus } from './simControlApi.js';

const MAX_ROBOTS = 2;
const POLL_MS = 4000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function field(label, input) {
  const wrap = el('label', 'robot-field');
  wrap.appendChild(el('span', 'robot-field-label', label));
  wrap.appendChild(input);
  return wrap;
}
function textInput(value, placeholder = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'robot-input';
  input.value = value ?? '';
  input.placeholder = placeholder;
  return input;
}

/**
 * @param {HTMLElement} containerEl
 * @param {{ projectId: string, projectName: string }} opts
 */
export function createSimControlCard(containerEl, { projectId, projectName }) {
  containerEl.className = 'robot-form-panel settings-panel';
  containerEl.appendChild(el('div', 'robot-form-title', '시뮬레이터'));
  containerEl.appendChild(
    el(
      'div',
      'robot-form-status',
      '이 현장의 시뮬레이터를 여기서 켜고 끕니다. 다른 현장과 동시에 띄울 수 있고(포트는 자동 배정), docker compose(개발용, deploy/docker-compose.site.dev.yml)를 대신 실행합니다.'
    )
  );

  const statusLine = el('div', 'fleet-broker-status', '상태 확인 중...');
  containerEl.appendChild(statusLine);

  const worldSelect = document.createElement('select');
  worldSelect.className = 'robot-input';
  containerEl.appendChild(field('월드', worldSelect));

  const worldNote = el(
    'div',
    'settings-service-desc',
    '월드 이름이 현재 현장 이름과 다르면, 그 로봇은 지도 위에 보이지 않습니다(현장별로 표시를 걸러내기 때문).'
  );
  containerEl.appendChild(worldNote);

  const robotsList = el('div', 'settings-services');
  containerEl.appendChild(robotsList);
  const addRobotBtn = el('button', 'robot-button', '+ 로봇 추가');
  containerEl.appendChild(addRobotBtn);

  const buttonRow = el('div', 'robot-button-row');
  const startBtn = el('button', 'robot-button robot-button-primary', '저장하고 시작');
  const stopBtn = el('button', 'robot-button', '정지');
  buttonRow.append(startBtn, stopBtn);
  containerEl.appendChild(buttonRow);

  const formStatus = el('div', 'robot-form-status');
  containerEl.appendChild(formStatus);

  let rows = []; // { rowEl, idInput, spawnInput }

  function renderAddButton() {
    addRobotBtn.disabled = rows.length >= MAX_ROBOTS;
    addRobotBtn.title = rows.length >= MAX_ROBOTS ? `최대 ${MAX_ROBOTS}대까지입니다 (sim-driver 슬롯 상한)` : '';
  }

  function addRow(id = '', spawn = 'auto') {
    if (rows.length >= MAX_ROBOTS) return;
    const idInput = textInput(id, `tb3-sim-0${rows.length + 1}`);
    const spawnInput = textInput(spawn, 'auto 또는 x,y,theta');
    const removeBtn = el('button', 'robot-button', '삭제');
    const rowEl = el('div', 'fleet-id-row');
    rowEl.append(field('로봇 id', idInput), field('spawn', spawnInput), removeBtn);
    removeBtn.addEventListener('click', () => {
      rows = rows.filter((r) => r.rowEl !== rowEl);
      rowEl.remove();
      renderAddButton();
    });
    robotsList.appendChild(rowEl);
    rows.push({ rowEl, idInput, spawnInput });
    renderAddButton();
  }
  addRobotBtn.addEventListener('click', () => addRow());

  function setFormStatus(text, isError = false) {
    formStatus.textContent = text;
    formStatus.style.color = isError ? '#c0392b' : '#888';
  }

  function readRobots() {
    return rows.map((r) => ({ id: r.idInput.value.trim(), spawn: r.spawnInput.value.trim() || 'auto' })).filter((r) => r.id);
  }

  async function loadWorlds(selected) {
    worldSelect.replaceChildren();
    try {
      const { worlds } = await getSimWorlds();
      for (const w of worlds) worldSelect.appendChild(new Option(w, w));
      const preferred = selected ?? worlds.find((w) => w.startsWith(`${projectName}.`)) ?? worlds[0];
      if (preferred) worldSelect.value = preferred;
    } catch (err) {
      setFormStatus(`월드 목록을 읽지 못했습니다 -- ${err.message}`, true);
    }
  }

  async function loadConfig() {
    try {
      const { world, robots } = await getSimConfig(projectId);
      await loadWorlds(world);
      robotsList.replaceChildren();
      rows = [];
      for (const r of robots ?? []) addRow(r.id, r.spawn);
    } catch (err) {
      await loadWorlds();
      setFormStatus(`설정을 읽지 못했습니다 -- ${err.message}`, true);
    }
  }

  function renderStatus(status) {
    const running = status?.simulator === 'running';
    stopBtn.disabled = !running;
    if (!running) {
      statusLine.textContent = '중지됨';
      statusLine.style.color = '#888';
      return;
    }
    const names = rows.filter((_, i) => status[`driver${i + 1}`] === 'running').map((r) => r.idInput.value);
    const viewer = status.ports?.viewer;
    statusLine.textContent = `실행 중 · ${worldSelect.value}${names.length ? ` · ${names.join(', ')}` : ''}${viewer ? ` · 뷰어 :${viewer}` : ''}`;
    statusLine.style.color = '#2a7d2a';
  }

  async function pollStatus() {
    try {
      renderStatus(await getSimStatus(projectId));
    } catch {
      /* 폴링 실패는 조용히 무시 -- 다음 tick 에 다시 시도 */
    }
  }

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    setFormStatus('저장하고 시작하는 중... (컨테이너 재기동, 몇 초 걸릴 수 있습니다)');
    try {
      const world = worldSelect.value;
      const robots = readRobots();
      const res = await startSim(projectId, world, robots);
      setFormStatus(`시작됨 -- ${res.world} · ${res.robots.map((r) => r.id).join(', ') || '(로봇 없음)'} · 뷰어 :${res.ports.viewer}`);
      await pollStatus();
    } catch (err) {
      setFormStatus(`시작 실패 -- ${err.message}`, true);
    } finally {
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    setFormStatus('정지하는 중...');
    try {
      await stopSim(projectId);
      setFormStatus('정지됨.');
      await pollStatus();
    } catch (err) {
      setFormStatus(`정지 실패 -- ${err.message}`, true);
    } finally {
      stopBtn.disabled = false;
    }
  });

  loadConfig().then(pollStatus);
  const timer = setInterval(pollStatus, POLL_MS);

  return { destroy() { clearInterval(timer); } };
}
