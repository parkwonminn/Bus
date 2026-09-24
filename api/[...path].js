/**
 * Vercel 서버리스 함수 — 통학버스 동선 계산기 프록시
 *
 * /api/geocode, /api/matrix, /api/route, /api/health 를 모두 이 파일이 받는다.
 * REST 키는 Vercel 환경변수에만 두고 브라우저로 내려보내지 않는다.
 *
 * 필요한 환경변수 (Vercel 대시보드 > Settings > Environment Variables)
 *   KAKAO_REST_KEY : 카카오 REST API 키           (필수)
 *   ALLOW_ORIGIN   : 다른 도메인에서도 부를 경우만 (선택, 쉼표로 여러 개)
 *                    같은 도메인에서만 쓰면 설정할 필요 없음
 */
import { handle, ApiError } from '../proxy/lib.mjs';

export const config = { runtime: 'edge' };

function corsFor(req){
  const origin = req.headers.get('Origin');
  // 같은 출처 요청은 Origin 이 없거나 자기 자신 -> CORS 헤더가 필요 없다
  if (!origin) return { headers: {}, allowed: true };

  const self = new URL(req.url).origin;
  const allow = (process.env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowed = origin === self || allow.includes(origin);
  return {
    allowed,
    headers: {
      'Access-Control-Allow-Origin': allowed ? origin : self,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    }
  };
}

export default async function handler(req){
  const { headers: cors, allowed } = corsFor(req);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
  });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!allowed) return json({ error: '허용되지 않은 출처입니다.' }, 403);

  const path = new URL(req.url).pathname;
  if (req.method !== 'POST') return json({ error: 'POST 만 받습니다.' }, 405);

  try {
    const bodyText = await req.text();
    return json(await handle(path, bodyText, process.env.KAKAO_REST_KEY));
  } catch (e){
    return json({ error: e.message || '서버 오류' }, e instanceof ApiError ? e.status : 500);
  }
}
