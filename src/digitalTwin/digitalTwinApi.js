// server/digitalTwin.mjs 호출용 클라이언트 -- dc-vps-digital-twin(SuGaR) 결과 뷰어.
async function request(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

/** { results: [{ name, hasViewer, hasSource, sizeBytes }] } */
export function listDigitalTwinResults() {
  return request('/api/digital-twin/results');
}

/** 비동기 생성 시작 -- 202면 getDigitalTwinGenerateStatus로 폴링. { status: 'running' } */
export function generateDigitalTwinViewer(name) {
  return request(`/api/digital-twin/results/${encodeURIComponent(name)}/generate`, { method: 'POST' });
}

/** { status: 'idle'|'running'|'done'|'error', error? } */
export function getDigitalTwinGenerateStatus(name) {
  return request(`/api/digital-twin/results/${encodeURIComponent(name)}/generate/status`);
}

/** fetch 없이 URL만 -- iframe src로 바로 쓴다. */
export function digitalTwinViewerUrl(name) {
  return `/api/digital-twin/results/${encodeURIComponent(name)}/viewer`;
}
