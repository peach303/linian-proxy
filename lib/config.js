/**
 * Deno Deploy 侧的接入配置
 *
 * Key 只存在 Deno KV（或 Deno Deploy 环境变量）里：
 *   读状态 → 只回「配没配 + 尾号」；读配置 → 只在代理内部用来请求上游。
 * 前端永远拿不到明文。
 */
const KV_KEY = ['linian', 'integrations', 'v1']
let kvPromise = null
function kv() {
  if (!kvPromise) kvPromise = Deno.openKv()
  return kvPromise
}

export const DEFAULT_MINIMAX = { model: 'speech-2.8-hd', voiceId: 'male-qn-qingse', speed: 1 }
export const DEFAULT_SEARCH = { freshness: 'oneWeek', count: 5 }

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

export const maskKey = (k) => (k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '')

async function readSaved() {
  try {
    const r = await (await kv()).get(KV_KEY)
    return r.value || {}
  } catch {
    return {}
  }
}

export async function readConfig() {
  const saved = await readSaved()
  const sm = saved?.minimax ?? {}
  const ss = saved?.search ?? {}

  const mmKey = str(sm.apiKey)
  const envMmKey = str(Deno.env.get('MINIMAX_API_KEY'))
  const searchKey = str(ss.apiKey)
  const envSearchKey = str(Deno.env.get('SEARCH_API_KEY') || Deno.env.get('BOCHA_API_KEY'))

  return {
    minimax: {
      apiKey: mmKey || envMmKey,
      source: mmKey ? 'settings' : envMmKey ? 'env' : 'none',
      groupId: str(sm.groupId || Deno.env.get('MINIMAX_GROUP_ID')),
      model: str(sm.model || Deno.env.get('MINIMAX_MODEL')) || DEFAULT_MINIMAX.model,
      voiceId: str(sm.voiceId || Deno.env.get('MINIMAX_VOICE_ID')) || DEFAULT_MINIMAX.voiceId,
      speed: Math.max(0.5, Math.min(2, num(sm.speed, DEFAULT_MINIMAX.speed))),
    },
    search: {
      apiKey: searchKey || envSearchKey,
      source: searchKey ? 'settings' : envSearchKey ? 'env' : 'none',
      freshness: str(ss.freshness || Deno.env.get('SEARCH_FRESHNESS')) || DEFAULT_SEARCH.freshness,
      count: Math.max(1, Math.min(10, Math.round(num(ss.count, DEFAULT_SEARCH.count)))),
    },
  }
}

export function statusOf(conf) {
  return {
    minimax: {
      configured: Boolean(conf.minimax.apiKey),
      source: conf.minimax.source,
      hint: maskKey(conf.minimax.apiKey),
      groupId: conf.minimax.groupId,
      model: conf.minimax.model,
      voiceId: conf.minimax.voiceId,
      speed: conf.minimax.speed,
      defaults: DEFAULT_MINIMAX,
    },
    search: {
      configured: Boolean(conf.search.apiKey),
      source: conf.search.source,
      hint: maskKey(conf.search.apiKey),
      freshness: conf.search.freshness,
      count: conf.search.count,
      defaults: DEFAULT_SEARCH,
    },
  }
}

function safeEqual(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (!x || !y || x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/** 保存 / 断开必须带管理密码；密码只存在 Deno Deploy 环境变量里 */
export function verifyAdmin(req, body) {
  const expected = String(Deno.env.get('ADMIN_PASSWORD') || '')
  if (!expected) return { ok: false, error: 'ADMIN_NOT_SET' }
  const supplied = String(body?.adminPassword || req.headers.get('X-Admin-Password') || '')
  return safeEqual(supplied, expected) ? { ok: true } : { ok: false, error: 'BAD_ADMIN_PASSWORD' }
}

export async function saveConfig(patch) {
  let database
  try {
    database = await kv()
  } catch {
    return { ok: false, error: 'KV_NOT_BOUND' }
  }
  const saved = await readSaved()
  const cur = {
    minimax: { ...(saved?.minimax ?? {}) },
    search: { ...(saved?.search ?? {}) },
  }
  const mm = patch?.minimax ?? {}
  const sp = patch?.search ?? {}

  if (mm.clear) {
    cur.minimax = {}
  } else if (mm && Object.keys(mm).length) {
    if (typeof mm.apiKey === 'string' && mm.apiKey.trim()) cur.minimax.apiKey = mm.apiKey.trim()
    if (mm.removeKey) delete cur.minimax.apiKey
    if (typeof mm.groupId === 'string') cur.minimax.groupId = mm.groupId.trim()
    if (typeof mm.model === 'string' && mm.model.trim()) cur.minimax.model = mm.model.trim()
    if (typeof mm.voiceId === 'string' && mm.voiceId.trim()) cur.minimax.voiceId = mm.voiceId.trim()
    if (Number.isFinite(mm.speed)) cur.minimax.speed = Math.max(0.5, Math.min(2, Number(mm.speed)))
  }

  if (sp.clear) {
    cur.search = {}
  } else if (sp && Object.keys(sp).length) {
    if (typeof sp.apiKey === 'string' && sp.apiKey.trim()) cur.search.apiKey = sp.apiKey.trim()
    if (sp.removeKey) delete cur.search.apiKey
    if (typeof sp.freshness === 'string' && sp.freshness.trim()) cur.search.freshness = sp.freshness.trim()
    if (Number.isFinite(sp.count)) cur.search.count = Math.max(1, Math.min(10, Math.round(Number(sp.count))))
  }

  await database.set(KV_KEY, cur)
  return { ok: true, config: await readConfig() }
}
