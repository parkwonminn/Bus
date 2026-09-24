/**
 * 카카오모빌리티 길찾기 API 래퍼.
 * REST 키는 이 파일을 실행하는 서버에만 존재하며 브라우저로 나가지 않는다.
 *
 * 사용 API
 *  - 다중 경유지 길찾기  POST https://apis-navi.kakaomobility.com/v1/waypoints/directions   (경유지 최대 30)
 *  - 다중 목적지 길찾기  POST https://apis-navi.kakaomobility.com/v1/destinations/directions (목적지 최대 30, radius 최대 10km)
 *  - 주소 검색          GET  https://dapi.kakao.com/v2/local/search/address.json
 *  - 키워드 검색        GET  https://dapi.kakao.com/v2/local/search/keyword.json
 */

const NAVI  = 'https://apis-navi.kakaomobility.com/v1';
const LOCAL = 'https://dapi.kakao.com/v2/local';

export const MAX_STOPS = 20;          // 경유지 30 제한 + 행렬 호출량을 고려한 자체 상한
const MATRIX_GAP = 120;               // 행렬 호출 간 간격(ms)
const RADIUS_MAX = 10000;             // 다중 목적지 API 의 radius 상한

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 공통 ---------- */
class ApiError extends Error {
  constructor(msg, status = 502){ super(msg); this.status = status; }
}

async function kakao(url, key, init = {}){
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `KakaoAK ${key}` }
  });
  const text = await res.text();
  if (!res.ok){
    // 어느 API 가 거절했는지, 카카오가 뭐라고 했는지 그대로 전한다.
    // (둘을 뭉뚱그리면 주소 검색 문제를 길찾기 문제로 오진하게 된다)
    const which = url.includes('dapi.kakao.com') ? '카카오 로컬(주소 검색)' : '카카오모빌리티(길찾기)';
    let detail = '';
    try { detail = JSON.parse(text)?.message || JSON.parse(text)?.msg || ''; } catch {}

    if (/disabled OPEN_MAP_AND_LOCAL/i.test(detail))
      throw new ApiError('카카오 개발자 콘솔에서 이 앱의 "카카오맵" 서비스가 꺼져 있습니다. ' +
                         '내 애플리케이션 > 앱 설정 > 앱 키 옆 카카오맵(로컬) 사용을 켜 주세요.', 502);
    if (res.status === 401)
      throw new ApiError(`${which} 인증 실패: REST 키가 거부되었습니다.${detail ? ' — ' + detail : ''}`, 502);
    if (res.status === 403)
      throw new ApiError(`${which} 사용 권한이 없습니다.${detail ? ' — ' + detail : ''}`, 502);
    if (res.status === 429)
      throw new ApiError(`${which} 호출 한도를 초과했습니다.`, 429);
    throw new ApiError(`${which} 오류 (${res.status})${detail ? ' — ' + detail : ''}`, 502);
  }
  try { return JSON.parse(text); }
  catch { throw new ApiError('카카오 API 응답을 해석하지 못했습니다.'); }
}

