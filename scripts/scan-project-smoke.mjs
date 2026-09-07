// 스캔 지도 -> 프로젝트 스모크: server/slicemap.mjs 의 격자->블록 변환과
// POST /api/projects/from-slicemap, 그리고 VDA5050 로봇 자동 등록
// (robots.mjs ensureVda5050Robot)을 임시 데이터 디렉터리에서 검증한다.
//
//   node scripts/scan-project-smoke.mjs
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { occupiedRectangles, parseSlicemap, slicemapToObstacles, slicemapSize, roomIdFromName } from '../server/slicemap.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!cond) failures++;
}

// 6x4 격자(r = 0.5 m): 아래 두 행에 걸친 벽 3칸(0..3), 가구 1칸, 행 2에 벽 2칸(3..5)
//   row3: . . . . . .
//   row2: . . . W W .
//   row1: W W W . F .
//   row0: W W W . . .
const cols = 6, rows = 4, r = 0.5;
const codes = new Uint8Array(cols * rows).fill(1);
const set = (c, row, v) => (codes[row * cols + c] = v);
for (const c of [0, 1, 2]) { set(c, 0, 3); set(c, 1, 3); }
set(4, 1, 2);
set(3, 2, 3); set(4, 2, 3);
codes[rows * cols - 1] = 0; // unknown cell must not become an obstacle
const doc = { format: 'slicemap-v1', z: 0.18, band: 0.05, resolution: r, origin: [-3, -2], cols, rows, data: Buffer.from(codes).toString('base64'), sources: [{ scan: 'a' }] };

// --- 1. 순수 변환 ---
{
  const slice = parseSlicemap(doc);
  check('parseSlicemap keeps origin/provenance', slice.origin[0] === -3 && slice.sources.length === 1);
  check('slicemapSize = cols*r x rows*r', JSON.stringify(slicemapSize(slice)) === JSON.stringify({ sizeX: 3, sizeY: 2 }));
  const rects = occupiedRectangles(slice);
  check('3 rectangles (wall block merged over 2 rows, furniture, upper wall)', rects.length === 3, JSON.stringify(rects));
  const big = rects.find((x) => x.c0 === 0);
  check('lower wall merged vertically: cols 0..3 rows 0..2', big && big.c1 === 3 && big.r0 === 0 && big.r1 === 2 && big.code === 3);
  const { featureCollection, counts } = slicemapToObstacles(slice, { room: 'r1', importedAt: 't' });
  check('counts wall 2 / furniture 1', counts.wall === 2 && counts.furniture === 1);
  const wall = featureCollection.features.find((f) => f.geometry.coordinates[0][0][0] === 0 && f.geometry.coordinates[0][0][1] === 0);
  check('wall polygon in metres, closed ring, kind block', wall && JSON.stringify(wall.geometry.coordinates[0]) === '[[0,0],[1.5,0],[1.5,1],[0,1],[0,0]]' && wall.properties.kind === 'block' && wall.properties.category === 'wall');
  check('provenance carried on the collection', featureCollection.slicemap.origin[1] === -2 && featureCollection.slicemap.cols === 6);
  check('roomIdFromName sanitises', roomIdFromName('내 방/2026 05') !== '' && /^[a-zA-Z0-9_-]+$/.test(roomIdFromName('내 방/2026 05')) && roomIdFromName('project_20260905') === 'project_20260905');
  let threw = false; try { parseSlicemap({ format: 'nope' }); } catch { threw = true; } check('parseSlicemap rejects other formats', threw);
  threw = false; try { parseSlicemap({ ...doc, data: 'AAAA' }); } catch { threw = true; } check('parseSlicemap rejects wrong data length', threw);
}

