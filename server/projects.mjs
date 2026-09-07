// 프로젝트 CRUD + 프로젝트별 노드/링크/블록 GeoJSON 저장.
//
// "프로젝트" = 독립된 좌표 평면 하나(이름 + 가로/세로 크기, 미터 단위) + 그 위에서
// 편집한 nodelink.geojson. project.md의 원안(WGS84/TM 같은 지리좌표계 선택, 3m
// 격자 등)은 지금 코드베이스 어디에도 지리좌표 개념이 없고 실제로 필요해진 적도
// 없어서 의도적으로 뺐다 — doc/architecture-improvements.md 참고. 여기서 푸는
// 문제는 그보다 훨씬 좁다: "방 하나 = pathfinder 좌표계 전체"였던 기존 가정 때문에
// 서로 다른 스캔 공간 두 개를 좌표 충돌 없이 동시에 못 다루던 것뿐이다.
//
// 로봇 등록(robots.json)은 프로젝트별로 안 나눴다 — 로봇은 실물이라 여러
// 프로젝트(맵)를 오갈 수 있는 하나의 카탈로그로 보는 쪽이 더 현실적이다.
import express from 'express';
import { JSONFilePreset } from 'lowdb/node';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseSlicemap, slicemapSize, slicemapToObstacles, roomIdFromName } from './slicemap.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// PATHFINDER_DATA_DIR로 데이터 루트를 바꿀 수 있다 -- 스모크 테스트가 실제
// data/(사용자의 진짜 편집 결과가 든)를 건드리지 않고 임시 디렉터리에서 프로젝트
// 생성/삭제를 검증하기 위한 용도. 지정 안 하면 기존과 동일하게 이 저장소의 data/.
const DATA_DIR = process.env.PATHFINDER_DATA_DIR
  ? resolve(process.env.PATHFINDER_DATA_DIR)
  : resolve(__dirname, '../data');
const PROJECTS_DB_PATH = resolve(DATA_DIR, 'projects.json');
const PROJECTS_DATA_DIR = resolve(DATA_DIR, 'projects');
// index.mjs의 IMPORTED_DIR와 같은 위치 -- from-slicemap이 만든 장애물은 기존
// "스캔 장애물" 패널이 그대로 읽는다.
const IMPORTED_DIR = resolve(DATA_DIR, 'imported');
// 기존에 이미 있던 유일한 nodelink.geojson. "기본" 프로젝트는 이 파일을 그대로
// 쓰게 해서(옮기지 않음), 이번 변경으로 기존 편집 데이터가 조금이라도 움직이거나
// 유실될 위험을 없앤다.
const LEGACY_NODELINK_PATH = resolve(DATA_DIR, 'nodelink.geojson');
const DEFAULT_FC = { type: 'FeatureCollection', features: [] };

export const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_SIZE_X = 200;
const DEFAULT_SIZE_Y = 400;

function nowIso() {
  return new Date().toISOString();
}

function nodelinkPathForProject(project) {
  return project.id === DEFAULT_PROJECT_ID
    ? LEGACY_NODELINK_PATH
    : resolve(PROJECTS_DATA_DIR, project.id, 'nodelink.geojson');
}

// 새 프로젝트는 data/projects/<id>/ 디렉터리 자체가 아직 없다 -- lowdb는 파일은
// 만들어줘도 없는 디렉터리까지 만들어주진 않아서, 쓰기 전에 직접 만들어야 한다.
// (레거시 경로는 data/가 항상 이미 있어서 이 문제가 없었다.)
async function openNodelinkDb(project) {
  const path = nodelinkPathForProject(project);
  await mkdir(dirname(path), { recursive: true });
  return JSONFilePreset(path, DEFAULT_FC);
}

function pickPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isFeatureCollection(body) {
  return body && body.type === 'FeatureCollection' && Array.isArray(body.features);
}

