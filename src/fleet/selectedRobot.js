// 플릿 보드(fleetBoard.js)에서 고른 로봇을 지도/3D 뷰(liveRobotPose.js, site3d/site3dView.js)에도 알려주는
// 아주 작은 공유 상태. 서로 직접 참조하지 않게(운영 탭에만 있는 fleetBoard 를 지도/시뮬레이션 탭도 몰라도 되게)
// 이 모듈 하나만 두고 구독한다.
let selectedSerial = null;
const listeners = new Set();

export function setSelectedRobotSerial(serial) {
  if (serial === selectedSerial) return;
  selectedSerial = serial;
  for (const cb of listeners) cb(selectedSerial);
}

export function getSelectedRobotSerial() {
  return selectedSerial;
}

/** @returns {() => void} 구독 해제 함수 */
export function onSelectedRobotChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
