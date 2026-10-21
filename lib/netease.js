/** 网易云元信息 + 公开音频流代理 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Linian/1.0'

function neteaseIdFromInput(input) {
  const s = String(input ?? '').trim()
  if (/^\d{4,}$/.test(s)) return s
  const m =
    s.match(/[?&]id=(\d+)/) ??
    s.match(/song\/(\d+)/) ??
    s.match(/[?&]songid=(\d+)/i) ??
    s.match(/"songId"\s*:\s*(\d+)/)
  return m ? m[1] : null
}

export async function resolveNetease(input) {
  try {
    let id = neteaseIdFromInput(input)
    if (!id && /^https?:\/\//i.test(String(input))) {
      const r = await fetch(String(input), {
        redirect: 'follow',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      })
      id = neteaseIdFromInput(r.url) ?? neteaseIdFromInput((await r.text()).slice(0, 30000))
    }
    if (!id) return null

    const blank = { songId: id, title: '', artist: '', cover: undefined }
    const res = await fetch(`https://music.163.com/api/song/detail/?ids=%5B${id}%5D`, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return blank
    const j = await res.json()
    const song = j?.songs?.[0]
    if (!song) return blank
    return {
      songId: String(song.id ?? id),
      title: song.name ?? '',
      artist: (song.artists ?? []).map((a) => a.name).filter(Boolean).join(' / '),
      cover: song.album?.picUrl ?? song.artists?.[0]?.picUrl,
    }
  } catch {
    return null
  }
}

/**
 * 网易云公开音频流。
 * `song/media/outer` 会 302 到带签名的 CDN；这里跟随跳转，并把 Range 原样透传，
 * 所以浏览器里的 `<audio>` 可以 seek，也能按真实播放时间累计「一起听了多久」。
 *
 * 版权 / VIP / 地区受限的曲子会跳回 404 页面（text/html），这里返回 ok:false，
 * 前端会显示「这首播不了」，不假装在放。
 */
export async function proxyNeteaseAudio(songId, range) {
  const id = String(songId ?? '').trim()
  if (!/^\d{4,}$/.test(id)) return { ok: false, status: 400, error: 'BAD_SONG_ID' }

  const headers = {
    'User-Agent': UA,
    Referer: 'https://music.163.com/',
    Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.5',
  }
  if (range) headers.Range = range

  try {
    const res = await fetch(`https://music.163.com/song/media/outer/url?id=${id}.mp3`, {
      redirect: 'follow',
      headers,
    })
    const type = String(res.headers.get('content-type') || '')
    if (!res.ok || /text\/html/i.test(type)) {
      try {
        await res.body?.cancel()
      } catch {
        /* 已经关掉了 */
      }
      return { ok: false, status: 404, error: 'NOT_AVAILABLE' }
    }
    return {
      ok: true,
      status: res.status === 206 ? 206 : 200,
      body: res.body,
      type: type || 'audio/mpeg',
      length: res.headers.get('content-length') || '',
      contentRange: res.headers.get('content-range') || '',
      acceptRanges: res.headers.get('accept-ranges') || 'bytes',
    }
  } catch (e) {
    return { ok: false, status: 502, error: 'UPSTREAM_ERROR', detail: String(e?.message || e) }
  }
}
