/**
 * scanWizardModal.js
 * Native Scan-to-Map Pipeline Wizard Modal for Fleet Studio.
 * Handles 3-step project setup, file uploads, and 7-step pipeline execution tracking.
 */

import { createScanProject, processScanProject, getScanProjectStatus } from './scanStudioApi.js';
import { createProject, createProjectFromSlicemap } from '../projects/projectApi.js';
import { setPendingAlignGroup } from './pendingAlignGroup.js';

const STEP_LABELS = [
  ['import', '1. 가져오기 (스캔 모델 파싱)'],
  ['preprocess', '2. 전처리 (천장 자동 제거)'],
  ['rasterize', '3. 래스터화 (점유 격자 생성)'],
  ['registration', '4. 정합 (로봇 지도 ICP 정합)'],
  ['classify', '5. 분류 (바닥 / 벽 / 가구)'],
  ['vectorize', '6. 벡터화 (GeoJSON 장애물 생성)'],
  ['viewer', '7. 리포트 & 뷰어 생성'],
];

let modalEl = null;
let currentStep = 1; // 1: 이름&스캔, 2: 로봇지도, 3: 옵션, 4: 파이프라인
let pollTimer = null;

// Form state
let state = {
  name: '',
  usdzFile: null,
  robotMapPgm: null,
  robotMapYaml: null,
  removeIsolatedClusters: false,
  classify: true,
  submitting: false,
  errorMsg: null,
  activeProjectName: '',
};

