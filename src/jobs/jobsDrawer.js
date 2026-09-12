// 작업 드로어 -- 상단 바 "작업 N" 배지를 누르면 오른쪽에서 열린다 (IA 2차 4단계).
// 1분 넘게 걸리는 일(3D 텍스처 학습 1~4시간, VPS room 빌드)은 시작한 화면의 인라인 텍스트로만 끝내지 않고
// 여기 한 목록에 나온다: 어느 화면에 있든 진행 · 실패 · 결과를 볼 수 있게. 원본은 서버다 --
// 학습은 GET /api/digital-twin/train, VPS 는 GET /api/vps/rooms. 이 파일은 읽기만 하고(삭제 제외) 상태를 안 만든다.
// 껍데기는 로봇 상세 드로어(robots/robotDrawer.js)와 같은 .s2m-drawer, 행은 운영의 주문 카드(.s2m-order).
import { listTrainingJobs } from '../digitalTwin/digitalTwinTrainingApi.js';
import { listDigitalTwinGenerations } from '../digitalTwin/digitalTwinApi.js';
import { getVpsHealth, listVpsRooms, deleteVpsRoom, listVpsJobs } from '../fleet/vpsApi.js';

const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const POLL_OPEN_MS = 5000;   // 드로어가 열려 있을 때
const POLL_BADGE_MS = 15000; // 닫혀 있어도 배지 숫자는 맞춰 둔다
const STAGE_ORDER = ['colmap_running', 'waiting_gpu', 'training_running', 'finalizing', 'done'];
const OPTION_LABEL = { low: '저해상도', high: '고해상도', short: '짧게', medium: '보통', long: '길게' };

