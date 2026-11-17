/**
 * Cloudflare Pages Function — /api/rank (연구원별 기여도 순위)
 * 공유 카운터는 Worker(stir-evolve)의 Durable Object가 들고 있으므로,
 * Pages로 들어온 요청을 서비스 바인딩(STIR_API)으로 그대로 전달합니다.
 * Pages 프로젝트 설정 → Bindings 에서 STIR_API = 서비스 'stir-evolve' 로 연결해야 합니다.
 */
export async function onRequest({ request, env }) {
  if (!env.STIR_API) {
    return Response.json({ error: 'STIR_API service binding is not configured' }, { status: 503 });
  }
  return env.STIR_API.fetch(request);
}