function defaultProjectName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `scan_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function initScanWizardModal() {
  if (document.getElementById('scan-wizard-overlay')) return;

  modalEl = document.createElement('div');
  modalEl.id = 'scan-wizard-overlay';
  modalEl.className = 'scan-wizard-overlay';
  modalEl.style.display = 'none';

  modalEl.innerHTML = `
    <div class="scan-wizard-modal" role="dialog" aria-labelledby="wizard-title">
      <div class="wizard-header">
        <div class="wizard-header-title">
          <span class="wizard-header-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg></span>
          <div>
            <h3 id="wizard-title">스캔 데이터 파이프라인 마법사</h3>
            <p class="wizard-header-sub">iPhone 스캔 패키지 (.zip) 또는 LiDAR 메시 (.usdz) → 2D 베이스맵 & 장애물 자동 추출</p>
          </div>
        </div>
        <button id="wizard-btn-close" class="wizard-close-btn" title="닫기">&times;</button>
      </div>

      <div class="wizard-steps-indicator" id="wizard-stepper">
        <div class="step-badge active" data-step="1">
          <span class="step-num">1</span>
          <span class="step-name">이름 & 스캔</span>
        </div>
        <div class="step-divider"></div>
        <div class="step-badge" data-step="2">
          <span class="step-num">2</span>
          <span class="step-name">로봇 지도 (선택)</span>
        </div>
        <div class="step-divider"></div>
        <div class="step-badge" data-step="3">
          <span class="step-num">3</span>
          <span class="step-name">처리 옵션</span>
        </div>
        <div class="step-divider"></div>
        <div class="step-badge" data-step="4">
          <span class="step-num">4</span>
          <span class="step-name">파이프라인 실행</span>
        </div>
      </div>

      <div class="wizard-body">
        <!-- STEP 1: 프로젝트 이름 & USDZ/ZIP 업로드 -->
        <div class="wizard-pane" id="wizard-pane-1">
          <label class="wizard-label" for="wizard-input-name">프로젝트 이름</label>
          <input type="text" id="wizard-input-name" class="wizard-input" placeholder="예: scan_office" />
          <p class="wizard-hint">저장소 및 정합 워크스페이스에서 구분할 프로젝트 식별자입니다.</p>

          <label class="wizard-label" style="margin-top: 16px;">스캔 데이터 파일 (.zip / .usdz / .ply)</label>
          <div class="wizard-dropzone" id="dropzone-usdz">
            <input type="file" id="file-usdz" accept=".zip,.usdz,.ply" style="display:none" />
            <div class="dropzone-icon">📦</div>
            <div class="dropzone-title"><b>스캔 파일 (.zip 또는 .usdz)</b> 드래그하거나 클릭하여 선택</div>
            <div class="dropzone-sub">💡 iPhone 앱 내보내기 <b>.zip</b> (바닥 도면 & 다중 스캔 포함, 권장) 또는 단일 <b>.usdz</b></div>
          </div>
          <div id="file-pill-usdz" class="file-pill" style="display: none;">
            <span class="file-pill-icon">📦</span>
            <span class="file-pill-name" id="pill-usdz-name">scan_package.zip</span>
            <span class="file-pill-size" id="pill-usdz-size">0 MB</span>
            <button type="button" class="file-pill-remove" id="btn-remove-usdz" title="제거">&times;</button>
          </div>
        </div>

        <!-- STEP 2: 로봇 SLAM 지도 업로드 (선택) -->
        <div class="wizard-pane" id="wizard-pane-2" style="display:none">
          <label class="wizard-label">로봇 SLAM 점유 격자 (선택 사항)</label>
          <p class="wizard-hint">Nav2 map_server 표준 포맷 (robot_map.pgm + robot_map.yaml). 업로드 시 베이스맵과 2D ICP 정합을 자동 수행합니다.</p>
          
          <div class="wizard-dropzone" id="dropzone-robot-map">
            <input type="file" id="file-robot-map" accept=".pgm,.yaml,.yml" multiple style="display:none" />
            <div class="dropzone-icon">🗺️</div>
            <div class="dropzone-title"><b>robot_map.pgm</b> 및 <b>.yaml</b> 드래그 또는 선택</div>
            <div class="dropzone-sub">두 파일을 함께 드래그하거나 각각 선택할 수 있습니다</div>
          </div>
          
          <div id="file-pill-pgm" class="file-pill" style="display: none;">
            <span class="file-pill-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></span>
            <span class="file-pill-name" id="pill-pgm-name">robot_map.pgm</span>
            <span class="file-pill-size" id="pill-pgm-size">0 KB</span>
            <button type="button" class="file-pill-remove" id="btn-remove-pgm" title="제거">&times;</button>
          </div>
          <div id="file-pill-yaml" class="file-pill" style="display: none;">
            <span class="file-pill-icon">⚙</span>
            <span class="file-pill-name" id="pill-yaml-name">robot_map.yaml</span>
            <span class="file-pill-size" id="pill-yaml-size">0 KB</span>
            <button type="button" class="file-pill-remove" id="btn-remove-yaml" title="제거">&times;</button>
          </div>

          <div class="wizard-skip-box">
            <button type="button" id="btn-skip-robot-map" class="wizard-link-btn">
              로봇 지도 없이 베이스맵만 생성하고 계속하기 →
            </button>
          </div>
        </div>

        <!-- STEP 3: 처리 옵션 -->
        <div class="wizard-pane" id="wizard-pane-3" style="display:none">
          <div class="wizard-option-row">
            <div>
              <div class="wizard-option-title">바닥 / 벽 / 가구 자동 분류 (Classification)</div>
              <div class="wizard-option-desc">천장 제거 후 점군을 바닥/벽/가구로 세그멘테이션하고 가구 폴리곤을 GeoJSON으로 추출합니다. (권장)</div>
            </div>
            <label class="wizard-switch">
              <input type="checkbox" id="chk-classify" checked />
              <span class="slider"></span>
            </label>
          </div>

          <div class="wizard-option-row">
            <div>
              <div class="wizard-option-title">이동 물체(고립 클러스터) 노이즈 제거</div>
              <div class="wizard-option-desc">사람이나 임시 장애물 등 작은 부유 클러스터를 자동 여과합니다.</div>
            </div>
            <label class="wizard-switch">
              <input type="checkbox" id="chk-remove-clusters" />
              <span class="slider"></span>
            </label>
          </div>

          <div id="wizard-error-msg" class="wizard-error-banner" style="display: none;"></div>
        </div>

        <!-- STEP 4: 파이프라인 진행 상태 (StepRail + LogConsole) -->
        <div class="wizard-pane" id="wizard-pane-4" style="display:none">
          <div class="pipeline-progress-header">
            <div class="pipeline-phase-pill" id="pipeline-status-badge">처리 대기 중…</div>
            <div class="pipeline-percent-text" id="pipeline-percent-text">0%</div>
          </div>
          
          <div class="pipeline-progress-bar-bg">
            <div class="pipeline-progress-bar-fill" id="pipeline-progress-bar" style="width: 0%"></div>
          </div>

          <div class="pipeline-rail-container" id="pipeline-step-rail">
            ${STEP_LABELS.map(([key, label]) => `
              <div class="rail-step pending" data-step-key="${key}">
                <span class="rail-step-dot"></span>
                <span class="rail-step-label">${label}</span>
                <span class="rail-step-status">대기 중</span>
              </div>
            `).join('')}
          </div>

          <label class="wizard-label" style="margin-top: 14px;">실시간 파이프라인 실행 로그</label>
          <div class="wizard-log-console" id="wizard-log-console">
            <div class="log-line info">파이프라인 연결 준비 완료...</div>
          </div>

          <div id="pipeline-completion-box" class="pipeline-completion-box" style="display: none;">
            <div class="completion-title">스캔 처리가 끝났습니다</div>
            <div class="completion-desc" id="pipeline-completion-desc">베이스맵 생성 및 GeoJSON 장애물 추출이 성공적으로 완료되었습니다.</div>
            <div class="completion-actions">
              <button type="button" id="btn-complete-create-project" class="wizard-btn wizard-btn-primary">
                이 스캔으로 현장 만들기
              </button>
              <button type="button" id="btn-complete-to-studio" class="wizard-btn wizard-btn-secondary">
                정합에서 확인
              </button>
              <button type="button" id="btn-complete-close" class="wizard-btn wizard-btn-secondary">
                닫기
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="wizard-footer" id="wizard-footer">
        <button type="button" id="wizard-btn-prev" class="wizard-btn wizard-btn-secondary" style="display: none;">← 이전</button>
        <div style="flex: 1"></div>
        <button type="button" id="wizard-btn-next" class="wizard-btn wizard-btn-primary">다음 단계 →</button>
      </div>
    </div>
  `;

  document.body.appendChild(modalEl);
  bindEvents();
}

function bindEvents() {
  const overlay = modalEl;
  const btnClose = overlay.querySelector('#wizard-btn-close');
  const btnPrev = overlay.querySelector('#wizard-btn-prev');
  const btnNext = overlay.querySelector('#wizard-btn-next');
  const nameInput = overlay.querySelector('#wizard-input-name');

  // Close handlers
  btnClose.addEventListener('click', closeScanWizardModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && currentStep !== 4) closeScanWizardModal();
  });

  // Name input
  nameInput.addEventListener('input', (e) => {
    state.name = e.target.value.trim();
    updateButtonStates();
  });

  // Dropzone USDZ
  const dropzoneUsdz = overlay.querySelector('#dropzone-usdz');
  const fileUsdz = overlay.querySelector('#file-usdz');
  dropzoneUsdz.addEventListener('click', () => fileUsdz.click());
  dropzoneUsdz.addEventListener('dragover', (e) => { e.preventDefault(); dropzoneUsdz.classList.add('dragover'); });
  dropzoneUsdz.addEventListener('dragleave', () => dropzoneUsdz.classList.remove('dragover'));
  dropzoneUsdz.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneUsdz.classList.remove('dragover');
    if (e.dataTransfer.files?.length) setUsdzFile(e.dataTransfer.files[0]);
  });
  fileUsdz.addEventListener('change', (e) => {
    if (e.target.files?.length) setUsdzFile(e.target.files[0]);
  });
  overlay.querySelector('#btn-remove-usdz').addEventListener('click', () => setUsdzFile(null));

  // Dropzone Robot Map
  const dropzoneMap = overlay.querySelector('#dropzone-robot-map');
  const fileMap = overlay.querySelector('#file-robot-map');
  dropzoneMap.addEventListener('click', () => fileMap.click());
  dropzoneMap.addEventListener('dragover', (e) => { e.preventDefault(); dropzoneMap.classList.add('dragover'); });
  dropzoneMap.addEventListener('dragleave', () => dropzoneMap.classList.remove('dragover'));
  dropzoneMap.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneMap.classList.remove('dragover');
    handleRobotMapFiles(e.dataTransfer.files);
  });
  fileMap.addEventListener('change', (e) => {
    handleRobotMapFiles(e.target.files);
  });
  overlay.querySelector('#btn-remove-pgm').addEventListener('click', () => setPgmFile(null));
  overlay.querySelector('#btn-remove-yaml').addEventListener('click', () => setYamlFile(null));
  overlay.querySelector('#btn-skip-robot-map').addEventListener('click', () => goToStep(3));

  // Options
  overlay.querySelector('#chk-classify').addEventListener('change', (e) => { state.classify = e.target.checked; });
  overlay.querySelector('#chk-remove-clusters').addEventListener('change', (e) => { state.removeIsolatedClusters = e.target.checked; });

  // Navigation
  btnPrev.addEventListener('click', () => {
    if (currentStep > 1 && currentStep < 4) goToStep(currentStep - 1);
  });
  btnNext.addEventListener('click', async () => {
    if (currentStep === 1) {
      if (!state.name) state.name = defaultProjectName();
      goToStep(2);
    } else if (currentStep === 2) {
      goToStep(3);
    } else if (currentStep === 3) {
      await startPipelineExecution();
    }
  });

  // Completion actions
  overlay.querySelector('#btn-complete-create-project').addEventListener('click', () => {
    createPathfinderProjectFromScan(state.activeProjectName);
  });
  overlay.querySelector('#btn-complete-to-studio').addEventListener('click', () => {
    closeScanWizardModal();
    const studioBtn = /** @type {HTMLElement|null} */ (document.querySelector('#subnav-maps button[data-sub="align"]'));
    if (studioBtn) studioBtn.click();
    const mapsTabBtn = /** @type {HTMLElement|null} */ (document.querySelector('.gnb-tab[data-tab="maps"]'));
    if (mapsTabBtn) mapsTabBtn.click();
  });
  overlay.querySelector('#btn-complete-close').addEventListener('click', closeScanWizardModal);
}

function setUsdzFile(file) {
  state.usdzFile = file;
  const pill = modalEl.querySelector('#file-pill-usdz');
  const dropzone = modalEl.querySelector('#dropzone-usdz');
  if (file) {
    const isZip = file.name.toLowerCase().endsWith('.zip');
    const iconEl = modalEl.querySelector('#file-pill-usdz .file-pill-icon');
    if (iconEl) iconEl.textContent = isZip ? '📦' : '◧';
    modalEl.querySelector('#pill-usdz-name').textContent = `${file.name} ${isZip ? '[스캔 ZIP 패키지]' : '[3D LiDAR 메시]'}`;
    modalEl.querySelector('#pill-usdz-size').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
    pill.style.display = 'flex';
    dropzone.style.display = 'none';
  } else {
    pill.style.display = 'none';
    dropzone.style.display = 'flex';
  }
  updateButtonStates();
}

function handleRobotMapFiles(files) {
  if (!files) return;
  for (const f of Array.from(files)) {
    if (f.name.endsWith('.pgm')) setPgmFile(f);
    else if (f.name.endsWith('.yaml') || f.name.endsWith('.yml')) setYamlFile(f);
  }
}

function setPgmFile(file) {
  state.robotMapPgm = file;
  const pill = modalEl.querySelector('#file-pill-pgm');
  if (file) {
    modalEl.querySelector('#pill-pgm-name').textContent = file.name;
    modalEl.querySelector('#pill-pgm-size').textContent = `${(file.size / 1024).toFixed(0)} KB`;
    pill.style.display = 'flex';
  } else {
    pill.style.display = 'none';
  }
}

function setYamlFile(file) {
  state.robotMapYaml = file;
  const pill = modalEl.querySelector('#file-pill-yaml');
  if (file) {
    modalEl.querySelector('#pill-yaml-name').textContent = file.name;
    modalEl.querySelector('#pill-yaml-size').textContent = `${(file.size / 1024).toFixed(1)} KB`;
    pill.style.display = 'flex';
  } else {
    pill.style.display = 'none';
  }
}

function goToStep(step) {
  currentStep = step;
  const overlay = modalEl;

  // Panes
  for (let i = 1; i <= 4; i++) {
    const p = overlay.querySelector(`#wizard-pane-${i}`);
    if (p) p.style.display = i === step ? 'block' : 'none';
  }

  // Stepper badges
  const stepperBadges = overlay.querySelectorAll('#wizard-stepper .step-badge');
  stepperBadges.forEach((b) => {
    const s = parseInt(b.getAttribute('data-step'), 10);
    b.classList.remove('active', 'done');
    if (s < step) b.classList.add('done');
    else if (s === step) b.classList.add('active');
  });

  // Footer buttons
  const btnPrev = overlay.querySelector('#wizard-btn-prev');
  const btnNext = overlay.querySelector('#wizard-btn-next');
  const footer = overlay.querySelector('#wizard-footer');

  if (step === 1) {
    btnPrev.style.display = 'none';
    btnNext.textContent = '다음 단계: 로봇 지도 →';
    footer.style.display = 'flex';
  } else if (step === 2) {
    btnPrev.style.display = 'block';
    btnNext.textContent = '다음 단계: 옵션 →';
    footer.style.display = 'flex';
  } else if (step === 3) {
    btnPrev.style.display = 'block';
    btnNext.textContent = '🚀 파이프라인 처리 시작';
    footer.style.display = 'flex';
  } else if (step === 4) {
    // Hidden during processing; completion box has its own buttons
    footer.style.display = 'none';
  }

  updateButtonStates();
}