function fmtElapsed(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');

/**
 * @param {{ onOpenResult: (name: string) => void }} handlers 완료된 학습 결과를 3D › 텍스처에서 여는 콜백
 */
export function createJobsDrawer({ onOpenResult }) {
  const overlay = el('div', 's2m-drawer-overlay');
  overlay.hidden = true;
  const drawer = el('aside', 's2m-drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-labelledby', 'jobs-drawer-title');
  drawer.innerHTML = `
    <div class="s2m-drawer__head">
      <div><div id="jobs-drawer-title" class="s2m-drawer__title">작업</div><div class="s2m-drawer__sub" data-sec="sub">불러오는 중…</div></div>
      <button class="robot-button" data-act="close" aria-label="닫기">닫기</button>
    </div>
    <div class="s2m-drawer__body">
      <section class="s2m-drawer__section">
        <div class="align-ws__title">3D 텍스처 학습 <span class="align-ws__count" data-sec="trainCount"></span></div>
        <div class="align-ws__note">정합 워크스페이스의 스캔 행 ⋯ 메뉴에서 시작합니다. COLMAP 정제 → GPU 학습 → 뷰어 생성, 서버 재시작에도 이어집니다.</div>
        <div class="s2m-side__list" data-sec="train"></div>
      </section>
      <section class="s2m-drawer__section">
        <div class="align-ws__title">뷰어 생성 <span class="align-ws__count" data-sec="gensCount"></span></div>
        <div class="align-ws__note">3D › 텍스처의 "이 결과의 뷰어 만들기". 학습 끝에 자동으로 만든 것은 학습 항목에 포함됩니다.</div>
        <div class="s2m-side__list" data-sec="gens"></div>
      </section>
      <section class="s2m-drawer__section">
        <div class="align-ws__title">VPS 빌드 <span class="align-ws__count" data-sec="vpsJobsCount"></span></div>
        <div class="align-ws__note">정합의 스캔 행 ⋯ 메뉴 › "VPS에 등록"으로 올린 스캔. 서버가 끝날 때까지 대신 지켜봅니다.</div>
        <div class="s2m-side__list" data-sec="vpsJobs"></div>
      </section>
      <section class="s2m-drawer__section">
        <div class="align-ws__title">VPS room <span class="align-ws__count" data-sec="vpsCount"></span></div>
        <div class="align-ws__note" data-sec="vpsStatus">상태 확인 중…</div>
        <div class="s2m-side__list" data-sec="vps"></div>
      </section>
    </div>`;
  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
  const $ = (sec) => drawer.querySelector(`[data-sec="${sec}"]`);

  let jobs = [];
  let runningCount = 0;
  const countListeners = new Set();
  const setRunning = (n) => { if (n !== runningCount) { runningCount = n; for (const cb of countListeners) cb(n); } };

  function jobTone(job) {
    if (job.phase === 'error') return 'danger';
    if (job.phase === 'done') return 'finished';
    return 'driving';
  }
  function jobStatusText(job) {
    if (job.phase === 'error') return '오류';
    if (job.phase === 'done') return '완료';
    return job.stageLabel ?? job.stage;
  }

  function renderJobs() {
    const list = $('train');
    list.replaceChildren();
    $('trainCount').textContent = jobs.length ? String(jobs.length) : '';
    if (!jobs.length) {
      list.appendChild(el('div', 'align-ws__note', '아직 학습한 적이 없습니다.'));
      return;
    }
    for (const job of jobs) {
      const card = el('div', `s2m-order jobs-job jobs-job--${job.phase}`);
      const top = el('div', 's2m-order__top');
      top.append(el('span', 's2m-order__robot', job.scanId), el('span', `s2m-chip s2m-chip--${jobTone(job)}`, jobStatusText(job)));
      card.appendChild(top);
      const opt = job.options ? `${OPTION_LABEL[job.options.polyMode] ?? job.options.polyMode} · ${OPTION_LABEL[job.options.refinementTime] ?? job.options.refinementTime}` : '';
      const q = job.queuePosition ? ` · GPU 대기 ${job.queuePosition}번째` : '';
      card.appendChild(el('div', 's2m-order__meta', `${fmtTime(job.startedAt)} 시작 · ${fmtElapsed(job.elapsedMs)}${job.phase === 'running' ? ' 경과' : ' 소요'} · ${opt}${q}`));
      if (job.phase === 'running') {
        const idx = Math.max(0, STAGE_ORDER.indexOf(job.stage));
        const bar = el('div', 's2m-order__bar');
        const fill = el('div', 's2m-order__fill');
        fill.style.width = `${Math.round(((idx + 0.5) / STAGE_ORDER.length) * 100)}%`;
        bar.appendChild(fill);
        card.appendChild(bar);
        const last = (job.log ?? []).filter((l) => l && !l.startsWith('##')).at(-1);
        if (last) card.appendChild(el('div', 's2m-order__meta jobs-job__log', last));
      } else if (job.phase === 'error') {
        card.appendChild(el('div', 's2m-order__meta s2m-order__meta--danger', job.error ?? '알 수 없는 오류'));
      } else {
        const btn = el('button', 'robot-button robot-button-primary jobs-job__open', '3D에서 보기');
        btn.type = 'button';
        btn.addEventListener('click', () => { close(); onOpenResult(job.name); });
        card.appendChild(btn);
      }
      list.appendChild(card);
    }
  }

  // ---- 뷰어 생성 (digitalTwin.mjs 의 generating Map, 이 서버 프로세스 동안만) ----
  let gens = [];
  const GEN_TONE = { running: 'driving', done: 'finished', error: 'danger' };
  const GEN_LABEL = { running: '만드는 중', done: '완료', error: '오류' };
  function renderGens() {
    const list = $('gens');
    list.replaceChildren();
    $('gensCount').textContent = gens.length ? String(gens.length) : '';
    if (!gens.length) { list.appendChild(el('div', 'align-ws__note', '서버가 뜬 뒤 손수 만든 뷰어가 없습니다.')); return; }
    for (const g of gens) {
      const card = el('div', 's2m-order');
      const top = el('div', 's2m-order__top');
      top.append(el('span', 's2m-order__robot', g.name), el('span', `s2m-chip s2m-chip--${GEN_TONE[g.status] ?? ''}`, GEN_LABEL[g.status] ?? g.status));
      card.appendChild(top);
      const elapsed = g.startedAt ? fmtElapsed((g.finishedAt ? new Date(g.finishedAt) : new Date()) - new Date(g.startedAt)) : '-';
      card.appendChild(el('div', 's2m-order__meta', `${fmtTime(g.startedAt)} 시작 · ${elapsed}${g.status === 'running' ? ' 경과' : ' 소요'}`));
      if (g.status === 'error') card.appendChild(el('div', 's2m-order__meta s2m-order__meta--danger', g.error ?? '알 수 없는 오류'));
      if (g.status === 'done') {
        const btn = el('button', 'robot-button robot-button-primary jobs-job__open', '3D에서 보기');
        btn.type = 'button';
        btn.addEventListener('click', () => { close(); onOpenResult(g.name); });
        card.appendChild(btn);
      }
      list.appendChild(card);
    }
  }

  // ---- VPS 빌드 (vps.mjs 가 넘긴 업로드를 끝날 때까지 대신 폴링한 목록) ----
  let vpsJobs = [];
  const VPS_LABEL = { queued: '대기', unzipping: '압축 푸는 중', building: '특징 DB 만드는 중', registering: 'room 등록 중', done: '완료', failed: '실패' };
  const vpsTone = (s) => (s === 'done' ? 'finished' : s === 'failed' ? 'danger' : 'driving');
  const vpsRunning = (s) => s !== 'done' && s !== 'failed';
  function renderVpsJobs() {
    const list = $('vpsJobs');
    list.replaceChildren();
    $('vpsJobsCount').textContent = vpsJobs.length ? String(vpsJobs.length) : '';
    if (!vpsJobs.length) { list.appendChild(el('div', 'align-ws__note', '서버가 뜬 뒤 올린 빌드가 없습니다.')); return; }
    for (const j of vpsJobs) {
      const card = el('div', 's2m-order');
      const top = el('div', 's2m-order__top');
      top.append(el('span', 's2m-order__robot', j.scanName), el('span', `s2m-chip s2m-chip--${vpsTone(j.status)}`, VPS_LABEL[j.status] ?? j.status));
      card.appendChild(top);
      const elapsed = fmtElapsed((j.finishedAt ? new Date(j.finishedAt) : new Date()) - new Date(j.startedAt));
      card.appendChild(el('div', 's2m-order__meta', `${fmtTime(j.startedAt)} 시작 · ${elapsed}${vpsRunning(j.status) ? ' 경과' : ' 소요'}${j.replace ? ' · 기존 room 덮어씀' : ''}${j.roomId ? ` · room ${j.roomId}` : ''}`));
      if (j.status === 'failed') card.appendChild(el('div', 's2m-order__meta s2m-order__meta--danger', j.error ?? '알 수 없는 오류'));
      list.appendChild(card);
    }
  }

  async function refreshJobs() {
    const [train, vps, gen] = await Promise.allSettled([listTrainingJobs(), listVpsJobs(), listDigitalTwinGenerations()]);
    if (train.status === 'fulfilled') jobs = train.value.jobs;
    if (vps.status === 'fulfilled') vpsJobs = vps.value.jobs;
    if (gen.status === 'fulfilled') gens = gen.value.generations;
    setRunning(
      jobs.filter((j) => j.phase === 'running').length +
      vpsJobs.filter((j) => vpsRunning(j.status)).length +
      gens.filter((g) => g.status === 'running').length
    );
    if (overlay.hidden) return;
    renderJobs();
    renderVpsJobs();
    renderGens();
    const failed = [train, vps, gen].filter((r) => r.status === 'rejected');
    $('sub').textContent = failed.length
      ? `목록 일부를 못 읽었습니다: ${failed.map((r) => r.reason?.message ?? r.reason).join(' · ')}`
      : runningCount ? `진행 중 ${runningCount}개` : '진행 중인 작업 없음';
  }

  function renderRooms(rooms, frames) {
    const list = $('vps');
    list.replaceChildren();
    $('vpsCount').textContent = rooms.length ? String(rooms.length) : '';
    if (!rooms.length) {
      list.appendChild(el('div', 'align-ws__note', '등록된 room이 없습니다. 정합 워크스페이스의 스캔 행 ⋯ 메뉴 › "VPS에 등록"으로 올립니다.'));
      return;
    }
    for (const r of rooms) {
      const card = el('div', 's2m-order');
      const top = el('div', 's2m-order__top');
      const delBtn = el('button', 'robot-button', '삭제');
      delBtn.type = 'button';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`'${r.room_id}' room을 VPS 서버에서 삭제할까요?`)) return;
        delBtn.disabled = true;
        try { await deleteVpsRoom(r.room_id); await refreshVps(); }
        catch (err) { $('vpsStatus').textContent = `삭제 실패: ${err.message}`; delBtn.disabled = false; }
      });
      top.append(el('span', 's2m-order__robot', r.room_id), delBtn);
      card.appendChild(top);
      const isRef = frames?.enabled && frames.reference === r.room_id;
      card.appendChild(el('div', 's2m-order__meta', `이미지 ${r.num_images}장${isRef ? ` · 그룹 '${frames.group}'의 기준 스캔` : ''}`));
      list.appendChild(card);
    }
  }

  async function refreshVps() {
    try {
      const health = await getVpsHealth();
      if (!health.ok) {
        $('vpsStatus').textContent = `VPS 서버 연결 안 됨${health.error ? ` -- ${health.error}` : ''} (설정 › 서비스 주소)`;
        renderRooms([], null);
        return;
      }
      const { rooms, frames } = await listVpsRooms();
      $('vpsStatus').textContent = `연결됨 · 위치 보정에 쓰는 스캔 목록`;
      renderRooms(rooms, frames);
    } catch (err) {
      $('vpsStatus').textContent = `VPS 서버 연결 안 됨 -- ${err.message}`;
    }
  }

  let openTimer = null;
  function open() {
    overlay.hidden = false;
    refreshJobs();
    refreshVps();
    clearInterval(openTimer);
    openTimer = setInterval(() => { refreshJobs(); refreshVps(); }, POLL_OPEN_MS);
  }
  function close() {
    overlay.hidden = true;
    clearInterval(openTimer);
    openTimer = null;
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  drawer.querySelector('[data-act="close"]').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (!overlay.hidden && e.key === 'Escape') close(); });

  refreshJobs();
  const badgeTimer = setInterval(refreshJobs, POLL_BADGE_MS);

  return {
    open,
    close,
    toggle() { if (overlay.hidden) open(); else close(); },
    refresh: refreshJobs,
    get runningCount() { return runningCount; },
    onCountChange(cb) { countListeners.add(cb); cb(runningCount); return () => countListeners.delete(cb); },
    destroy() { clearInterval(openTimer); clearInterval(badgeTimer); overlay.remove(); },
  };
}
