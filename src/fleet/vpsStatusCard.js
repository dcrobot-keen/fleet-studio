// 설정 › VPS 서버 카드 -- server/vps.mjs를 거쳐 등록된 room(위치 보정용 스캔) 목록을 보고 지운다.
// 업로드(스캔을 새로 등록)는 여기서 안 함 -- scan-engine 정합 워크스페이스의 스캔 id와 room_id가 반드시
// 같아야 하므로, 그 id가 이미 확정된 alignWorkspace.js의 스캔 행에서만 등록한다.
// brokerSettings.js의 카드 관례(el, robot-button, settings-service-row)를 simControlCard.js와 같이 따른다.
import { getVpsHealth, listVpsRooms, deleteVpsRoom } from './vpsApi.js';

const POLL_MS = 4000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createVpsStatusCard(containerEl) {
  containerEl.className = 'robot-form-panel settings-panel';
  containerEl.appendChild(el('div', 'robot-form-title', 'VPS 서버'));
  containerEl.appendChild(
    el('div', 'robot-form-status', '위 "VPS 서버" 주소에 등록된 room(위치 보정용 스캔) 목록입니다. 스캔을 새로 등록하려면 지도 › 정합 워크스페이스의 각 스캔 행에서 "VPS" 버튼을 쓰세요.')
  );

  const statusLine = el('div', 'fleet-broker-status', '상태 확인 중...');
  containerEl.appendChild(statusLine);

  const roomsList = el('div', 'settings-services');
  containerEl.appendChild(roomsList);

  function renderRooms(rooms, frames) {
    roomsList.replaceChildren();
    if (!rooms.length) {
      roomsList.appendChild(el('div', 'settings-service-desc', '등록된 room이 없습니다.'));
      return;
    }
    for (const r of rooms) {
      const row = el('div', 'settings-service-row');
      const header = el('div', 'settings-service-header');
      header.appendChild(el('b', '', r.room_id));
      const delBtn = el('button', 'robot-button', '삭제');
      delBtn.addEventListener('click', async () => {
        if (!confirm(`'${r.room_id}' room을 VPS 서버에서 삭제할까요?`)) return;
        delBtn.disabled = true;
        try {
          await deleteVpsRoom(r.room_id);
          await poll();
        } catch (err) {
          statusLine.textContent = `삭제 실패: ${err.message}`;
          statusLine.style.color = '#c0392b';
          delBtn.disabled = false;
        }
      });
      header.appendChild(delBtn);
      row.appendChild(header);
      const isRef = frames?.enabled && frames.reference === r.room_id;
      row.appendChild(el('span', 'settings-service-desc', `이미지 ${r.num_images}장${isRef ? ` · 그룹 '${frames.group}'의 기준 스캔` : ''}`));
      roomsList.appendChild(row);
    }
  }

  async function poll() {
    try {
      const health = await getVpsHealth();
      if (!health.ok) {
        statusLine.textContent = `연결 안 됨${health.error ? ` -- ${health.error}` : ''}`;
        statusLine.style.color = '#c0392b';
        renderRooms([], null);
        return;
      }
      const { rooms, frames } = await listVpsRooms();
      statusLine.textContent = `연결됨 · room ${rooms.length}개`;
      statusLine.style.color = '#2a7d2a';
      renderRooms(rooms, frames);
    } catch (err) {
      statusLine.textContent = `연결 안 됨 -- ${err.message}`;
      statusLine.style.color = '#c0392b';
    }
  }

  poll();
  const timer = setInterval(poll, POLL_MS);
  return { destroy() { clearInterval(timer); } };
}