function updateButtonStates() {
  const btnNext = modalEl.querySelector('#wizard-btn-next');
  if (!btnNext) return;

  if (currentStep === 1) {
    btnNext.disabled = !state.usdzFile || !state.name.trim();
  } else if (currentStep === 2) {
    btnNext.disabled = false;
  } else if (currentStep === 3) {
    btnNext.disabled = state.submitting;
  }
}

async function startPipelineExecution() {
  const errBanner = modalEl.querySelector('#wizard-error-msg');
  const btnNext = modalEl.querySelector('#wizard-btn-next');
  errBanner.style.display = 'none';
  state.submitting = true;
  updateButtonStates();
  // 업로드+서버 압축 해제가 끝날 때까지 응답이 없다(특히 대용량 zip은 몇 분씩 걸림) --
  // 버튼이 그냥 disabled 되기만 하면 "먹통"처럼 보이므로 진행 중임을 글자로 알린다.
  if (btnNext) btnNext.textContent = '⏳ 업로드·처리 중… (스캔 용량에 따라 몇 분 걸릴 수 있습니다)';

  try {
    // 1. Create project
    await createScanProject(state.name);

    // 2. Submit process job
    const res = await processScanProject(state.name, {
      scanFile: state.usdzFile,
      usdzFile: state.usdzFile,
      robotMapPgm: state.robotMapPgm,
      robotMapYaml: state.robotMapYaml,
      removeIsolatedClusters: state.removeIsolatedClusters,
      classify: state.classify,
    });

    state.activeProjectName = state.name;
    state.submitting = false;

    // Transition to step 4
    goToStep(4);

    if (res && res.type === 'group') {
      handleGroupRegistrationSuccess(res);
    } else {
      startStatusPolling(res);
    }
  } catch (err) {
    state.submitting = false;
    updateButtonStates();
    if (btnNext) btnNext.textContent = '🚀 파이프라인 처리 시작';
    errBanner.textContent = `파이프라인 시작 실패: ${err.message}`;
    errBanner.style.display = 'block';
  }
}

