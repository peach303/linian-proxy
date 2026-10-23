/**
 * 音乐账号会话（网易云 / QQ 音乐）
 *
 * 目标：网页里永远不出现网易云 / QQ 的登录 Cookie。
 *  - 网页只拿到一个随机 `session` 令牌；
 *  - 真正的 Cookie 存在 Deno KV 里，带 180 天过期；
 *  - 播放音频时把 session 放进代理地址，代理再用 Cookie 换 VIP 播放地址。
 *
 * 网易云走扫码登录；QQ 音乐网页端没有稳定的公开扫码接口，走「登录后粘贴 Cookie」。
 * 两者都只保存 Cookie，不保存账号密码。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Linian/1.0'
const SESSION_DAYS = 180
const SESSION_KEY = (token) => ['linian', 'music', 'session', token]
const QR_KEY = (key) => ['linian', 'music', 'qr', key]

let kvPromise = null
function kv() {
  if (!kvPromise) kvPromise = Deno.openKv()
  return kvPromise
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())

function randomToken() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function cookiePairs(cookie) {
  const out = new Map()
  for (const part of String(cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out.set(k, v)
  }
  return out
}

function mergeCookies(...cookies) {
  const map = new Map()
  for (const c of cookies) {
    for (const [k, v] of cookiePairs(c)) map.set(k, v)
  }
  return Array.from(map, ([k, v]) => `${k}=${v}`).join('; ')
}

function setCookieFrom(res) {
  let list = []
  const h = res.headers
  if (typeof h.getSetCookie === 'function') list = h.getSetCookie()
  else {
    const raw = h.get('set-cookie') || ''
    if (raw) list = raw.split(/,(?=\s*[^;,=]+=)/)
  }
  return list.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────────────────── 会话存取 ───────────────────────── */

export async function saveSession(provider, cookie, profile = {}) {
  const token = randomToken()
  const record = {
    provider,
    cookie: String(cookie || ''),
    profile: {
      nickname: str(profile.nickname) || (provider === 'qq' ? 'QQ 音乐账号' : '网易云账号'),
      avatarUrl: str(profile.avatarUrl),
      userId: str(profile.userId),
      vip: Boolean(profile.vip),
    },
    createdAt: new Date().toISOString(),
  }
  await (await kv()).set(SESSION_KEY(token), record, { expireIn: SESSION_DAYS * 86400_000 })
  return { token, ...record.profile, provider }
}

export async function getSession(token) {
  const t = str(token)
  if (!t || !/^[a-f0-9]{32,96}$/i.test(t)) return null
  try {
    const r = await (await kv()).get(SESSION_KEY(t))
    return r.value || null
  } catch {
    return null
  }
}

export async function removeSession(token) {
  const t = str(token)
  if (!t) return false
  try {
    await (await kv()).delete(SESSION_KEY(t))
    return true
  } catch {
    return false
  }
}

/* ───────────────────────── 网易云：扫码登录 ───────────────────────── */

const NETEASE_HEADERS = () => ({
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
})

/** 第一步：拿二维码 key（二维码内容由前端渲染成图片） */
export async function neteaseQrStart() {
  try {
    const res = await fetch('https://music.163.com/api/login/qrcode/unikey?type=1', {
      headers: { ...NETEASE_HEADERS(), Cookie: 'os=pc; appver=8.9.70' },
      signal: AbortSignal.timeout(10_000),
    })
    const json = await res.json().catch(() => null)
    const key = str(json?.unikey)
    if (!key) return { ok: false, error: 'QR_START_FAILED', detail: `HTTP ${res.status}` }
    const cookie = setCookieFrom(res)
    await (await kv()).set(QR_KEY(key), { cookie, at: Date.now() }, { expireIn: 6 * 60_000 })
    return {
      ok: true,
      key,
      /** 网易云官方扫码登录地址；前端用 qrcode 画出来 */
      qr: `https://music.163.com/login?codekey=${encodeURIComponent(key)}`,
      expireSec: 300,
    }
  } catch (e) {
    return { ok: false, error: 'QR_START_FAILED', detail: String(e?.message || e) }
  }
}

/**
 * 第二步：轮询扫码结果
 *  - 801 等待扫码
 *  - 802 已扫码，等手机确认
 *  - 803 成功（Set-Cookie 里有 MUSIC_U）
 *  - 800 二维码过期
 */
