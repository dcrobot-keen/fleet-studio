// 프로젝트 CRUD API 클라이언트 (server/projects.mjs).
const API_URL = '/api/projects';

/** @returns {Promise<Array<{id:string,name:string,sizeX:number,sizeY:number}>>} */
export async function listProjects() {
  const res = await fetch(API_URL);
  if (!res.ok) {
    throw new Error(`프로젝트 목록 조회 실패 (${res.status})`);
  }
  return res.json();
}

/**
 * 프로젝트(현장)를 삭제한다. 기본 프로젝트는 서버가 거절한다.
 * @param {string} id
 */
export async function deleteProject(id) {
  const res = await fetch(`${API_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `프로젝트 삭제 실패 (${res.status})`);
  }
}

/**
 * @param {{name:string, sizeX?:number, sizeY?:number}} project
 * @returns {Promise<{id:string,name:string,sizeX:number,sizeY:number}>}
 */
export async function createProject({ name, sizeX, sizeY }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, sizeX, sizeY }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `프로젝트 생성 실패 (${res.status})`);
  }
  return data;
}

/**
 * slicemap-v1(scan-to-map-studio 정합 결과) 하나로 프로젝트 + 장애물을 만든다
 * (server/projects.mjs POST /api/projects/from-slicemap). 평면 크기는 격자 크기,
 * 좌표는 시뮬레이터 월드와 동일(격자 왼쪽-아래 = 0,0).
 */
/**
 * 정합을 다시 저장했을 때 같은 프로젝트(id·nodelink 유지)를 새 slicemap/floor 로 갱신
 * @param {string} id
 * @param {{ name?: string, slicemap: object, room?: object, floor?: { png: string, meta: object } }} payload
 */
export async function updateProjectFromSlicemap(id, { name, slicemap, room, floor }) {
  const res = await fetch(`${API_URL}/${encodeURIComponent(id)}/from-slicemap`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slicemap, room, floor }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `프로젝트 갱신 실패 (${res.status})`);
  }
  return data;
}

/**
 * 슬라이스맵(+ 앱 바닥 이미지)으로 새 프로젝트를 만든다 -- 서버가 장애물 블록을 함께 생성
 * @param {{ name: string, slicemap: object, room?: object, floor?: { png: string, meta: object } }} payload
 */
export async function createProjectFromSlicemap({ name, slicemap, room, floor }) {
  const res = await fetch(`${API_URL}/from-slicemap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slicemap, room, floor }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `프로젝트 생성 실패 (${res.status})`);
  }
  return data;
}