function startStatusPolling(processRes = null) {
  if (pollTimer) clearInterval(pollTimer);

  const consoleEl = modalEl.querySelector('#wizard-log-console');
  const badgeEl = modalEl.querySelector('#pipeline-status-badge');
  const progressBar = modalEl.querySelector('#pipeline-progress-bar');
  const percentText = modalEl.querySelector('#pipeline-percent-text');
  const completionBox = modalEl.querySelector('#pipeline-completion-box');

  consoleEl.innerHTML = `<div class="log-line info">파이프라인 백엔드 작업 시작 (프로젝트: ${state.activeProjectName})</div>`;
  completionBox.style.display = 'none';

  let pollCount = 0;
  pollTimer = setInterval(async () => {
    pollCount++;
    try {
      const s = await getScanProjectStatus(state.activeProjectName);
      if (!s) return;

      // Update steps in rail
      const stepEntries = s.steps || {};
      const rails = modalEl.querySelectorAll('.rail-step');
      let doneCount = 0;

      rails.forEach((r) => {
        const key = r.getAttribute('data-step-key');
        const st = stepEntries[key] || 'pending';
        r.classList.remove('pending', 'active', 'done', 'skip', 'error');
        r.classList.add(st);

        const statusLabel = r.querySelector('.rail-step-status');
        if (statusLabel) {
          statusLabel.textContent = {
            pending: '대기 중',
            active: '진행 중…',
            done: '완료',
            skip: '건너뜀',
            error: '오류',
          }[st] || st;
        }

        if (st === 'done' || st === 'skip') doneCount++;
      });

      // Percentage
      const percent = Math.round((doneCount / STEP_LABELS.length) * 100);
      progressBar.style.width = `${percent}%`;
      percentText.textContent = `${percent}%`;

      // Log Console
      if (Array.isArray(s.log)) {
        consoleEl.innerHTML = s.log.map((line) => {
          const isErr = line.startsWith('오류') || line.includes('error');
          const isOk = line.includes('완료') || line.includes('PASS');
          const cls = isErr ? 'error' : isOk ? 'success' : 'default';
          return `<div class="log-line ${cls}">${escapeHtml(line)}</div>`;
        }).join('');
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }

      // Phase check
      if (s.phase === 'running') {
        badgeEl.textContent = `파이프라인 처리 중… (${doneCount}/${STEP_LABELS.length})`;
        badgeEl.className = 'pipeline-phase-pill running';
      } else if (s.phase === 'done') {
        clearInterval(pollTimer);
        pollTimer = null;
        badgeEl.textContent = '처리 완료 (100%)';
        badgeEl.className = 'pipeline-phase-pill done';
        completionBox.style.display = 'block';
        const hasFloor = processRes?.has_floorplan ? ' 바닥 도면(floorplan)이 포함되어 2D 지도 배경에 표시됩니다.' : '';
        modalEl.querySelector('#pipeline-completion-desc').textContent =
          `프로젝트 [${state.activeProjectName}]의 천장 제거, 베이스맵 및 장애물 추출이 완료되었습니다.${hasFloor}`;
      } else if (s.phase === 'error') {
        clearInterval(pollTimer);
        pollTimer = null;
        badgeEl.textContent = '처리 오류 발생';
        badgeEl.className = 'pipeline-phase-pill error';
      }
    } catch (err) {
      if (pollCount > 10) {
        consoleEl.innerHTML += `<div class="log-line error">상태 조회 에러: ${escapeHtml(err.message)}</div>`;
      }
    }
  }, 1000);
}

