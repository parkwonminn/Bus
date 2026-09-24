/**
 * 로컬 개발용 프록시 (Node 18+)
 *
 *   set KAKAO_REST_KEY=발급받은키        (PowerShell: $env:KAKAO_REST_KEY="키")
 *   node proxy/server.mjs
 *
 * 자체 점검:
 *   node proxy/server.mjs --selftest     키가 살아있는지, 실제 경로가 나오는지 확인
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, ApiError, geocode, matrix, route } from './lib.mjs';

/* proxy/.env 가 있으면 읽어 환경변수로 넣는다 (키를 명령줄에 노출하지 않기 위해). */
function loadEnvFile(){
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)){
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile();

const KEY  = process.env.KAKAO_REST_KEY || '';
const PORT = +(process.env.PORT || 8788);
const ALLOW = (process.env.ALLOW_ORIGIN || 'http://127.0.0.1:8777,http://localhost:8777')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ---------- 자체 점검 ---------- */
if (process.argv.includes('--selftest')){
  if (!KEY){ console.error('KAKAO_REST_KEY 환경변수가 없습니다.'); process.exit(1); }
  const log = (...a) => console.log(...a);
  const fails = [];
  // 한 단계가 막혀도 나머지는 계속 본다. 어디까지 되는지 알아야 고칠 수 있다.
  const step = async (name, fn) => {
    try { await fn(); return true; }
    catch (e){ log(`   실패 — ${e.message}`); fails.push(name); return false; }
  };

  // 주소 검색이 막혀 있어도 뒤 단계를 확인할 수 있도록 좌표 기본값을 둔다
  let seoul = { name:'서울시청', lat:37.566826, lng:126.978656 };

  log('1) 주소 검색 (카카오 로컬)…');
  await step('주소 검색', async () => {
    const a = await geocode('서울 중구 세종대로 110', KEY);
    seoul = a;
    log(`   OK  ${a.name}  (${a.lat.toFixed(6)}, ${a.lng.toFixed(6)})`);
  });

  const pts = [seoul,
    { name:'강남역',   lat:37.497942, lng:127.027621 },
    { name:'홍대입구', lat:37.557192, lng:126.925381 }];

  log('2) 거리·시간 행렬 (카카오모빌리티 다중 목적지)…');
  await step('거리 행렬', async () => {
    const M = await matrix(pts, { priority:'TIME' }, KEY);
    log(`   OK  radius=${M.radius}m  추정으로 메운 칸=${M.approxCells}`);
    for (let i = 0; i < pts.length; i++)
      log('   ' + pts[i].name.padEnd(9) + M.dist[i].map(v => v.toFixed(1).padStart(7)).join(''));
  });

  log('3) 실제 주행 경로 (카카오모빌리티 다중 경유지)…');
  await step('주행 경로', async () => {
    const R = await route(pts, { priority:'RECOMMEND', avoid:['uturn','motorway'] }, KEY);
    log(`   OK  총 ${R.summary.distance.toFixed(2)}km / ${R.summary.duration.toFixed(1)}분, 구간 ${R.legs.length}개`);
    R.legs.forEach((l, i) =>
      log(`   구간${i+1} ${l.distance.toFixed(2)}km 골목 ${(l.narrowRatio*100).toFixed(0)}% | ${l.roads.slice(0,6).join(', ')}`));
    const nk = R.legs.reduce((s, l) => s + l.distance * l.narrowRatio, 0);
    log(`   전체 골목 주행 ${nk.toFixed(2)}km (${(nk / R.summary.distance * 100).toFixed(0)}%)`);
  });

  if (!fails.length){
    log('\n자체 점검 통과 — 키와 API 사용 설정이 모두 정상입니다.');
    process.exit(0);
  }
  log(`\n자체 점검 결과: ${fails.join(', ')} 단계 실패.`);
  if (fails.includes('주소 검색') && fails.length === 1)
    log('길찾기는 정상입니다. 주소 검색만 켜면 됩니다 — 그 전까지는 "이름 @ 위도,경도" 형식으로 입력하면 동작합니다.');
  process.exit(1);
}

/* ---------- 서버 ---------- */
if (!KEY) console.warn('경고: KAKAO_REST_KEY 가 비어 있습니다. 모든 요청이 500 으로 응답합니다.');

http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const ok = !origin || ALLOW.includes(origin);
  const head = {
    'Access-Control-Allow-Origin': ok ? (origin || ALLOW[0]) : ALLOW[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  };
  const send = (obj, status = 200) => { res.writeHead(status, head); res.end(JSON.stringify(obj)); };

  if (req.method === 'OPTIONS'){ res.writeHead(204, head); return res.end(); }
  if (origin && !ok) return send({ error: '허용되지 않은 출처입니다.' }, 403);

  const path = new URL(req.url, 'http://x').pathname;
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const t0 = Date.now();
    const out = await handle(path, body, KEY);
    console.log(`${req.method} ${path} -> 200 (${Date.now() - t0}ms)`);
    send(out);
  } catch (e){
    const status = e instanceof ApiError ? e.status : 500;
    console.log(`${req.method} ${path} -> ${status}  ${e.message}`);
    send({ error: e.message || '서버 오류' }, status);
  }
}).listen(PORT, () => {
  console.log(`프록시 실행 중: http://127.0.0.1:${PORT}`);
  console.log(`허용 출처: ${ALLOW.join(', ')}`);
  console.log(KEY ? 'KAKAO_REST_KEY 설정됨' : 'KAKAO_REST_KEY 없음 (--selftest 로 먼저 확인하세요)');
});
