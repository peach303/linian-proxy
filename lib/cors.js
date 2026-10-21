/**
 * Deno Deploy 免费代理的 CORS / JSON 小工具
 * 只给黎念的静态站和本机调试地址用；部署时可用 ALLOWED_ORIGIN 覆盖。
 */
const DEFAULT_ORIGINS = [
  'https://peach303.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:4174',
  'http://127.0.0.1:4174',
  'http://localhost:4175',
  'http://127.0.0.1:4175',
]

export function corsHeaders(req) {
  const origin = req.headers.get('origin') || ''
  const configured = String(Deno.env.get('ALLOWED_ORIGIN') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const allowed = configured.length ? configured : DEFAULT_ORIGINS
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  const allow = allowed.includes(origin) || isLocal ? origin : allowed[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Password,Range',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function json(req, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
      ...extra,
    },
  })
}

export function preflight(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}

export async function readJson(req) {
  try {
    return await req.json()
  } catch {
    return null
  }
}
