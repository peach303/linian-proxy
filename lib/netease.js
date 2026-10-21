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

  const baseHeaders = {
    'User-Agent': UA,
    Referer: 'https://music.163.com/',
    Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.5',
  }
  // 浏览器音频第一次通常发 `Range: bytes=0-`，等于「整首」。
  // 有些镜像会因此开始传 10MB+，Deno 会超时（x-deno-error: DEPLOYMENT_TIMED_OUT），
  // 播放器也迟迟拿不到能解码的第一段。这里先只取 256KB，后面的区间由浏览器继续请求。
  const wantRange = String(range || '')
  const upstreamRange = wantRange === 'bytes=0-' ? 'bytes=0-262143' : wantRange
  const headers = upstreamRange ? { ...baseHeaders, Range: upstreamRange } : baseHeaders

  async function grab(url) {
    const res = await fetch(url, { redirect: 'follow', headers })
    const rawType = String(res.headers.get('content-type') || '')
    const type = rawType.split(';')[0].trim() || 'audio/mpeg'
    const contentRange = res.headers.get('content-range') || ''
    if (
      !res.ok ||
      /text\/html/i.test(rawType) ||
      (upstreamRange && res.status === 200 && !contentRange)
    ) {
      try {
        await res.body?.cancel()
      } catch {
        /* 已经关掉了 */
      }
      return {
        failed: { status: res.status, type: rawType, range: upstreamRange || '', url: res.url.slice(0, 180) },
      }
    }
    return {
      ok: true,
      status: res.status === 206 ? 206 : 200,
      body: res.body,
      type,
      length: res.headers.get('content-length') || '',
      contentRange,
      acceptRanges: res.headers.get('accept-ranges') || 'bytes',
    }
  }

  try {
    // ① 官方外链：会 302 到带签名的 CDN
    const first = await grab(`https://music.163.com/song/media/outer/url?id=${id}.mp3`)
    if (first.ok) return first

    // ② 有些地区 / 机房访问外链会跳 404：改问播放地址接口，再取 CDN
    const api = await fetch(`https://music.163.com/api/song/enhance/player/url?ids=%5B${id}%5D&br=320000`, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const info = await api.json().catch(() => null)
    const stream = info?.data?.[0]?.url
    if (stream) {
      const second = await grab(String(stream))
      if (second.ok) return second
    }

    // ③ 有些机房 IP 会被网易云整体拦掉（外链 404、播放地址也不给）：
    //    退到公开的 Meting 镜像，仍然由我们这边转发音频字节，不让页面跳走。
    const mirrors = [
      `https://api.injahow.cn/meting/?type=url&id=${id}`,
      `https://api.qijieya.cn/meting/?type=url&id=${id}`,
    ]
    const mirrorErrors = []
    for (const mirror of mirrors) {
      try {
        const third = await grab(mirror)
        if (third.ok) return third
        mirrorErrors.push(third.failed)
      } catch (e) {
        mirrorErrors.push(String(e?.message || e))
      }
    }

    return {
      ok: false,
      status: 404,
      error: 'NOT_AVAILABLE',
      detail: { first: first.failed, api: stream ? 'CDN_BLOCKED' : 'NO_URL', mirrors: mirrorErrors },
    }
  } catch (e) {
    return { ok: false, status: 502, error: 'UPSTREAM_ERROR', detail: String(e?.message || e) }
  }
}
