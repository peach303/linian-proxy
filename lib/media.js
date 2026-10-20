/**
 * 搜索结果的「形态」判定 + 素材验证（服务端）
 *
 * 背景（拿真 Key 打博查探出来的实情）：
 *   · `webPages.value[]` 每条都带 `siteIcon`（真 favicon）—— 以前我们丢掉了；
 *   · `images.value[]` **有时候有**（同一次查询 0~5 张），是相关页面里的图；
 *   · `videos.value[]` **永远是空的**（8/8 都是 null），博查这个接口不返回视频数据；
 *   · `images` 里那批图**一半不能用**：网站 logo（尺寸很小）、防盗链 403、404、根本连不上。
 *
 * 所以这个文件只做两件事，而且**只做「验证」不做「生成」**：
 *   ① 判断一条网页结果**是不是视频页**（只有两路硬信号：域名是视频站 / 页面自己的 `og:video`）；
 *   ② 把候选图**真取一遍**，取得到、是 image/*、不是图标、不是超宽横幅，才算数。
 *
 * 拿不到图就不配图（退回纯链接卡）——**绝不合成一张「他拍的图」**。
 * 这一条和 `bocha.mjs` 顶上那句是同一个红线。
 */

import { Buffer } from 'node:buffer'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Linian/1.0'

/** 太小的当图标丢掉；太大的不往聊天里塞 */
export const IMAGE_MIN_BYTES = 20 * 1024
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024
/** 短边小于这个像素数 → 当图标/缩略图丢掉
 *  （320 是拿真数据调出来的：200×200 的「微信/微博分享图」、180×180 的 app 图标都栽在这条上） */
export const IMAGE_MIN_SIDE = 320
/** 宽高比超过这个 → 当横幅丢掉 */
const MAX_ASPECT = 4

/** 一次推送最多验几张图（每张一次请求） */
export const MAX_PROBED_PICS = 3

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
}

