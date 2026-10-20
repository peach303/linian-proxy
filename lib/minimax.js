/** MiniMax T2A：代理侧只负责代取 mp3 字节，Key 不回到前端 */
const ENDPOINT = 'https://api.minimax.chat/v1/t2a_v2'

function hexToBytes(hex) {
  const s = String(hex || '')
  if (!s || s.length % 2) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

export async function minimaxTts(conf, { text, voiceId, model, speed, emotion }) {
  const payload = {
    model,
    text,
    stream: false,
    language_boost: 'auto',
    voice_setting: {
      voice_id: voiceId,
      speed,
      vol: 1,
      pitch: 0,
      ...(emotion ? { emotion } : {}),
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
  }
  const url = `${ENDPOINT}?GroupId=${encodeURIComponent(conf.groupId)}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conf.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => null)
  const code = j?.base_resp?.status_code
  if (!r.ok || code !== 0) {
    const detail = j?.base_resp?.status_msg ?? `HTTP ${r.status}`
    throw new Error(`MiniMax ${code ?? r.status}: ${detail}`)
  }
  const audio = hexToBytes(j?.data?.audio)
  if (!audio) throw new Error('MiniMax 没有返回音频')
  return {
    audio,
    durationMs: Number(j?.extra_info?.audio_length ?? 0) || 0,
    format: String(j?.extra_info?.audio_format ?? 'mp3'),
  }
}