export async function neteaseQrPoll(key) {
  const k = str(key)
  if (!k) return { ok: false, error: 'MISSING_KEY' }
  try {
    const saved = (await (await kv()).get(QR_KEY(k))).value
    const baseCookie = mergeCookies(saved?.cookie || '', 'os=pc; appver=8.9.70')
    const res = await fetch(
      `https://music.163.com/api/login/qrcode/client/login?key=${encodeURIComponent(k)}&type=1`,
      {
        headers: { ...NETEASE_HEADERS(), Cookie: baseCookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      },
    )
    const json = await res.json().catch(() => null)
    const code = Number(json?.code)
    const nextCookie = mergeCookies(baseCookie, setCookieFrom(res))
    if (nextCookie && saved) {
      await (await kv()).set(QR_KEY(k), { cookie: nextCookie, at: saved.at || Date.now() }, { expireIn: 6 * 60_000 })
    }
    if (code === 803) {
      if (!/(?:^|;\s*)MUSIC_U=/.test(nextCookie)) {
        return { ok: false, error: 'NO_MUSIC_U', detail: '登录成功但没拿到 MUSIC_U，请重试' }
      }
      const profile = await neteaseProfile(nextCookie)
      const session = await saveSession('netease', nextCookie, profile)
      await (await kv()).delete(QR_KEY(k)).catch(() => {})
      return { ok: true, status: 'ok', session: session.token, profile: session }
    }
    return {
      ok: true,
      status: code === 802 ? 'scanned' : code === 800 ? 'expired' : 'waiting',
      code,
    }
  } catch (e) {
    return { ok: false, error: 'QR_POLL_FAILED', detail: String(e?.message || e) }
  }
}

export async function neteaseProfile(cookie) {
  try {
    const res = await fetch('https://music.163.com/api/nuser/account/get', {
      headers: { ...NETEASE_HEADERS(), Cookie: cookie },
      signal: AbortSignal.timeout(10_000),
    })
    const j = await res.json().catch(() => null)
    const p = j?.profile ?? j?.account ?? {}
    const vip = Boolean(p.vipType && p.vipType > 0)
    return {
      nickname: str(p.nickname) || '网易云账号',
      avatarUrl: str(p.avatarUrl),
      userId: str(p.userId),
      vip,
    }
  } catch {
    return { nickname: '网易云账号', avatarUrl: '', userId: '', vip: false }
  }
}

/** 用账号 Cookie 换 VIP / 高音质播放地址；没权限时返回 null */
export async function neteaseAccountAudioUrl(songId, cookie) {
  const id = str(songId)
  if (!/^\d{4,}$/.test(id) || !cookie) return null
  const levels = ['lossless', 'exhigh', 'higher', 'standard']
  for (const level of levels) {
    try {
      const res = await fetch(
        `https://music.163.com/api/song/enhance/player/url/v1?ids=%5B${id}%5D&level=${level}&encodeType=flac`,
        {
          headers: { ...NETEASE_HEADERS(), Cookie: cookie },
          signal: AbortSignal.timeout(12_000),
        },
      )
      const j = await res.json().catch(() => null)
      const item = j?.data?.[0]
      if (item?.url) {
        return {
          url: String(item.url),
          level: str(item.level) || level,
          type: str(item.type) || 'mp3',
          size: Number(item.size) || 0,
        }
      }
    } catch {
      /* 换下一档 */
    }
  }
  return null
}

/* ───────────────────────── 网易云：歌词 ───────────────────────── */

/** 从 LRC 里截出可用的歌词句（去掉时间轴 / 作词作曲等制作信息） */
export async function neteaseLyric(songId) {
  const id = str(songId)
  if (!/^\d{4,}$/.test(id)) return { ok: false, error: 'BAD_SONG_ID' }
  try {
    const res = await fetch(
      `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
      { headers: NETEASE_HEADERS(), signal: AbortSignal.timeout(12_000) },
    )
    const j = await res.json().catch(() => null)
    const raw = str(j?.lrc?.lyric)
    if (!raw) return { ok: false, error: 'NO_LYRIC' }
    const seen = new Set()
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\[[^\]]*\]/g, '').trim())
      .filter((line) => {
        if (!line || line.length < 3 || line.length > 48) return false
        if (/^(作词|作曲|编曲|制作|混音|母带|录音|吉他|贝斯|鼓|和声|监制|出品|发行|词|曲)/.test(line)) return false
        // 制作名单里的「键盘 : 某某」「特别支持：某某」等（冒号前是角色名）
        if (/^[^：:]{1,12}\s*[:：]/.test(line)) return false
        if (/^[\d\s:.]+$/.test(line)) return false
        if (seen.has(line)) return false
        seen.add(line)
        return true
      })
      .slice(0, 160)
    if (!lines.length) return { ok: false, error: 'NO_LYRIC' }
    return { ok: true, songId: id, lines }
  } catch (e) {
    return { ok: false, error: 'LYRIC_FAILED', detail: String(e?.message || e) }
  }
}

/** QQ 音乐歌词：公开 LRC 接口，不需要登录；只取唱词，不要制作名单 */
export async function qqLyric(songMid) {
  const mid = str(songMid)
  if (!/^[0-9A-Za-z]{10,20}$/.test(mid)) return { ok: false, error: 'BAD_SONG_MID' }
  try {
    const res = await fetch(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://y.qq.com/',
        },
        signal: AbortSignal.timeout(12_000),
      },
    )
    const j = await res.json().catch(() => null)
    const raw = str(j?.lyric)
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
    if (!raw) return { ok: false, error: 'NO_LYRIC' }
    const seen = new Set()
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\[[^\]]*\]/g, '').trim())
      .filter((line) => {
        if (!line || line.length < 3 || line.length > 48) return false
        if (/^(作词|作曲|编曲|制作|混音|母带|录音|吉他|贝斯|鼓|和声|监制|出品|发行|词|曲)/.test(line)) return false
        if (/^[^：:]{1,12}\s*[:：]/.test(line)) return false
        if (/^[\d\s:.]+$/.test(line)) return false
        // QQ 的 LRC 有时把「歌名 - 歌手」也留在第一行
        if (line.length <= 40 && /\s[-–—]\s/.test(line)) return false
        if (seen.has(line)) return false
        seen.add(line)
        return true
      })
      .slice(0, 160)
    if (!lines.length) return { ok: false, error: 'NO_LYRIC' }
    return { ok: true, songMid: mid, lines }
  } catch (e) {
    return { ok: false, error: 'LYRIC_FAILED', detail: String(e?.message || e) }
  }
}

/* ───────────────────────── QQ 音乐：Cookie 登录 + 播放地址 ───────────────────────── */

function qqUin(cookie) {
  const map = cookiePairs(cookie)
  const raw =
    map.get('uin') ||
    map.get('qqmusic_uin') ||
    map.get('p_uin') ||
    map.get('euin') ||
    ''
  const m = String(raw).match(/(\d{5,})/)
  return m ? m[1] : ''
}

export async function qqLoginWithCookie(cookie) {
  const c = str(cookie)
  if (!c) return { ok: false, error: 'MISSING_COOKIE' }
  if (!/qqmusic_key|qm_keyst|uin=/.test(c)) {
    return { ok: false, error: 'BAD_COOKIE', detail: 'Cookie 里没有 qqmusic_key / qm_keyst / uin' }
  }
  const uin = qqUin(c)
  const session = await saveSession('qq', c, {
    nickname: uin ? `QQ 音乐 · ${uin.slice(-4)}` : 'QQ 音乐账号',
    userId: uin,
  })
  return { ok: true, session: session.token, profile: session }
}

/** QQ 音乐分享链接 / songmid */
export function qqMidFromInput(input) {
  const s = String(input ?? '').trim()
  if (/^(?=.*\d)(?=.*[A-Za-z])[0-9A-Za-z]{12,20}$/.test(s)) return s
  const m =
    s.match(/songDetail\/([0-9A-Za-z]{10,20})/) ??
    s.match(/[?&]songmid=([0-9A-Za-z]{10,20})/) ??
    s.match(/[?&]mid=([0-9A-Za-z]{10,20})/)
  return m ? m[1] : null
}

export async function resolveQQMusic(input) {
  const mid = qqMidFromInput(input)
  if (!mid) return null
  try {
    const res = await fetch(
      `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(mid)}&format=json&platform=yqq`,
      {
        headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
        signal: AbortSignal.timeout(10_000),
      },
    )
    const j = await res.json().catch(() => null)
    const song = Array.isArray(j?.data) ? j.data[0] : j?.data
    if (!song) return { songMid: mid, title: '', artist: '', cover: '' }
    const albumMid = song.album?.mid || song.albummid || ''
    return {
      songMid: mid,
      title: str(song.name || song.title),
      artist: (song.singer ?? []).map((x) => str(x.name)).filter(Boolean).join(' / '),
      cover: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
    }
  } catch {
    return null
  }
}

/** 用 QQ Cookie 换 vkey（VIP 账号能拿到 VIP 曲目的 purl） */
export async function qqAudioUrl(songMid, cookie) {
  const mid = str(songMid)
  if (!/^[0-9A-Za-z]{10,20}$/.test(mid)) return null
  const uin = qqUin(cookie)
  const guid = String(Math.floor(1_000_000_000 + Math.random() * 8_000_000_000))
  const body = {
    req_0: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        guid,
        songmid: [mid],
        songtype: [0],
        uin: uin || '0',
        loginflag: 1,
        platform: '20',
      },
    },
    comm: { uin: uin || '0', format: 'json', ct: 24, cv: 0 },
  }
  try {
    const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://y.qq.com/',
        Origin: 'https://y.qq.com',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    })
    const j = await res.json().catch(() => null)
    const info = j?.req_0?.data?.midurlinfo?.[0]
    const purl = str(info?.purl)
    if (!purl) return null
    return {
      url: /^https?:\/\//i.test(purl) ? purl : `https://ws.stream.qqmusic.qq.com/${purl}`,
      level: str(info?.filename) ? 'qq' : 'qq',
    }
  } catch {
    return null
  }
}