export function hostOf(u) {
  try {
    return new URL(str(u)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function originOf(u) {
  try {
    const x = new URL(str(u))
    return `${x.protocol}//${x.host}`
  } catch {
    return ''
  }
}

/** 同站（含子域）：用来把「这条结果自己页面上的图」排在前面 */
export function sameSite(a, b) {
  const ha = hostOf(a)
  const hb = hostOf(b)
  if (!ha || !hb) return false
  const strip = (h) => h.replace(/^www\./, '')
  const sa = strip(ha)
  const sb = strip(hb)
  return sa === sb || sa.endsWith(`.${sb}`) || sb.endsWith(`.${sa}`)
}

/* ─────────────────────── 是不是视频页 ─────────────────────── */

/** 精确到域名：只收「点开就是视频」的站，不收 qq.com 这种一片都算的 */
const VIDEO_HOSTS = [
  'bilibili.com',
  'b23.tv',
  'acfun.cn',
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'v.qq.com',
  'v.youku.com',
  'youku.com',
  'iqiyi.com',
  'mgtv.com',
  'tv.sohu.com',
  'v.sohu.com',
  'v.ifeng.com',
  'v.163.com',
  'pps.tv',
  'so.pps.tv',
  'douyin.com',
  'iesdouyin.com',
  'kuaishou.com',
  'xigua.com',
  'haokan.baidu.com',
  'douyu.com',
  'huya.com',
  'xinpianchang.com',
  'vjshi.com',
  'tudou.com',
  'le.com',
  '1905.com',
  'miguvideo.com',
]

/** 域名太宽、只有特定路径才算视频的 */
const VIDEO_PATH_HOSTS = [
  { host: 'weibo.com', path: /\/(tv|video|s)\// },
  { host: '163.com', path: /\/v\// },
  { host: 'sohu.com', path: /\/v\// },
  { host: 'baidu.com', path: /\/video\// },
  { host: 'toutiao.com', path: /\/video\// },
  { host: 'zhihu.com', path: /\/zvideo\// },
  { host: 'xiaohongshu.com', path: /\/video\// },
]

function hostInVideoList(host) {
  if (!host) return false
  return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/** 摘要/标题里那种真时长：00:38 / 1:02:11 / 02:15（行首行尾或括号里） */
export function parseDuration(text) {
  const m = str(text).match(/(?:^|[\s（(【[·|])?((?:\d{1,2}:)?\d{1,2}:\d{2})(?=[\s）)】\]·|,，。]|$)/)
  if (!m) return null
  const d = m[2]
  // 「12:30」这种也可能是钟点，只收看起来像时长的：分秒两位、或者带小时段
  if (!/^\d{1,2}:\d{2}$/.test(d) && !/^\d{1,2}:\d{2}:\d{2}$/.test(d)) return null
  return d
}

/**
 * 判断一条结果是不是视频页（纯本地判断，不发任何请求，所以可以给每条结果都算一遍）
 *
 * **只有两路硬信号**，任一路成立才算：
 *   · `host` —— 域名本身就是视频站（B站 / 优酷 / 爱奇艺 / 抖音…），点开就是播放页；
 *   · `og`   —— 页面自己的 `og:video`（要真抓一次页面才知道，`buildMedia` 里补）。
 *
 * 曾经还有第三路「标题里写着『预告片·在线观看·免费播放』」，**实测被拿掉了**：
 *   拿它判的时候，新浪那篇《看了预告片好期待》的**报道**、《什么样的热播剧才是真的热》的
 *   **盘点文章**全被打成「视频卡」—— 标题里出现那几个词根本不能证明这条是视频。
 *   宁可视频卡少见，也不要给一篇文章挂个 ▶。
 *
 * @param {{url?:string, name?:string, snippet?:string, summary?:string, siteName?:string, hasOgVideo?:boolean}} r
 */
export function detectVideo(r = {}) {
  const url = str(r.url)
  const host = hostOf(url)
  const byHost = hostInVideoList(host) || VIDEO_PATH_HOSTS.some((x) => (host === x.host || host.endsWith(`.${x.host}`)) && x.path.test(url))
  const byOg = Boolean(r.hasOgVideo)
  if (!byHost && !byOg) return { is: false, site: null, duration: null, why: null }
  return {
    is: true,
    site: str(r.siteName) || host || null,
    duration: parseDuration([r.name, r.snippet, r.summary].join(' ')),
    why: byHost ? 'host' : 'og',
  }
}

/* ─────────────────────── 图片：尺寸 + 真取一遍 ─────────────────────── */

/** 从字节里读宽高（PNG / JPEG / GIF / WebP），读不出来就当不能用 */
export function imageSize(buf) {
  if (!buf || buf.length < 16) return null
  // PNG: 89 50 4E 47 | IHDR 在 16..24
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF: 6..10 小端
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  }
  // WebP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16)
    if (fourcc === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { width: w, height: h }
    }
    if (fourcc === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  // JPEG: 扫段找 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
    return null
  }
  return null
}

/** 读流但封顶（免得一张 200MB 的图把内存吃了） */
async function readCapped(res, max) {
  const chunks = []
  let n = 0
  try {
    for await (const c of res.body) {
      n += c.length
      if (n > max) {
        try {
          await res.body.cancel()
        } catch {
          /* 忽略 */
        }
        return null
      }
      chunks.push(c)
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks)
}

/**
 * 真去取一张图，验过才算数
 *
 * @returns {Promise<{ok:true,type:string,bytes:number,width:number,height:number,buf:Buffer} | {ok:false,reason:string}>}
 */
export async function probeImage(url, referer, { timeoutMs = 8000 } = {}) {
  const u = str(url)
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: '不是 http 链接' }
  let r
  try {
    r = await fetch(u, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/*,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { ok: false, reason: '连不上（防盗链或者已失效）' }
  }
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` }
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('image/')) return { ok: false, reason: `不是图片（${type || '没有类型'}）` }
  if (type.includes('svg')) return { ok: false, reason: 'SVG（读不出尺寸）' }
  const buf = await readCapped(r, IMAGE_MAX_BYTES)
  if (!buf) return { ok: false, reason: '太大或者读不下来' }
  if (buf.length < IMAGE_MIN_BYTES) return { ok: false, reason: `太小（${Math.round(buf.length / 1024)}KB）` }
  const size = imageSize(buf)
  if (!size || !size.width || !size.height) return { ok: false, reason: '读不出版面尺寸' }
  if (Math.min(size.width, size.height) < IMAGE_MIN_SIDE) return { ok: false, reason: `像图标（${size.width}×${size.height}）` }
  if (size.width / size.height > MAX_ASPECT || size.height / size.width > MAX_ASPECT) return { ok: false, reason: `太扁（${size.width}×${size.height}）` }
  return { ok: true, type, bytes: buf.length, width: size.width, height: size.height, buf }
}

/* ─────────────────────── 页面自己的封面（og:image / og:video） ─────────────────────── */

function metaTags(html) {
  const out = {}
  const tagRe = /<meta\s+([^>]*?)\/?>/gi
  let m
  while ((m = tagRe.exec(html))) {
    const attrs = {}
    const attrRe = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    let a
    while ((a = attrRe.exec(m[1]))) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? ''
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase()
    if (key && attrs.content && !(key in out)) out[key] = attrs.content
  }
  return out
}

function firstOf(meta, keys) {
  for (const k of keys) {
    const v = str(meta[k])
    if (v) return v
  }
  return ''
}

async function fetchPageMeta(pageUrl, { timeoutMs = 6000, maxBytes = 400 * 1024 } = {}) {
  try {
    const r = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    const ct = (r.headers.get('content-type') ?? '').toLowerCase()
    if (ct && !ct.includes('html') && !ct.includes('xml')) return null
    const chunks = []
    let n = 0
    for await (const c of r.body) {
      n += c.length
      chunks.push(c)
      if (n > maxBytes) {
        try {
          await r.body.cancel()
        } catch {
          /* 忽略 */
        }
        break
      }
    }
    const html = Buffer.concat(chunks).toString('utf8')
    if (!html) return null
    const meta = metaTags(html)
    return {
      ogImage: firstOf(meta, ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']),
      ogVideo: firstOf(meta, ['og:video:secure_url', 'og:video:url', 'og:video']),
      ogTitle: firstOf(meta, ['og:title']),
    }
  } catch {
    return null
  }
}

/* ─────────────────────── 组装：一条结果的「形态 + 素材」 ─────────────────────── */

/**
 * 给**将要推送的那一条**备齐素材
 *
 * · `video`：是不是视频页（域名表先判，页面 og:video 再补一刀）
 * · `pics`：验过的图（同页面的排前面），最多 `MAX_PROBED_PICS` 张
 * · `notes`：被丢掉的图 + 原因（写进日志，方便回头看「这次为什么没配图」）
 *
 * 图片验证和页面封面是**并发**跑的（最慢也就一批的 8 秒），不会把一次推送拖很久。
 */
export async function buildMedia({ result, images = [], videos = [] } = {}) {
  const notes = []
  const url = str(result?.url)
  let video = detectVideo(result ?? {})
  const pics = []

  if (!/^https?:\/\//i.test(url)) return { video, pics, notes: ['不是 http 链接'] }

  // 候选图：博查 images 里，hostPageUrl 和这条结果同站的排前面
  const same = images.filter((i) => sameSite(i?.hostPageUrl, url))
  const rest = images.filter((i) => !same.includes(i))
  const candidates = [...same, ...rest].filter((i) => str(i?.url)).slice(0, MAX_PROBED_PICS + 2)

  const metaTask = fetchPageMeta(url, { timeoutMs: 6000 })
  const probeTasks = candidates.slice(0, MAX_PROBED_PICS).map((i) =>
    probeImage(i.url, originOf(i.hostPageUrl) || originOf(url), { timeoutMs: 8000 }).then((p) => ({ img: i, p })),
  )

  // videos 容器现在是空的（博查不给），万一以后有就顺手收下
  const clip = videos.find((v) => str(v?.url))

  const meta = await metaTask
  if (meta?.ogVideo && !video.is) video = { ...video, is: true, why: 'og', site: video.site ?? hostOf(url), duration: video.duration ?? parseDuration(meta.ogTitle) }
  if (!meta) notes.push('这个页面没能打开（拿不到它自己的封面图）')

  const probed = await Promise.all(probeTasks)
  for (const { img, p } of probed) {
    if (p.ok) {
      pics.push({
        src: str(img.url),
        hostPageUrl: str(img.hostPageUrl) || url,
        referer: originOf(img.hostPageUrl) || originOf(url),
        width: p.width,
        height: p.height,
        bytes: p.bytes,
        from: sameSite(img.hostPageUrl, url) ? 'same' : 'related',
      })
    } else {
      notes.push(`图被丢掉：${p.reason}`)
    }
  }

  // 一条同站的图都没有 → 退一步用这个页面自己的 og:image 当封面
  if (!pics.some((p) => p.from === 'same') && meta?.ogImage && pics.length < MAX_PROBED_PICS) {
    const abs = (() => {
      try {
        return new URL(meta.ogImage, url).toString()
      } catch {
        return ''
      }
    })()
    if (abs) {
      const p = await probeImage(abs, originOf(url), { timeoutMs: 8000 })
      if (p.ok) {
        pics.push({ src: abs, hostPageUrl: url, referer: originOf(url), width: p.width, height: p.height, bytes: p.bytes, from: 'page' })
      } else {
        notes.push(`网页封面被丢掉：${p.reason}`)
      }
    }
  }

  // 同站/页面自己的放最前，最贴题
  pics.sort((a, b) => (a.from === 'related' ? 1 : 0) - (b.from === 'related' ? 1 : 0))

  if (clip) notes.push(`上游这次给了 ${videos.length} 条视频数据（之前一直是空的）`)
  return { video, pics, notes }
}
