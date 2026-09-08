// 서비스 주소(server/settings.mjs, data/settings.json)를 읽는 공용 헬퍼. 서버가 진짜 값을 갖고 있고
// localStorage는 캐시일 뿐인데(brokerSettings.js의 fetch('/api/settings/services') 참고), 여러 화면이
// 그 캐시를 각자 localStorage.getItem('pathfinder_services_endpoints')+JSON.parse로 따로 읽던 걸 여기 하나로.
export const DEFAULT_SERVICES = {
  simViewer: 'http://localhost:8767',
  studio: 'http://localhost:8000/groups',
  scanEngine: 'http://localhost:8000',
  navBrain: 'http://localhost:5173/apps/dashboard/nav.html',
  vpsServer: 'http://localhost:8080',
};

/** @param {keyof typeof DEFAULT_SERVICES} key */
export function getServiceUrl(key) {
  try {
    const raw = localStorage.getItem('pathfinder_services_endpoints');
    if (raw) {
      const saved = JSON.parse(raw)?.[key];
      if (saved) return saved;
    }
  } catch {}
  return DEFAULT_SERVICES[key];
}