export function haversine(a, b){
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- 도로 등급 ---------- */
/**
 * 한국 도로명 접미사로 폭을 추정한다.
 *   ~대로            간선도로            big
 *   ~로              일반도로            mid
 *   ~길 / ~N번길     이면도로 · 골목      alley
 * 카카오 응답의 도로명은 실제 도로명주소 체계를 따르므로 이 규칙이 잘 맞는다.
 */
export function roadClass(name){
  if (!name) return 'unknown';
  if (/\d+번?길$/.test(name)) return 'alley';   // 세종대로20길, 불광로12번길
  if (/대로$/.test(name)) return 'big';
  if (/로$/.test(name))   return 'mid';
  if (/길$/.test(name))   return 'alley';
  return 'unknown';
}
const NARROW_SPEED = 20;   // 이름을 알 수 없는 도로는 이 속도 미만일 때만 골목으로 본다

function isNarrow(road){
  const cls = roadClass(road.name);
  if (cls === 'alley') return true;
  if (cls === 'big' || cls === 'mid') return false;
  return road.traffic_speed > 0 && road.traffic_speed < NARROW_SPEED;
}

/* ---------- 주소 → 좌표 ---------- */
const KEYWORD_RADIUS = 20000;   // 카카오 키워드 검색의 radius 상한

/**
 * 주소 → 좌표.
 * near 를 주면 키워드 검색을 그 주변으로 제한한다.
 * 제한이 없으면 '갈현동주민센터' 같은 질의가 다른 시·도의 동명 장소를 조용히 돌려준다.
 * 통학 노선에서 정류장이 수십 km 밖에 찍히는 사고를 막기 위한 장치다.
 */
export async function geocode(q, key, near = null){
  const query = String(q || '').trim();
  if (!query) throw new ApiError('주소가 비어 있습니다.', 400);

  const addr = await kakao(`${LOCAL}/search/address.json?query=${encodeURIComponent(query)}&size=1`, key);
  if (addr.documents?.length){
    const d = addr.documents[0];
    return { name: d.road_address?.address_name || d.address_name || query, lat: +d.y, lng: +d.x };
  }

  // 주소로 안 잡히면 장소 이름으로 한 번 더 (유치원·아파트 이름 등)
  let url = `${LOCAL}/search/keyword.json?query=${encodeURIComponent(query)}&size=1`;
  const hasNear = Number.isFinite(near?.lat) && Number.isFinite(near?.lng);
  // radius 로 지역만 좁히고 정렬은 관련도(기본값)로 둔다.
  // sort=distance 를 주면 '역촌역' 이 역이 아니라 역 앞 식당으로 잡힌다.
  if (hasNear) url += `&x=${near.lng}&y=${near.lat}&radius=${KEYWORD_RADIUS}`;

  let kw = await kakao(url, key);
  if (!kw.documents?.length && hasNear){
    // 주변에 없으면 전국으로 넓히되, 멀리 잡혔다는 사실을 이름에 남긴다
    kw = await kakao(`${LOCAL}/search/keyword.json?query=${encodeURIComponent(query)}&size=1`, key);
    if (kw.documents?.length){
      const d = kw.documents[0];
      const far = haversine(near, { lat:+d.y, lng:+d.x });
      if (far > KEYWORD_RADIUS / 1000)
        throw new ApiError(
          `'${query}' 은(는) 다른 지역에서만 찾았습니다 (${d.place_name}, 약 ${Math.round(far)}km 떨어짐). ` +
          `정확한 주소로 바꾸거나 '이름 @ 위도,경도' 형식으로 넣어 주세요.`, 404);
    }
  }
  if (kw.documents?.length){
    const d = kw.documents[0];
    return { name: d.place_name || query, lat: +d.y, lng: +d.x };
  }
  throw new ApiError(`주소를 찾지 못했습니다: ${query}`, 404);
}

/* ---------- 거리·시간 행렬 ---------- */
/**
 * 다중 목적지 API 를 출발지마다 한 번씩 호출해 N×N 행렬을 만든다.
 * radius 밖이거나 실패한 칸은 직선거리 추정으로 메우고 approx 로 표시한다.
 */
export async function matrix(points, opts, key){
  const n = points.length;
  let maxKm = 0;
  for (const a of points) for (const b of points) maxKm = Math.max(maxKm, haversine(a, b));
  const radius = Math.min(RADIUS_MAX, Math.max(1000, Math.ceil(maxKm * 1000 * 1.6)));

  const dist = Array.from({ length: n }, () => Array(n).fill(0));
  const dur  = Array.from({ length: n }, () => Array(n).fill(0));
  let approxCells = 0;

  for (let i = 0; i < n; i++){
    const destinations = points
      .map((p, j) => ({ key: String(j), x: p.lng, y: p.lat }))
      .filter((_, j) => j !== i);

    let routes = [];
    try {
      const body = {
        origin: { x: points[i].lng, y: points[i].lat },
        destinations, radius,
        priority: opts.priority === 'DISTANCE' ? 'DISTANCE' : 'TIME',
        ...(opts.avoid?.length ? { avoid: opts.avoid } : {})
      };
      const res = await kakao(`${NAVI}/destinations/directions`, key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      routes = res.routes || [];
    } catch (e){
      if (e.status === 429) throw e;      // 한도 초과는 그대로 올린다
      routes = [];
    }

    const got = new Map();
    for (const r of routes){
      if (r.result_code === 0 && r.summary) got.set(r.key, r.summary);
    }
    for (let j = 0; j < n; j++){
      if (i === j) continue;
      const s = got.get(String(j));
      if (s){
        dist[i][j] = s.distance / 1000;
        dur[i][j]  = s.duration / 60;
      } else {
        const km = haversine(points[i], points[j]) * 1.32;
        dist[i][j] = km;
        dur[i][j]  = km / 26 * 60;
        approxCells++;
      }
    }
    if (i < n - 1) await sleep(MATRIX_GAP);
  }
  return { dist, dur, approxCells, radius };
}

/* ---------- 실제 주행 경로 ---------- */
/**
 * 정해진 순서대로 다중 경유지 길찾기를 한 번 호출한다.
 * 구간(section)마다 도로 목록을 훑어 좁은 길 비율과 지도에 그릴 선분을 만든다.
 */
export async function route(points, opts, key){
  if (points.length < 2) throw new ApiError('지점이 2개 이상 필요합니다.', 400);
  const body = {
    origin:      { x: points[0].lng, y: points[0].lat, name: points[0].name || '출발' },
    destination: { x: points[points.length-1].lng, y: points[points.length-1].lat,
                   name: points[points.length-1].name || '도착' },
    waypoints: points.slice(1, -1).map((p, i) => ({ x: p.lng, y: p.lat, name: p.name || `경유${i+1}` })),
    priority: ['RECOMMEND','TIME','DISTANCE'].includes(opts.priority) ? opts.priority : 'RECOMMEND',
    road_details: true,
    ...(opts.avoid?.length ? { avoid: opts.avoid } : {})
  };
  const res = await kakao(`${NAVI}/waypoints/directions`, key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const rt = res.routes?.[0];
  if (!rt) throw new ApiError('경로를 받지 못했습니다.');
  if (rt.result_code !== 0) throw new ApiError(`경로 탐색 실패: ${rt.result_msg || rt.result_code}`);

  const legs = (rt.sections || []).map(sec => {
    const segs = [], roads = [];
    let narrowM = 0, totalM = 0;
    for (const road of (sec.roads || [])){
      const v = road.vertexes || [];
      const coords = [];
      for (let i = 0; i + 1 < v.length; i += 2) coords.push({ lng: v[i], lat: v[i+1] });
      if (coords.length < 2) continue;
      const narrow = isNarrow(road);
      // 도로명과 등급을 함께 넘긴다. 클라이언트가 추가 호출 없이
      // 이 경로 위의 큰 길 좌표를 골라 정류장 이동을 제안하는 데 쓴다.
      segs.push({ coords, narrow, name: road.name || '', cls: roadClass(road.name) });
      totalM += road.distance || 0;
      if (narrow) narrowM += road.distance || 0;
      if (road.name && !roads.includes(road.name)) roads.push(road.name);
    }
    return {
      distance: (sec.distance || 0) / 1000,
      duration: (sec.duration || 0) / 60,
      narrowRatio: totalM ? narrowM / totalM : 0,
      segs, roads
    };
  });

  return {
    legs,
    summary: {
      distance: (rt.summary?.distance || 0) / 1000,
      duration: (rt.summary?.duration || 0) / 60,
      tollFare: rt.summary?.fare?.toll ?? null
    }
  };
}

/* ---------- 요청 라우팅 (worker / node 공용) ---------- */
export async function handle(path, bodyText, key){
  // health 는 키 없이도 답한다. 연결 문제와 키 문제를 구분할 수 있어야 한다.
  if (path === '/api/health') return { ok: true, key: !!key };

  // 경로와 입력을 먼저 본다. 키 검사를 앞에 두면 404·400 이 전부 500 으로 가려진다.
  if (!['/api/geocode', '/api/matrix', '/api/route'].includes(path))
    throw new ApiError('없는 경로입니다.', 404);

  let body = {};
  if (bodyText){
    try { body = JSON.parse(bodyText); }
    catch { throw new ApiError('요청 본문이 올바른 JSON 이 아닙니다.', 400); }
  }
  const pts = Array.isArray(body.points) ? body.points : [];
  if (pts.length > MAX_STOPS) throw new ApiError(`지점은 최대 ${MAX_STOPS}개까지입니다.`, 400);
  for (const p of pts){
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) throw new ApiError('좌표 형식이 잘못되었습니다.', 400);
  }
  if ((path === '/api/matrix' || path === '/api/route') && pts.length < 2)
    throw new ApiError('지점이 2개 이상 필요합니다.', 400);

  if (!key) throw new ApiError('서버에 KAKAO_REST_KEY 가 설정되지 않았습니다.', 500);

  switch (path){
    case '/api/geocode': return geocode(body.q, key, body.near || null);
    case '/api/matrix':  return matrix(pts, body, key);
    case '/api/route':   return route(pts, body, key);
    default: throw new ApiError('없는 경로입니다.', 404);
  }
}

export { ApiError };