function handleGroupRegistrationSuccess(res) {
  const consoleEl = modalEl.querySelector('#wizard-log-console');
  const badgeEl = modalEl.querySelector('#pipeline-status-badge');
  const progressBar = modalEl.querySelector('#pipeline-progress-bar');
  const percentText = modalEl.querySelector('#pipeline-percent-text');
  const completionBox = modalEl.querySelector('#pipeline-completion-box');

  consoleEl.innerHTML = `
    <div class="log-line info">다중 스캔 프로젝트(Scan Group) 패키지 감지됨</div>
    <div class="log-line success">포함된 group_alignment.json 및 개별 스캔 데이터가 정합 스튜디오에 배포되었습니다.</div>
    <div class="log-line success">스캔 슬라이스 및 바닥 도면 준비 완료.</div>
  `;
  badgeEl.textContent = '그룹 정합 준비 완료 (100%)';
  badgeEl.className = 'pipeline-phase-pill done';
  progressBar.style.width = '100%';
  percentText.textContent = '100%';

  const rails = modalEl.querySelectorAll('.rail-step');
  rails.forEach((r) => {
    r.classList.remove('pending', 'active', 'error');
    r.classList.add('done');
    const sl = r.querySelector('.rail-step-status');
    if (sl) sl.textContent = '그룹 반영됨';
  });

  completionBox.style.display = 'block';
  completionBox.querySelector('.completion-title').textContent = '🎉 다중 스캔 프로젝트(Scan Group) 등록 완료!';
  completionBox.querySelector('#pipeline-completion-desc').textContent =
    `프로젝트 [${res.group || state.name}]의 다중 스캔 그룹이 정합 스튜디오에 등록되었습니다. 정합 스튜디오에서 각 스캔의 정합을 확인하고 완성 지도를 생성할 수 있습니다.`;
  
  // For groups, hide single-scan project creation button or redirect to studio
  const btnCreate = modalEl.querySelector('#btn-complete-create-project');
  if (btnCreate) {
    btnCreate.textContent = '정합에서 다중 스캔 확인·합성';
    btnCreate.onclick = () => {
      // 정합 탭에는 그룹이 여러 개면 아무것도 자동으로 안 열린다(고르라는 안내만 뜸) --
      // 방금 등록한 이 그룹을 main.js가 열어주도록 이름을 넘겨둔다.
      setPendingAlignGroup(res.group || state.name);
      closeScanWizardModal();
      const studioBtn = /** @type {HTMLElement|null} */ (document.querySelector('#subnav-maps button[data-sub="align"]'));
      if (studioBtn) studioBtn.click();
      const mapsTabBtn = /** @type {HTMLElement|null} */ (document.querySelector('.gnb-tab[data-tab="maps"]'));
      if (mapsTabBtn) mapsTabBtn.click();
    };
  }
}

