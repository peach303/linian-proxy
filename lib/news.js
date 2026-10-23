/**
 * 新闻 RSS 兜底源
 *
 * 博查没 Key / 额度用完 / 偶发没结果时，用公开新闻 RSS 再试一次。
 * 只做「新闻搜索」的兜底，不假装是全网搜索：
 * RSS 返回什么就推什么，返回不了就继续报失败（不编结果）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Linian/1.0'

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function textOf(raw) {
  return String(raw ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return textOf(m?.[1])
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function parseRss(xml) {
  const items = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1])
  const out = []
  for (const item of items) {
    const url = tag(item, 'link')
    const name = tag(item, 'title')
    if (!url || !name) continue
    const description = tag(item, 'description')
    const pub = tag(item, 'pubDate')
    let datePublished = ''
    if (pub) {
      const d = new Date(pub)
      if (!Number.isNaN(+d)) datePublished = d.toISOString()
    }
    out.push({
      name,
      url,
      siteName: tag(item, 'source') || hostOf(url),
      snippet: description,
      summary: description,
      datePublished,
    })
  }
  return out
}

const AGE_MS = {
  oneDay: 86400_000,
  oneWeek: 7 * 86400_000,
  oneMonth: 31 * 86400_000,
  oneYear: 366 * 86400_000,
}

function withinFreshness(datePublished, freshness) {
  const max = AGE_MS[String(freshness || '')]
  if (!max || !datePublished) return true
  const t = +new Date(datePublished)
  return !Number.isNaN(t) && Date.now() - t <= max
}

/**
 * @param {string} query
 * @param {{count?:number, freshness?:string}} opts
 * @returns {Promise<{ok:true, results:Array, images:Array, videos:Array, source:string} | {ok:false, error:string, detail?:string}>}
 */
export async function newsSearch(query, { count = 5, freshness = 'oneWeek' } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, error: 'EMPTY_QUERY' }
  const want = Math.max(1, Math.min(10, Math.round(Number(count) || 5)))
  const urls = [
    `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS&setlang=zh-CN&cc=CN`,
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
  ]

  let lastDetail = ''
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(12_000),
      })
      if (!res.ok) {
        lastDetail = `HTTP ${res.status}`
        continue
      }
      const xml = await res.text()
      const all = parseRss(xml)
      const results = all.filter((r) => withinFreshness(r.datePublished, freshness)).slice(0, want)
      if (results.length) {
        return { ok: true, results, images: [], videos: [], source: 'news-rss' }
      }
      lastDetail = all.length ? '结果都超出时效' : 'RSS 里没有 item'
    } catch (e) {
      lastDetail = String(e?.message || e)
    }
  }

  return { ok: false, error: 'NO_RESULT', detail: lastDetail || '新闻 RSS 也没返回' }
}
