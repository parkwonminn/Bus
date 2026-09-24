/**
 * Cloudflare Worker — 통학버스 동선 계산기 프록시
 *
 * 설정할 값 (wrangler secret / 대시보드 환경변수)
 *   KAKAO_REST_KEY : 카카오 REST API 키 (반드시 secret 으로)
 *   ALLOW_ORIGIN   : 허용할 출처. 쉼표로 여러 개.
 *                    예) https://myid.github.io,http://127.0.0.1:8777
 *
 * 배포:  npx wrangler deploy
 *        npx wrangler secret put KAKAO_REST_KEY
 */
import { handle, ApiError } from './lib.mjs';

function corsHeaders(req, env){
  const allow = (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const ok = allow.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allow[0] || ''),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    _ok: ok
  };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const h = corsHeaders(req, env);
    const cors = { ...h }; delete cors._ok;
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
      });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // 출처 검사: 브라우저 요청인데 허용 목록에 없으면 막는다
    const origin = req.headers.get('Origin');
    if (origin && !h._ok) return json({ error: '허용되지 않은 출처입니다.' }, 403);

    if (req.method !== 'POST' && url.pathname !== '/api/health')
      return json({ error: 'POST 만 받습니다.' }, 405);

    try {
      const bodyText = req.method === 'POST' ? await req.text() : '';
      const out = await handle(url.pathname, bodyText, env.KAKAO_REST_KEY);
      return json(out);
    } catch (e){
      const status = e instanceof ApiError ? e.status : 500;
      return json({ error: e.message || '서버 오류' }, status);
    }
  }
};
