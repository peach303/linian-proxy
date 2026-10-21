/**
 * MiniMax T2A：代理侧只负责代取 mp3 字节，Key 不回到前端
 *
 * 新版接口（api.minimax.io / api.minimaxi.com）只用 Bearer Key，不再需要 GroupId；
 * 旧版接口 api.minimax.chat 才需要 ?GroupId=…。这里先按「有没有旧版数字 GroupId」
 * 选择顺序，失败后再自动换另一个域名，避免用户被 GroupId 卡住。
 */
const OLD_ENDPOINT = 'https://api.minimax.chat/v1/t2a_v2'
const NEW_ENDPOINTS = ['https://api.minimax.io/v1/t2a_v2', 'https://api.minimaxi.com/v1/t2a_v2']

function hexToBytes(hex) {
  const s = String(hex || '')
  if (!s || s.length % 2) return null
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

function endpointUrl(base, groupId) {
  if (base !== OLD_ENDPOINT) return base
  return `${base}?GroupId=${encodeURIComponent(groupId)}`
}

async function requestOnce(url, conf, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conf.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
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

  const attempts = []
  // 只有像「18 位数字」的旧版 GroupId 才值得先走旧接口；代理网址 / 空值不参与
  if (conf.groupId && /^\d{6,}$/.test(String(conf.groupId).trim())) attempts.push(OLD_ENDPOINT)
  attempts.push(...NEW_ENDPOINTS)

  const errors = []
  for (const base of attempts) {
    try {
      return await requestOnce(endpointUrl(base, String(conf.groupId ?? '').trim()), conf, payload)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  const unique = [...new Set(errors)]
  throw new Error(unique.join(' / ') || 'MiniMax 请求失败')
}
