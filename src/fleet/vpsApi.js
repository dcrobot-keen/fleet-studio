// server/vps.mjs 호출용 클라이언트 -- VPS 서버(위치 보정) 상태 조회/room 관리/스캔 등록.
async function request(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  // data.error는 server/vps.mjs 자체가 만드는 에러(업스트림 연결 불가 등), data.detail은 FastAPI(vps-system)가
  // 그대로 통과된 에러(HTTPException(detail=...)) -- 둘 다 사람이 읽을 만한 한국어 메시지라 그대로 보여준다.
  if (!res.ok) throw new Error(data.error || data.detail || `요청 실패 (${res.status})`);
  return data;
}

/** { ok, error? } -- 업스트림이 죽어 있어도 항상 200으로 온다(서버 쪽 vps.mjs 참고). */
export function getVpsHealth() {
  return request('/api/vps/health');
}

/** { rooms: [{room_id, num_images}], frames: {enabled, group, reference, rooms} } */
export function listVpsRooms() {
  return request('/api/vps/rooms');
}

/** { rooms } */
export function deleteVpsRoom(roomId) {
  return request(`/api/vps/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
}

/** { scan_name, status: 'unzipping'|'building'|'registering'|'done'|'failed', room_id, error? } */
export function getVpsScanStatus(scanName) {
  return request(`/api/vps/scans/${encodeURIComponent(scanName)}`);
}

/**
 * 원본 스캔 zip을 VPS 서버에 등록(빌드는 비동기 -- 202 받으면 getVpsScanStatus로 폴링).
 * @param {string} scanName room_id로 쓰일 이름 -- 정합 그룹의 스캔 id와 반드시 같아야 한다.
 * @param {File|Blob} file
 * @param {{ replace?: boolean }} [opts]
 */
export function uploadVpsScan(scanName, file, { replace = false } = {}) {
  const qs = new URLSearchParams({ scanName, replace: String(replace) });
  return request(`/api/vps/scans?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  });
}
