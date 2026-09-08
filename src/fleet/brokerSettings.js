// 설정 › VDA5050 브로커 -- 브로커 URL·토픽 접두사·구독 목록을 저장하면 서버
// (server/vda5050.mjs)가 즉시 재접속한다. 플릿 탭(M1 이전)의 왼쪽 폼을 그대로
// 옮긴 것. 로봇 표는 운영 화면의 fleetBoard.js로 갔다. doc/vda5050-rcs.md.
import { getFleetConfig, putFleetConfig, subscribeFleetStream } from './fleetApi.js';
import { createSimControlCard } from '../simulation/simControlCard.js';
import { createVpsStatusCard } from './vpsStatusCard.js';
import { activeProjectId, activeProjectName } from '../appShared.js';
import { DEFAULT_SERVICES } from '../servicesConfig.js';

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

function subscriptionsToText(subs) {
  return (subs ?? []).map((s) => `${s.manufacturer}/${s.serialNumber}`).join('\n');
}
function textToSubscriptions(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [manufacturer = '+', serialNumber = '+'] = line.split('/');
      return { manufacturer: manufacturer.trim() || '+', serialNumber: serialNumber.trim() || '+' };
    });
}

export function createBrokerSettings(containerEl) {
  containerEl.classList.add('robot-registry');
  const layout = el('div', 'robot-layout');
  containerEl.appendChild(layout);

  const form = el('div', 'robot-form-panel settings-panel');
  form.appendChild(el('div', 'robot-form-title', 'VDA5050 브로커'));
  const statusLine = el('div', 'fleet-broker-status', '상태 확인 중...');
  form.appendChild(statusLine);

  const enabledWrap = el('label', 'fleet-check');
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  enabledWrap.append(enabledInput, document.createTextNode(' 브로커에 연결'));
  form.appendChild(enabledWrap);

  const brokerInput = textInput('', 'mqtt://127.0.0.1:1883');
  form.appendChild(field('브로커 URL (mqtt:// 또는 ws://)', brokerInput));
  const ifaceInput = textInput('uagv');
  const versionInput = textInput('v2');
  const manufacturerInput = textInput('dcrobot');
  const idRow = el('div', 'fleet-id-row');
  idRow.append(field('interfaceName', ifaceInput), field('majorVersion', versionInput));
  form.appendChild(idRow);
  form.appendChild(field('RCS manufacturer (발행 헤더)', manufacturerInput));
  const subsInput = document.createElement('textarea');
  subsInput.className = 'robot-input';
  subsInput.rows = 3;
  subsInput.placeholder = '+/+\ndcrobot/tb3-sim-01';
  form.appendChild(field('구독 (한 줄에 manufacturer/serialNumber, + = 전체)', subsInput));
  const staleInput = textInput('5000');
  form.appendChild(field('오래됨 판정 (ms)', staleInput));

  const buttonRow = el('div', 'robot-button-row');
  const saveBtn = el('button', 'robot-button robot-button-primary', '저장하고 연결');
  const reloadBtn = el('button', 'robot-button', '다시 읽기');
  buttonRow.append(saveBtn, reloadBtn);
  form.appendChild(buttonRow);
  const formStatus = el('div', 'robot-form-status');
  form.appendChild(formStatus);
  layout.appendChild(form);

  // 서비스 주소 -- 서버(data/settings.json)에 저장, localStorage 는 캐시. 다른 PC 에서 열어도 같은 값.
  const info = el('div', 'robot-form-panel settings-panel');
  info.appendChild(el('div', 'robot-form-title', '서비스 주소'));
  info.appendChild(el('div', 'robot-form-status', '현장 공통 설정입니다. 이 값은 서버에 저장되고 모든 브라우저가 같은 주소를 씁니다.'));

  let savedServices = { ...DEFAULT_SERVICES };
  try {
    const raw = localStorage.getItem('pathfinder_services_endpoints');
    if (raw) savedServices = { ...DEFAULT_SERVICES, ...JSON.parse(raw) };
  } catch {}

  const inputs = {
    simViewer: textInput(savedServices.simViewer, DEFAULT_SERVICES.simViewer),
    studio: textInput(savedServices.studio, DEFAULT_SERVICES.studio),
    scanEngine: textInput(savedServices.scanEngine, DEFAULT_SERVICES.scanEngine),
    navBrain: textInput(savedServices.navBrain, DEFAULT_SERVICES.navBrain),
    vpsServer: textInput(savedServices.vpsServer, DEFAULT_SERVICES.vpsServer),
  };
  const links = {};
  function serviceRow(key, label, desc) {
    const input = inputs[key];
    const wrap = el('div', 'settings-service-row');
    const header = el('div', 'settings-service-header');
    header.appendChild(el('b', '', label));
    const link = el('a', 'settings-service-link', '열기 ↗');
    link.target = '_blank'; link.rel = 'noopener'; link.href = input.value || '#';
    input.addEventListener('input', () => { link.href = input.value || '#'; });
    links[key] = link;
    header.appendChild(link);
    wrap.append(header, input);
    if (desc) wrap.appendChild(el('span', 'settings-service-desc', desc));
    return wrap;
  }
  const sList = el('div', 'settings-services');
  sList.appendChild(serviceRow('simViewer', '시뮬레이터 뷰어', '시뮬레이션 화면의 3D 뷰어 · 월드 · 로봇 스트림'));
  sList.appendChild(serviceRow('scanEngine', '스캔 엔진', '스캔 처리 · 정합 · 슬라이스맵 (FastAPI)'));
  sList.appendChild(serviceRow('studio', '정합 페이지 (원본)', '스캔 엔진이 만드는 독립 정합 페이지 -- 디버그용'));
  sList.appendChild(serviceRow('navBrain', '로봇 대시보드 (nav.html)', '실기 로봇의 브라우저 두뇌'));
  sList.appendChild(serviceRow('vpsServer', 'VPS 서버', '위치 보정 (/localize)'));

  const saveServicesBtn = el('button', 'robot-button robot-button-primary', '서비스 주소 저장');
  const serviceStatus = el('div', 'robot-form-status');
  function applyServices(data) {
    for (const [k, input] of Object.entries(inputs)) { input.value = data[k] ?? DEFAULT_SERVICES[k]; if (links[k]) links[k].href = input.value; }
    try { localStorage.setItem('pathfinder_services_endpoints', JSON.stringify(data)); } catch {}
  }
  fetch('/api/settings/services').then((r) => (r.ok ? r.json() : null)).then((res) => { if (res?.services) applyServices(res.services); }).catch(() => {});
  saveServicesBtn.addEventListener('click', async () => {
    const data = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim() || DEFAULT_SERVICES[k]]));
    saveServicesBtn.disabled = true;
    try {
      const r = await fetch('/api/settings/services', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ services: data }) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
      applyServices(res.services ?? data);
      serviceStatus.textContent = '서버에 저장되었습니다. 모든 브라우저에 적용됩니다.';
      serviceStatus.style.color = '#34d399';
      setTimeout(() => { serviceStatus.textContent = ''; }, 3000);
    } catch (e) {
      serviceStatus.textContent = `저장 실패: ${e.message}`;
      serviceStatus.style.color = '#ef4444';
    } finally { saveServicesBtn.disabled = false; }
  });
  info.append(sList, saveServicesBtn, serviceStatus);
  layout.appendChild(info);

  // 좌표 규약 -- 화면마다 흩어져 있던 설명을 한 카드에
  const conv = el('div', 'robot-form-panel settings-panel');
  conv.appendChild(el('div', 'robot-form-title', '좌표 규약'));
  const convList = el('div', 'settings-services');
  for (const [k, v] of [
    ['현장 평면', 'm 단위, 원점 (0,0) = 합성 슬라이스맵 격자의 왼쪽-아래. +x 오른쪽, +y 위(북).'],
    ['슬라이스맵 → 스캔', '평면 (x, y) = (x_arkit, −z_arkit). 스캔은 yaw 만큼 CCW 회전 후 (offsetX, −offsetZ) 이동.'],
    ['시뮬레이터 월드', '같은 슬라이스맵 파일을 월드로 읽는다 → 좌표 변환 없음. 벽/가구 kind 는 셀 코드 3/2.'],
    ['VDA5050', 'mapId = 현장 이름, theta 라디안 CCW+, 노드 도달 반경 0.35 m, startPause = 일시정지 · stopPause = 재개.'],
    ['3D', 'three.js (X, Y, Z) = (x, 높이, −y). 스캔 메시는 스튜디오 Z-up 을 −90° 회전, 바닥 밴드를 0 으로.'],
  ]) {
    const row = el('div', 'settings-service-row');
    const h = el('div', 'settings-service-header'); h.appendChild(el('b', '', k)); row.appendChild(h);
    row.appendChild(el('span', 'settings-service-desc', v));
    convList.appendChild(row);
  }
  conv.appendChild(convList);
  layout.appendChild(conv);

  // 도구 -- 임베드 밖의 원본 화면·문서로 가는 링크 (주소는 위 서비스 주소를 따른다)
  const tools = el('div', 'robot-form-panel settings-panel');
  tools.appendChild(el('div', 'robot-form-title', '도구 · 링크'));
  const toolList = el('div', 'settings-services');
  const toolLink = (label, hrefFn, desc) => {
    const row = el('div', 'settings-service-row');
    const h = el('div', 'settings-service-header'); h.appendChild(el('b', '', label));
    const a = el('a', 'settings-service-link', '열기 ↗'); a.target = '_blank'; a.rel = 'noopener'; a.href = hrefFn();
    h.appendChild(a); row.append(h, el('span', 'settings-service-desc', desc));
    for (const input of Object.values(inputs)) input.addEventListener('input', () => { a.href = hrefFn(); });
    return row;
  };
  toolList.appendChild(toolLink('시뮬레이터 3D 뷰어 (전체 화면)', () => `${inputs.simViewer.value}/?view=3d`, 'GT · LIDAR · 시점 전환 · 키보드 조종'));
  toolList.appendChild(toolLink('정합 페이지 (원본)', () => inputs.studio.value, '스캔 엔진의 독립 정합 워크스페이스'));
  toolList.appendChild(toolLink('스캔 엔진 API 문서', () => `${inputs.scanEngine.value}/docs`, 'FastAPI OpenAPI (Swagger UI)'));
  toolList.appendChild(toolLink('로봇 대시보드 (nav.html)', () => inputs.navBrain.value, '실기 로봇 두뇌 · VDA5050 연결 · VPS 보정'));
  tools.appendChild(toolList);
  layout.appendChild(tools);

  // 시뮬레이터 -- 이 현장의 월드 · 로봇 구성을 켜고 끈다 (server/simControl.mjs, docker compose 실행).
  const simCard = el('div');
  const simControl = createSimControlCard(simCard, { projectId: activeProjectId, projectName: activeProjectName });
  layout.appendChild(simCard);

  // VPS 서버 -- 위 서비스 주소의 vpsServer가 가리키는 곳에 등록된 room(위치 보정용 스캔) 목록.
  const vpsCard = el('div');
  const vpsControl = createVpsStatusCard(vpsCard);
  layout.appendChild(vpsCard);

  let config = null;
  let brokerStatus = { connected: false, brokerUrl: null, error: null };

  function setFormStatus(text, isError = false) {
    formStatus.textContent = text;
    formStatus.style.color = isError ? '#c0392b' : '#888';
  }
  function renderBrokerStatus() {
    if (!config?.enabled) {
      statusLine.textContent = '비활성 (설정 후 "저장하고 연결")';
      statusLine.style.color = '#888';
    } else if (brokerStatus.connected) {
      statusLine.textContent = `연결됨 · ${brokerStatus.brokerUrl}`;
      statusLine.style.color = '#2a7d2a';
    } else {
      statusLine.textContent = brokerStatus.error ? `연결 실패: ${brokerStatus.error}` : '연결 중...';
      statusLine.style.color = '#c0392b';
    }
  }
  function fillForm() {
    if (!config) return;
    enabledInput.checked = config.enabled;
    brokerInput.value = config.brokerUrl;
    ifaceInput.value = config.interfaceName;
    versionInput.value = config.majorVersion;
    manufacturerInput.value = config.manufacturer;
    subsInput.value = subscriptionsToText(config.subscriptions);
    staleInput.value = String(config.staleAfterMs);
  }
  function readForm() {
    return {
      enabled: enabledInput.checked,
      brokerUrl: brokerInput.value.trim(),
      interfaceName: ifaceInput.value.trim(),
      majorVersion: versionInput.value.trim(),
      manufacturer: manufacturerInput.value.trim(),
      subscriptions: textToSubscriptions(subsInput.value),
      staleAfterMs: Number(staleInput.value),
    };
  }
  async function loadConfig() {
    try {
      const data = await getFleetConfig();
      config = data.config;
      brokerStatus = data.status;
      fillForm();
      renderBrokerStatus();
      setFormStatus('');
    } catch (err) {
      setFormStatus(`설정을 읽지 못했습니다 — ${err.message}`, true);
    }
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setFormStatus('저장 중...');
    try {
      const data = await putFleetConfig(readForm());
      config = data.config;
      brokerStatus = data.status;
      fillForm();
      renderBrokerStatus();
      setFormStatus(config.enabled ? '저장됨. 브로커에 연결을 시도합니다.' : '저장됨 (비활성).');
    } catch (err) {
      setFormStatus(`저장 실패 — ${err.message}`, true);
    } finally {
      saveBtn.disabled = false;
    }
  });
  reloadBtn.addEventListener('click', loadConfig);

  const stream = subscribeFleetStream((msg) => {
    if (msg.type === 'snapshot' || msg.type === 'status') {
      brokerStatus = msg.status;
      renderBrokerStatus();
    }
  });
  loadConfig();

  return { destroy() { stream.close(); simControl.destroy(); vpsControl.destroy(); } };
}
