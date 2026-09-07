// 메뉴 맨 앞의 프로젝트 콤보 박스 -- 목록에서 고르면 그 프로젝트로 전환(=주소창
// ?project=<id>를 바꾸고 새로고침), "+ 새 프로젝트"로 만들면 곧바로 전환된다.
// 지도/뷰 인스턴스를 그 자리에서 다시 만드는 게 아니라 새로고침으로 전환하는
// 이유는 appShared.js 헤더 주석 참고.
import { allProjects, activeProjectId } from '../appShared.js';
import { createProject, deleteProject } from './projectApi.js';

// server/projects.mjs의 DEFAULT_PROJECT_ID와 같은 값 -- 이 프로젝트는 항상 있고 삭제도 안 된다.
const DEFAULT_PROJECT_ID = 'default';

function navigateToProject(id) {
  const url = new URL(location.href);
  url.searchParams.set('project', id);
  location.href = url.toString();
}

function openCreateForm(container) {
  if (container.querySelector('.project-create-form')) return; // 이미 열려있음

  const form = document.createElement('div');
  form.className = 'project-create-form';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = '프로젝트 이름';
  nameInput.className = 'project-create-input project-name-input';

  const sizeXInput = document.createElement('input');
  sizeXInput.type = 'number';
  sizeXInput.placeholder = '가로(m)';
  sizeXInput.value = '200';
  sizeXInput.min = '1';
  sizeXInput.className = 'project-create-input project-size-input';

  const sizeYInput = document.createElement('input');
  sizeYInput.type = 'number';
  sizeYInput.placeholder = '세로(m)';
  sizeYInput.value = '400';
  sizeYInput.min = '1';
  sizeYInput.className = 'project-create-input project-size-input';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'project-create-confirm';
  confirmBtn.textContent = '만들기';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'project-create-cancel';
  cancelBtn.textContent = '취소';

  const statusEl = document.createElement('span');
  statusEl.className = 'project-create-status';

  form.append(nameInput, sizeXInput, sizeYInput, confirmBtn, cancelBtn, statusEl);
  container.appendChild(form);
  nameInput.focus();

  cancelBtn.addEventListener('click', () => form.remove());

  confirmBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      statusEl.textContent = '이름을 입력하세요.';
      return;
    }
    confirmBtn.disabled = true;
    statusEl.textContent = '만드는 중...';
    try {
      const project = await createProject({
        name,
        sizeX: Number(sizeXInput.value),
        sizeY: Number(sizeYInput.value),
      });
      navigateToProject(project.id);
    } catch (err) {
      statusEl.textContent = `실패: ${err.message}`;
      confirmBtn.disabled = false;
    }
  });
}

/** @param {HTMLElement} container */
export function createProjectSelector(container) {
  container.innerHTML = '';
  container.className = 'project-selector';

  const select = document.createElement('select');
  select.className = 'project-select';
  allProjects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    const badge = p.approved ? ' [승인]' : (p.importedRoom ? ' [스캔]' : '');
    opt.textContent = `${p.name}${badge} (${p.sizeX}×${p.sizeY}m)`;
    if (p.id === activeProjectId) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => navigateToProject(select.value));

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'project-new-button';
  newBtn.textContent = '+ 새 현장';
  newBtn.title = '새로운 빈 현장 프로젝트를 생성합니다.';
  newBtn.addEventListener('click', () => openCreateForm(container));

  // 드롭다운에서 지금 고른 현장을 지운다(기본 프로젝트는 서버가 거절하므로 버튼 자체를 비활성화).
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'project-delete-button';
  delBtn.textContent = '🗑 삭제';
  delBtn.title = '선택된 현장을 삭제합니다. 기본 프로젝트는 삭제할 수 없습니다.';
  delBtn.disabled = activeProjectId === DEFAULT_PROJECT_ID;
  delBtn.addEventListener('click', async () => {
    const current = allProjects.find((p) => p.id === activeProjectId);
    if (!current) return;
    if (!confirm(`"${current.name}" 현장을 삭제할까요?\n노드/링크 등 이 현장의 데이터가 사라지며 되돌릴 수 없습니다.`)) return;
    delBtn.disabled = true;
    try {
      await deleteProject(activeProjectId);
      navigateToProject(DEFAULT_PROJECT_ID);
    } catch (err) {
      alert(`삭제 실패: ${err.message}`);
      delBtn.disabled = false;
    }
  });

  // 슬라이스맵 파일 · 스캔 · PCD 는 지도 리본의 "가져오기"(src/imports) 하나로 들어온다.
  container.append(select, newBtn, delBtn);
}