async function createPathfinderProjectFromScan(projectName) {
  const btn = modalEl.querySelector('#btn-complete-create-project');
  if (btn) btn.disabled = true;
  try {
    const slicemapRes = await fetch(`/scan-files/${encodeURIComponent(projectName)}/${encodeURIComponent(projectName)}.slicemap.json`);
    if (slicemapRes.ok) {
      const slicemap = await slicemapRes.json();
      let floor = undefined;
      const floorPngRes = await fetch(`/scan-files/${encodeURIComponent(projectName)}/floorplan.png`);
      const floorJsonRes = await fetch(`/scan-files/${encodeURIComponent(projectName)}/floorplan.json`);
      if (floorPngRes.ok && floorJsonRes.ok) {
        const floorBlob = await floorPngRes.blob();
        const png = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(floorBlob);
        });
        const meta = await floorJsonRes.json();
        floor = { png, meta };
      }
      const p = await createProjectFromSlicemap({ name: projectName, slicemap, floor });
      closeScanWizardModal();
      const url = new URL(location.href);
      url.searchParams.set('project', p.id);
      location.href = url.toString();
      return;
    }
    // Fallback: create normal project and switch
    const p = await createProject({ name: projectName, sizeX: 50, sizeY: 50 });
    closeScanWizardModal();
    const url = new URL(location.href);
    url.searchParams.set('project', p.id);
    location.href = url.toString();
  } catch (err) {
    if (btn) btn.disabled = false;
    alert(`현장 생성 실패: ${err.message}`);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {{ file?: File | null }} [opts] 가져오기 대화상자가 고른 스캔 파일을 미리 넣어 연다 */
export function openScanWizardModal({ file = null } = {}) {
  initScanWizardModal();

  // Reset form
  state = {
    name: defaultProjectName(),
    usdzFile: null,
    robotMapPgm: null,
    robotMapYaml: null,
    removeIsolatedClusters: false,
    classify: true,
    submitting: false,
    errorMsg: null,
    activeProjectName: '',
  };

  modalEl.querySelector('#wizard-input-name').value = state.name;
  setUsdzFile(null);
  setPgmFile(null);
  setYamlFile(null);
  modalEl.querySelector('#chk-classify').checked = true;
  modalEl.querySelector('#chk-remove-clusters').checked = false;
  modalEl.querySelector('#wizard-error-msg').style.display = 'none';

  goToStep(1);
  modalEl.style.display = 'flex';
  if (file) setUsdzFile(file);
}

export function closeScanWizardModal() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (modalEl) modalEl.style.display = 'none';
}

