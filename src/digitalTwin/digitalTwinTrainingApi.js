// server/digitalTwinTraining.mjs 호출용 클라이언트 -- SuGaR 학습 job runner.
async function request(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

/** { scans: [{ id, group, dir, imageCount }] } */
export function listTrainableScans() {
  return request('/api/digital-twin/train/scans');
}

/** 202 { jobId, name } -- scanId가 이미 학습 중이면 409, 스캔 변환 실패하면 400. */
export function startTraining(scanId, { polyMode = 'low', refinementTime = 'short' } = {}) {
  return request('/api/digital-twin/train', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId, polyMode, refinementTime }),
  });
}

/** job 레코드 하나 -- { name, scanId, options, stage, stageLabel, phase, elapsedMs, queuePosition?, log, error } */
export function getTrainingStatus(jobId) {
  return request(`/api/digital-twin/train/${encodeURIComponent(jobId)}/status`);
}

/** { jobs: [...최신순] } -- 새로고침 후 "지금 뭐가 돌고 있나" 복구용. */
export function listTrainingJobs() {
  return request('/api/digital-twin/train');
}
