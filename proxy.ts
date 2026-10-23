// @ts-nocheck
/**
 * 黎念 · 免费代理（Deno Deploy）
 *
 * 只做五件事：MiniMax 语音、博查联网搜索、图片转发、网易云元信息、网易云公开音频流。
 * 聊天记录、字卡、日记都不经过这里；Key 只放在 Deno KV / 环境变量里。
 */
import { corsHeaders, json, preflight, readJson } from './lib/cors.js'
import { readConfig, saveConfig, statusOf, verifyAdmin } from './lib/config.js'
import { bochaSearch } from './lib/bocha.js'
import { newsSearch } from './lib/news.js'
import { buildMedia, detectVideo } from './lib/media.js'
import { minimaxTts } from './lib/minimax.js'
import { resolveNetease, proxyNeteaseAudio } from './lib/netease.js'
import {
  getSession,
  neteaseAccountAudioUrl,
  neteaseLyric,
  neteaseProfile,
  neteaseQrPoll,
  neteaseQrStart,
  qqAudioUrl,
  qqLoginWithCookie,
  qqLyric,
  removeSession,
  resolveQQMusic,
} from './lib/musicAuth.js'
import { imgProxyPath, proxyImage, unb64u } from './lib/image.js'

const VERSION = '1.0.0'

function text(req, body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(req) },
  })
}

