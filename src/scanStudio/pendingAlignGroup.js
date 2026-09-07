// 스캔 위저드(scanWizardModal.js)에서 다중 스캔 그룹을 등록한 직후 "정합 스튜디오"로 넘어갈 때,
// 방금 만든 그룹을 자동으로 열어주기 위한 아주 작은 전달용 상태. main.js가 위저드를 몰라도 되게(직접
// import하면 순환 참조가 생김) 이 모듈 하나만 두고 값을 실어 나른다 -- selectedRobot.js와 같은 패턴.
let pendingGroup = null;

export function setPendingAlignGroup(name) {
  pendingGroup = name;
}

/** 값을 읽고 즉시 비운다 -- 정합 탭을 한 번 더 눌렀을 때 같은 그룹을 계속 강제로 다시 열지 않도록. */
export function consumePendingAlignGroup() {
  const name = pendingGroup;
  pendingGroup = null;
  return name;
}