// --- 2. 서버: from-slicemap + 자동 등록 (임시 PATHFINDER_DATA_DIR) ---
{
  const dataDir = await mkdtemp(join(tmpdir(), 'pf-scan-'));
  process.env.PATHFINDER_DATA_DIR = dataDir;
  const { createProjectsRouter } = await import('../server/projects.mjs');
  const { createRobotsRouter } = await import('../server/robots.mjs');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', await createProjectsRouter());
  const robotsRouter = await createRobotsRouter();
  app.use('/api', robotsRouter);
  const server = createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  let r = await api('POST', '/api/projects/from-slicemap', { name: 'scan test', slicemap: doc });
  check('from-slicemap creates the project sized to the grid', r.status === 201 && r.body.sizeX === 3 && r.body.sizeY === 2 && r.body.importedRoom === 'scan_test');
  check('response reports obstacle counts', r.body.featureCount === 3 && r.body.obstacleCounts.wall === 2);
  const projectId = r.body.id;
  const fc = JSON.parse(await readFile(join(dataDir, 'imported', 'scan_test.geojson'), 'utf-8'));
  check('imported geojson written under the data dir', fc.type === 'FeatureCollection' && fc.features.length === 3);
  r = await api('GET', `/api/projects/${projectId}`);
  check('project keeps slicemap provenance + importedRoom', r.body.importedRoom === 'scan_test' && r.body.slicemap.origin[0] === -3);
  // 바닥 이미지: 1x1 PNG, floor origin (-2, -1.5) @ 0.5 m -> 프로젝트 평면 extent = origin - slicemap origin (-3, -2)
  const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await api('POST', '/api/projects/from-slicemap', { name: 'with floor', slicemap: doc, floor: { png: 'data:image/png;base64,' + PNG_1x1, meta: { format: 'floor-image-v1', resolution: 0.5, origin: [-2, -1.5], width_px: 1, height_px: 1 } } });
  check('from-slicemap stores the floor image with a project-plane extent', r.status === 201 && r.body.floorImage?.url === '/api/imported-obstacles/with_floor/floor.png' && JSON.stringify(r.body.floorImage.extent) === '[1,0.5,1.5,1]');
  const floorBytes = await readFile(join(dataDir, 'imported', 'with_floor.floor.png'));
  check('floor png written', floorBytes.length > 20 && floorBytes.readUInt32BE(0) === 0x89504e47);
  const withFloorId = r.body.id;
  r = await api('PUT', `/api/projects/${withFloorId}/from-slicemap`, { slicemap: doc });
  check('PUT from-slicemap refreshes in place (same id, keeps floor, keeps name)', r.status === 200 && r.body.id === withFloorId && r.body.floorImage?.extent[0] === 1 && r.body.name === 'with floor');
  r = await api('POST', '/api/projects/from-slicemap', { name: 'bad floor', slicemap: doc, floor: { png: 'bm90IGEgcG5n', meta: { resolution: 0.5, origin: [0, 0], width_px: 1, height_px: 1 } } });
  check('non-PNG floor rejected', r.status === 400);
  r = await api('PUT', '/api/projects/nope/from-slicemap', { slicemap: doc });
  check('PUT from-slicemap 404 for unknown project', r.status === 404);
  r = await api('POST', '/api/projects/from-slicemap', { name: 'bad', slicemap: { format: 'x' } });
  check('from-slicemap validates', r.status === 400);
  r = await api('POST', '/api/projects/from-slicemap', { slicemap: doc });
  check('from-slicemap requires name', r.status === 400);

  // 삭제
  r = await api('DELETE', '/api/projects/default');
  check('DELETE rejects the default project', r.status === 400);
  r = await api('DELETE', '/api/projects/nope');
  check('DELETE 404 for unknown project', r.status === 404);
  r = await api('DELETE', `/api/projects/${projectId}`);
  check('DELETE removes the project', r.status === 204);
  r = await api('GET', `/api/projects/${projectId}`);
  check('deleted project is gone', r.status === 404);
  r = await api('GET', '/api/projects');
  check('project list no longer includes it', !r.body.some((p) => p.id === projectId));

  // 자동 등록
  const first = await robotsRouter.robots.ensureVda5050Robot('dcrobot', 'tb3-sim-09');
  check('ensureVda5050Robot creates a sim robot with TB3 size and agv icon', first.created && first.robot.vda5050Serial === 'tb3-sim-09' && first.robot.sizeMeters === 0.2 && first.robot.type === 'agv_amr' && first.robot.icon.startsWith('data:'));
  const again = await robotsRouter.robots.ensureVda5050Robot('dcrobot', 'tb3-sim-09');
  check('ensureVda5050Robot is idempotent', !again.created && again.robot.id === first.robot.id);
  const real = await robotsRouter.robots.ensureVda5050Robot('acme', 'former-01');
  check('non-sim robot gets default size and manufacturer as company', real.created && real.robot.sizeMeters !== 0.2 && real.robot.company === 'acme');
  r = await api('GET', '/api/robots');
  check('auto-registered robots are listed with vda5050 fields', r.body.some((x) => x.vda5050Serial === 'former-01' && x.vda5050Manufacturer === 'acme'));
  r = await api('POST', '/api/robots', { name: 'manual', vda5050Serial: ' s-1 ', vda5050Manufacturer: 'm' });
  check('POST /robots accepts and trims vda5050 fields', r.status === 201 && r.body.vda5050Serial === 's-1');
  r = await api('PUT', `/api/robots/${r.body.id}`, { vda5050Serial: '' });
  check('PUT /robots can clear the link', r.status === 200 && r.body.vda5050Serial === '' && r.body.vda5050Manufacturer === 'm');

  server.close();
  await rm(dataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall scan-project smoke checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