async function handle(req) {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') return preflight(req)

  if (path === '/' || path === '') {
    return text(
      req,
      `黎念免费代理 v${VERSION}\n\n` +
        'GET  /api/v1/health\n' +
        'GET  /api/v1/integrations\n' +
        'PUT  /api/v1/integrations\n' +
        'POST /api/v1/voice/tts\n' +
        'POST /api/v1/search\n' +
        'GET  /api/v1/image?u=...&ref=...\n' +
        'GET  /api/v1/music/resolve?input=...\n' +
        'GET  /api/v1/music/audio?id=...&session=...\n' +
        'GET  /api/v1/music/lyric?id=...\n' +
        'GET  /api/v1/music/netease/qr\n' +
        'GET  /api/v1/music/netease/poll?key=...\n' +
        'GET  /api/v1/music/status?session=...\n' +
        'POST /api/v1/music/qq/login\n' +
        'POST /api/v1/music/logout\n',
    )
  }

  if (path === '/api/v1/health') {
    return json(req, { ok: true, service: 'linian-deno-proxy', version: VERSION })
  }

  /* ── 接入配置：只回尾号，不回明文 ── */
  if (path === '/api/v1/integrations' && req.method === 'GET') {
    return json(req, statusOf(await readConfig()))
  }

  if (path === '/api/v1/integrations' && req.method === 'PUT') {
    const body = await readJson(req)
    if (!body) return json(req, { error: 'BAD_JSON' }, 400)

    const auth = verifyAdmin(req, body)
    if (!auth.ok) {
      const status = auth.error === 'ADMIN_NOT_SET' ? 500 : 401
      const hint =
        auth.error === 'ADMIN_NOT_SET'
          ? '代理还没设置 ADMIN_PASSWORD，先在 Deno Deploy 环境变量里加一个管理密码'
          : '管理密码不对'
      return json(req, { error: auth.error, hint }, status)
    }

    const r = await saveConfig(body)
    if (!r.ok) {
      return json(
        req,
        {
          error: r.error,
          hint: r.error === 'KV_NOT_BOUND' ? '代理还没绑定 Deno KV 数据库，先在 Deno Deploy 里创建并 Assign' : '保存失败',
        },
        500,
      )
    }
    return json(req, statusOf(r.config))
  }

  /* ── MiniMax 语音 ── */
  if (path === '/api/v1/voice/tts' && req.method === 'POST') {
    const body = (await readJson(req)) || {}
    const conf = await readConfig()
    const mm = conf.minimax

    if (!mm.apiKey) {
      return json(
        req,
        {
          error: 'MINIMAX_NOT_CONFIGURED',
          hint: '在「设置 → 接入」里填 MiniMax API Key 与 GroupId（或者在 Deno Deploy 里配环境变量）',
        },
        501,
      )
    }
    if (!mm.groupId) return json(req, { error: 'MINIMAX_NO_GROUP_ID', hint: '还缺 GroupId' }, 501)

    const content = String(body.text ?? '').trim()
    if (!content) return json(req, { error: 'TEXT_REQUIRED' }, 400)
    if (content.length > 400) return json(req, { error: 'TEXT_TOO_LONG', hint: '一次最多 400 字' }, 400)

    const voiceId = String(body.voiceId || mm.voiceId)
    const model = String(body.model || mm.model)
    const speed = Math.max(0.5, Math.min(2, Number(body.speed ?? mm.speed) || 1))
    const emotion = body.emotion ? String(body.emotion) : ''

    try {
      const r = await minimaxTts(mm, { text: content, voiceId, model, speed, emotion })
      return new Response(r.audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(r.audio.length),
          'Cache-Control': 'no-store',
          'X-Audio-Duration-Ms': String(r.durationMs),
          'X-Audio-Format': r.format,
          'X-Voice-Model': model,
          'Access-Control-Expose-Headers': 'X-Audio-Duration-Ms,X-Audio-Format,X-Voice-Model',
          ...corsHeaders(req),
        },
      })
    } catch (e) {
      const message = String(e?.message || e)
      const notFound = /voice|voice_id|音色/i.test(message)
      return json(req, { error: notFound ? 'MINIMAX_VOICE_ERROR' : 'MINIMAX_ERROR', detail: message }, 502)
    }
  }

  /* ── 博查联网搜索 ── */
  if (path === '/api/v1/search' && req.method === 'POST') {
    const body = (await readJson(req)) || {}
    const query = String(body.query ?? '').trim()
    if (!query) return json(req, { ok: false, error: 'EMPTY_QUERY' }, 400)

    const conf = await readConfig()
    if (!conf.search.apiKey) {
      return json(req, {
        ok: false,
        error: 'NOT_CONFIGURED',
        hint: '在「设置 → 接入」里填博查 API Key（或者在 Deno Deploy 里配环境变量）',
      })
    }

    const count = body.count ?? conf.search.count
    const freshness = body.freshness || conf.search.freshness
    /** 新闻 / 热点 / 影视 / 新歌这类查询优先走新闻 RSS：
        博查对「今天的新闻」经常返回内容农场的旧页，RSS 的时效和来源更干净。
        其他查询（天气、猫狗、店名…）仍走博查。 */
    const newsy = /(新闻|热点|时事|头条|突发|发布会|国际|国内|政策|财经|科技|赛事|电影|上映|新歌|专辑|音乐|演唱会)/.test(query)

    let r = newsy
      ? await newsSearch(query, { count, freshness })
      : await bochaSearch(conf.search, { query, count, freshness })
    let source = newsy ? 'news-rss' : 'bocha'

    /* 首选源没结果 / 连不上 / 被限流时，换另一个源再试一次。
       只在「已经配了 Key」的前提下兜底；没配 Key 仍然明确报未配置，不偷偷换源。 */
    const retryable = ['NO_RESULT', 'FETCH_FAILED', 'TIMEOUT', 'HTTP_ERROR', 'QUOTA', 'BAD_RESPONSE']
    if (!r.ok && retryable.includes(r.error)) {
      const alt = newsy
        ? await bochaSearch(conf.search, { query, count, freshness })
        : await newsSearch(query, { count, freshness })
      if (alt.ok) {
        r = alt
        source = newsy ? 'bocha' : 'news-rss'
      }
    }
    if (!r.ok) return json(req, { ok: false, error: r.error, detail: r.detail, query })

    for (const it of r.results) it.video = detectVideo(it)
    const out = {
      ok: true,
      query,
      source,
      count: r.results.length,
      results: r.results,
      images: r.images.length,
      videos: r.videos.length,
    }

    if (body.enrich && r.results.length) {
      const media = await buildMedia({ result: r.results[0], images: r.images, videos: r.videos })
      const origin = new URL(req.url).origin
      out.media = {
        video: media.video,
        pics: media.pics.map((x) => ({
          src: x.src,
          proxy: imgProxyPath(origin, x.src, x.referer),
          hostPageUrl: x.hostPageUrl,
          width: x.width,
          height: x.height,
          bytes: x.bytes,
          from: x.from,
        })),
        notes: media.notes,
      }
      r.results[0].video = media.video
    }

    return json(req, out)
  }

  /* ── 图片代理 ── */
  if (path === '/api/v1/image' && req.method === 'GET') {
    const src = unb64u(url.searchParams.get('u'))
    const ref = unb64u(url.searchParams.get('ref'))
    const got = await proxyImage(src, ref)
    if (!got.ok) return json(req, { error: got.error, detail: got.detail }, got.status || 404)
    return new Response(got.buf, {
      status: 200,
      headers: {
        'Content-Type': got.type,
        'Content-Length': String(got.buf.length),
        'Cache-Control': 'public, max-age=604800',
        ...corsHeaders(req),
      },
    })
  }

  /* ── 音乐账号：网易云扫码 / QQ Cookie / 会话状态 ── */
  if (path === '/api/v1/music/netease/qr' && req.method === 'GET') {
    return json(req, await neteaseQrStart())
  }

  if (path === '/api/v1/music/netease/poll' && req.method === 'GET') {
    return json(req, await neteaseQrPoll(url.searchParams.get('key')))
  }

  if (path === '/api/v1/music/qq/login' && req.method === 'POST') {
    const body = (await readJson(req)) || {}
    return json(req, await qqLoginWithCookie(body.cookie))
  }

  if (path === '/api/v1/music/status' && req.method === 'GET') {
    const token = url.searchParams.get('session') || req.headers.get('x-music-session') || ''
    const sess = await getSession(token)
    if (!sess) return json(req, { ok: false, error: 'NO_SESSION' })
    return json(req, {
      ok: true,
      provider: sess.provider,
      profile: sess.provider === 'netease' ? await neteaseProfile(sess.cookie) : sess.profile,
      createdAt: sess.createdAt,
    })
  }

  if (path === '/api/v1/music/logout' && req.method === 'POST') {
    const body = (await readJson(req)) || {}
    const token = body.session || url.searchParams.get('session') || req.headers.get('x-music-session') || ''
    return json(req, { ok: await removeSession(token) })
  }

  /* ── 歌词（截句用）：网易云按 id，QQ 按 songmid ── */
  if (path === '/api/v1/music/lyric' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') ?? '').trim()
    const mid = String(url.searchParams.get('mid') ?? '').trim()
    const r = mid ? await qqLyric(mid) : await neteaseLyric(id)
    return json(req, r, r.ok ? 200 : 404)
  }

  /* ── 网易云 / QQ 音频（应用内播放） ── */
  if (path === '/api/v1/music/audio' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') ?? '').trim()
    const mid = String(url.searchParams.get('mid') ?? '').trim()
    const token = url.searchParams.get('session') || req.headers.get('x-music-session') || ''
    const sess = token ? await getSession(token) : null

    // 有登录态：优先换 VIP / 高音质地址，再 302 给浏览器（Range 直接在 CDN 上走）
    if (sess?.provider === 'netease' && /^\d{4,}$/.test(id)) {
      const got = await neteaseAccountAudioUrl(id, sess.cookie)
      if (got?.url) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: got.url,
            'Cache-Control': 'no-store',
            'X-Music-Account': 'netease',
            'X-Music-Level': got.level,
            ...corsHeaders(req),
          },
        })
      }
    }
    if (sess?.provider === 'qq') {
      if (!mid) return json(req, { error: 'BAD_SONG_MID', hint: 'QQ 音乐需要 songmid' }, 400)
      const got = await qqAudioUrl(mid, sess.cookie)
      if (got?.url) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: got.url,
            'Cache-Control': 'no-store',
            'X-Music-Account': 'qq',
            ...corsHeaders(req),
          },
        })
      }
      return json(req, { error: 'NOT_AVAILABLE', hint: 'QQ 音乐没给这个账号返回播放地址（可能是 VIP / 版权 / 地区限制）' }, 404)
    }

    /** QQ 音乐裸 songmid 没带 session：直接说「先登录」，不要误报成 BAD_SONG_ID */
    if (mid) {
      return json(req, {
        error: 'NO_SESSION',
        hint: '这首是 QQ 音乐，先在「设置 → 接入 → 音乐账号」里保存 QQ 音乐 Cookie',
      }, 401)
    }
    if (!/^\d{4,}$/.test(id)) return json(req, { error: 'BAD_SONG_ID' }, 400)

    /*
     * 默认 302 到公开镜像：镜像会再跳到网易云 CDN，音频由浏览器直接取。
     *
     * 为什么不在这里把字节转发一遍：
     * Deno Deploy 的机房访问网易云/国内镜像很慢，整首 10MB+ 会触发
     * DEPLOYMENT_TIMED_OUT；302 只是让浏览器和 CDN 直接谈 Range，
     * 首字节快，seek 也正常。链接仍然是应用内的 <audio>，不会跳网页。
     *
     * 需要同源转发（例如排查问题）时加 `?stream=1`。
     */
    if (url.searchParams.get('stream') !== '1') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://api.injahow.cn/meting/?type=url&id=${encodeURIComponent(id)}`,
          'Cache-Control': 'no-store',
          ...corsHeaders(req),
        },
      })
    }

    const got = await proxyNeteaseAudio(id, req.headers.get('range'))
    if (!got.ok) {
      return json(req, { error: got.error, detail: got.detail }, got.status || 404)
    }
    const headers = {
      'Content-Type': got.type,
      'Cache-Control': 'no-store',
      'Accept-Ranges': got.acceptRanges,
      ...corsHeaders(req),
    }
    if (got.length) headers['Content-Length'] = got.length
    if (got.contentRange) headers['Content-Range'] = got.contentRange
    return new Response(got.body, { status: got.status, headers })
  }

  /* ── 网易云 / QQ 音乐元信息 ── */
  if (path === '/api/v1/music/resolve' && req.method === 'GET') {
    const input = url.searchParams.get('input')
    const provider = String(url.searchParams.get('provider') || '')
    if (provider !== 'qq') {
      const r = await resolveNetease(input)
      if (r) return json(req, { provider: 'netease', ...r })
    }
    if (provider !== 'netease') {
      const q = await resolveQQMusic(input)
      if (q) return json(req, { provider: 'qq', ...q })
    }
    return json(req, { error: 'not found' }, 404)
  }

  return json(req, { error: 'NOT_FOUND', path }, 404)
}

Deno.serve(handle)
