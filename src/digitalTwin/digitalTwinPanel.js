// 지도 › "3D 텍스처" -- dc-vps-digital-twin(SuGaR) 결과를 읽기 전용으로 보여준다. 학습 자체는 트리거하지
// 않는다(WSL에서 수동으로 이미 끝난 학습 결과만 대상). server/digitalTwin.mjs 참고.
// 결과 폴더는 scan-engine의 스캔/그룹 id와 연결되는 명명 규칙이 없어서(사람이 CLI로 손수 지은 이름),
// alignWorkspace.js의 그룹 선택 드롭다운과 같은 방식으로 목록을 그대로 보여주고 사람이 고른다.
import { listDigitalTwinResults, generateDigitalTwinViewer, getDigitalTwinGenerateStatus, digitalTwinViewerUrl } from './digitalTwinApi.js';

const POLL_MS = 2500;

/** @param {HTMLElement} rootEl */
export function createDigitalTwinPanel(rootEl) {
  rootEl.classList.add('dt-panel');
  rootEl.innerHTML = `
    <aside class="align-ws__rail">
      <section class="align-ws__section">
        <div class="align-ws__title">3D 텍스처 결과</div>
        <div class="align-ws__row">
          <select id="dt-select" class="pathfinding-select"></select>
        </div>
        <div id="dt-note" class="align-ws__note">불러오는 중…</div>
        <button id="dt-generate" class="robot-button robot-button-primary" hidden>이 결과의 뷰어 만들기</button>
      </section>
    </aside>
    <div class="dt-panel__view">
      <iframe id="dt-frame" class="dt-panel__frame" title="3D 텍스처 뷰어" hidden></iframe>
      <div id="dt-empty" class="align-ws__note dt-panel__empty">결과를 선택하세요.</div>
    </div>
  `;
  const $ = (id) => rootEl.querySelector(`#${id}`);

  let results = [];
  let pollTimer = null;

  function fmtMB(bytes) {
    return `${(bytes / 1e6).toFixed(0)}MB`;
  }

  function selected() {
    return results.find((r) => r.name === $('dt-select').value) ?? null;
  }

  function renderFrame() {
    clearInterval(pollTimer);
    pollTimer = null;
    const r = selected();
    const frame = $('dt-frame'), empty = $('dt-empty'), genBtn = $('dt-generate'), note = $('dt-note');
    genBtn.disabled = false;
    if (!r) {
      frame.hidden = true; empty.hidden = false; genBtn.hidden = true;
      note.textContent = '';
      return;
    }
    if (r.hasViewer) {
      frame.src = `${digitalTwinViewerUrl(r.name)}?t=${Date.now()}`;
      frame.hidden = false; empty.hidden = true; genBtn.hidden = true;
      note.textContent = `${r.name} · ${fmtMB(r.sizeBytes)}`;
    } else if (r.hasSource) {
      frame.hidden = true; empty.hidden = true; genBtn.hidden = false;
      note.textContent = `${r.name} · 원본만 있음(${fmtMB(r.sizeBytes)}) -- 아래 버튼으로 뷰어를 만드세요.`;
    } else {
      frame.hidden = true; empty.hidden = false; genBtn.hidden = true;
      note.textContent = `${r.name}: 원본(.obj/.png)도 없습니다.`;
    }
  }

  async function refresh() {
    const prevValue = $('dt-select').value;
    try {
      const { results: list } = await listDigitalTwinResults();
      results = list;
      const sel = $('dt-select');
      sel.replaceChildren();
      if (!results.length) {
        $('dt-note').textContent = '결과가 없습니다.';
        renderFrame();
        return;
      }
      for (const r of results) {
        const opt = document.createElement('option');
        opt.value = r.name;
        opt.textContent = `${r.name}${r.hasViewer ? '' : r.hasSource ? ' (원본만)' : ' (없음)'}`;
        sel.appendChild(opt);
      }
      if (results.some((r) => r.name === prevValue)) sel.value = prevValue;
      renderFrame();
    } catch (err) {
      $('dt-note').textContent = `목록을 불러오지 못했습니다: ${err.message}`;
    }
  }

  $('dt-select').addEventListener('change', renderFrame);
  $('dt-generate').addEventListener('click', async () => {
    const r = selected();
    if (!r) return;
    const btn = $('dt-generate'), note = $('dt-note');
    btn.disabled = true;
    note.textContent = `${r.name}: 뷰어 만드는 중… (원본 크기에 따라 수십 초~몇 분)`;
    try {
      await generateDigitalTwinViewer(r.name);
      pollTimer = setInterval(async () => {
        try {
          const s = await getDigitalTwinGenerateStatus(r.name);
          if (s.status === 'done') {
            await refresh();
          } else if (s.status === 'error') {
            clearInterval(pollTimer);
            pollTimer = null;
            note.textContent = `생성 실패: ${s.error ?? '알 수 없는 오류'}`;
            btn.disabled = false;
          }
        } catch { /* 폴링 한 번 실패는 무시, 다음 tick 재시도 */ }
      }, POLL_MS);
    } catch (err) {
      note.textContent = `생성 실패: ${err.message}`;
      btn.disabled = false;
    }
  });

  /** 목록을 다시 읽고 name 결과를 고른다 -- 학습 완료 토스트의 "보기"에서 쓴다. */
  async function select(name) {
    await refresh();
    if (results.some((r) => r.name === name)) {
      $('dt-select').value = name;
      renderFrame();
    }
  }

  refresh();
  return { refresh, select, destroy() { clearInterval(pollTimer); } };
}