export async function createProjectsRouter() {
  const db = await JSONFilePreset(PROJECTS_DB_PATH, { projects: [] });
  if (db.data.projects.length === 0) {
    const timestamp = nowIso();
    db.data.projects.push({
      id: DEFAULT_PROJECT_ID,
      name: '기본 프로젝트',
      sizeX: DEFAULT_SIZE_X,
      sizeY: DEFAULT_SIZE_Y,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.write();
  }

  function findProject(id) {
    return db.data.projects.find((p) => p.id === id);
  }

  const router = express.Router();

  router.get('/projects', (req, res) => {
    res.json(db.data.projects);
  });

  router.post('/projects', async (req, res) => {
    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string') {
      res.status(400).json({ error: 'name은 필수입니다.' });
      return;
    }
    const timestamp = nowIso();
    const project = {
      id: randomUUID(),
      name: body.name,
      sizeX: pickPositiveNumber(body.sizeX, DEFAULT_SIZE_X),
      sizeY: pickPositiveNumber(body.sizeY, DEFAULT_SIZE_Y),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.data.projects.push(project);
    await db.write();
    res.status(201).json(project);
  });

  // 스캔 지도(slicemap-v1) 하나로 프로젝트를 만든다: 평면 크기 = 격자 크기,
  // 점유 셀 = data/imported/<room>.geojson 장애물 블록, importedRoom 으로 연결.
  // 같은 파일을 시뮬레이터 SIM_WORLD 로 쓰면 두 좌표계가 그대로 일치한다
  // (server/slicemap.mjs 헤더 참고). doc/vda5050-rcs.md 의 "프로젝트 = mapId".
  // body.floor (선택): 정합 워크스페이스가 함께 publish한 <group>.floor.png/.json --
  // { png: base64 또는 data URL, meta: floor-image-v1 { resolution, origin:[x,y], width_px, height_px } }.
  // 격자 좌표계가 slicemap과 같으므로(둘 다 slice 평면, origin = 왼쪽-아래) 프로젝트 평면
  // extent 는 slicemap origin 을 빼서 얻는다. 파일은 data/imported/<room>.floor.png.
  async function saveFloorImage(room, slice, floor) {
    if (!floor) return null;
    const meta = floor.meta ?? {};
    const png = typeof floor.png === 'string' ? floor.png.replace(/^data:image\/png;base64,/, '') : null;
    if (!png) throw new Error('floor.png (base64) 가 필요합니다.');
    for (const k of ['resolution', 'width_px', 'height_px']) {
      if (!Number.isFinite(Number(meta[k])) || Number(meta[k]) <= 0) throw new Error(`floor.meta.${k} 가 양수가 아닙니다.`);
    }
    if (!Array.isArray(meta.origin) || meta.origin.length < 2) throw new Error('floor.meta.origin [x, y] 가 필요합니다.');
    const bytes = Buffer.from(png, 'base64');
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('floor.png 가 PNG 가 아닙니다.');
    await writeFile(resolve(IMPORTED_DIR, `${room}.floor.png`), bytes);
    const res_ = Number(meta.resolution);
    const x0 = Number(meta.origin[0]) - slice.origin[0];
    const y0 = Number(meta.origin[1]) - slice.origin[1];
    return {
      url: `/api/imported-obstacles/${room}/floor.png`,
      extent: [x0, y0, x0 + Number(meta.width_px) * res_, y0 + Number(meta.height_px) * res_].map((v) => Math.round(v * 10000) / 10000),
      widthPx: Number(meta.width_px),
      heightPx: Number(meta.height_px),
    };
  }

  /** slicemap(+floor) -> 프로젝트 필드 + 장애물 파일. existing 이 있으면 그 프로젝트를 갱신한다. */
  async function applySlicemap(body, existing = null) {
    const slice = parseSlicemap(body.slicemap);
    const name = typeof body.name === 'string' && body.name ? body.name : existing?.name;
    if (!name) throw Object.assign(new Error('name은 필수입니다.'), { status: 400 });
    const room = existing?.importedRoom ?? roomIdFromName(body.room ?? name);
    const { sizeX, sizeY } = slicemapSize(slice);
    const timestamp = nowIso();
    const { featureCollection, counts } = slicemapToObstacles(slice, { room, importedAt: timestamp });
    await mkdir(IMPORTED_DIR, { recursive: true });
    await writeFile(resolve(IMPORTED_DIR, `${room}.geojson`), JSON.stringify(featureCollection), 'utf-8');
    const floorImage = await saveFloorImage(room, slice, body.floor);
    const project = {
      ...(existing ?? { id: randomUUID(), createdAt: timestamp }),
      name,
      sizeX: Math.round(sizeX * 1000) / 1000,
      sizeY: Math.round(sizeY * 1000) / 1000,
      importedRoom: room,
      approved: body.approved ?? true,
      site: body.site ?? (existing?.site ?? { id: room, group: room, name }),
      slicemap: { resolution: slice.resolution, cols: slice.cols, rows: slice.rows, origin: slice.origin, z: slice.z, sources: slice.sources },
      floorImage: floorImage ?? existing?.floorImage ?? null,
      updatedAt: timestamp,
    };
    return { project, counts, featureCount: featureCollection.features.length };
  }

  router.post('/projects/from-slicemap', async (req, res) => {
    try {
      const { project, counts, featureCount } = await applySlicemap(req.body || {});
      db.data.projects.push(project);
      await db.write();
      res.status(201).json({ ...project, obstacleCounts: counts, featureCount });
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  });

  // 같은 프로젝트를 새 slicemap/floor 로 갱신 (id, nodelink 유지) -- 정합을 다시 저장했을 때.
  router.put('/projects/:id/from-slicemap', async (req, res) => {
    const idx = db.data.projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
      return;
    }
    try {
      const { project, counts, featureCount } = await applySlicemap(req.body || {}, db.data.projects[idx]);
      db.data.projects[idx] = project;
      await db.write();
      res.json({ ...project, obstacleCounts: counts, featureCount });
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  });

  router.get('/projects/:id', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
      return;
    }
    res.json(project);
  });

  // 프로젝트 레코드 + 그 프로젝트 전용 폴더(nodelink.geojson 등, PROJECTS_DATA_DIR/<id>)만 지운다.
  // 기본 프로젝트는 항상 존재해야 하는 레거시 특수 케이스라 못 지우게 막는다. 로봇 등록/시뮬레이터
  // 설정/가져온 장애물 파일(data/imported/<room>.*)처럼 프로젝트 id를 참조만 하는 다른 데이터는
  // 일부러 안 건드린다 -- 여러 하위 시스템에 걸친 연쇄 삭제까지 하기엔 위험이 더 크다.
  router.delete('/projects/:id', async (req, res) => {
    if (req.params.id === DEFAULT_PROJECT_ID) {
      res.status(400).json({ error: '기본 프로젝트는 삭제할 수 없습니다.' });
      return;
    }
    const idx = db.data.projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
      return;
    }
    db.data.projects.splice(idx, 1);
    await db.write();
    await rm(resolve(PROJECTS_DATA_DIR, req.params.id), { recursive: true, force: true });
    res.status(204).end();
  });

  router.patch('/projects/:id/approve', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
      return;
    }
    project.approved = req.body.approved !== undefined ? Boolean(req.body.approved) : !project.approved;
    project.updatedAt = nowIso();
    await db.write();
    res.json(project);
  });

  router.get('/projects/:id/nodelink', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
      return;
    }
    const nodelinkDb = await openNodelinkDb(project);
    res.json(nodelinkDb.data);
  });

  router.put('/projects/:id/nodelink', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
      return;
    }
    if (!isFeatureCollection(req.body)) {
      res.status(400).json({ error: '요청 본문이 유효한 GeoJSON FeatureCollection이 아닙니다.' });
      return;
    }
    const nodelinkDb = await openNodelinkDb(project);
    nodelinkDb.data = req.body;
    await nodelinkDb.write();
    res.json({ ok: true, featureCount: nodelinkDb.data.features.length });
  });

  return router;
}
