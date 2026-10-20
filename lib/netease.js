/** 网易云元信息：只取歌名 / 歌手 / 封面，音频不经过代理 */
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
