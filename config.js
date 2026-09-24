/**
 * 배포 설정 — 이 파일만 고치면 됩니다.
 *
 * PROXY_URL     프록시 주소. 끝에 / 를 붙이지 마세요.
 *               로컬 개발:  http://127.0.0.1:8788
 *               Cloudflare: https://bus-route-proxy.<계정>.workers.dev
 *
 * KAKAO_JS_KEY  카카오 지도 JavaScript 키.
 *               REST 키와 다른 키입니다. 도메인 제한이 걸리므로 공개되어도 괜찮습니다.
 *               카카오 개발자 콘솔 > 내 애플리케이션 > 플랫폼 > Web 에
 *               배포 주소(https://<아이디>.github.io)를 반드시 등록하세요.
 */
window.APP_CONFIG = {
  PROXY_URL: 'http://127.0.0.1:8788',
  KAKAO_JS_KEY: '098d0417be7c6ea9dbd833fb19b94151'
};
