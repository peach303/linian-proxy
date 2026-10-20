/**
 * 博查（Bocha）Web Search API 的最小封装
 *
 *   文档：https://open.bochaai.com
 *   接口：POST https://api.bochaai.com/v1/web-search
 *        Authorization: Bearer <API Key>
 *        { query, freshness, summary: true, count }
 *
 * 这个文件只干两件事：把请求发出去、把回来的 JSON **归一化**成前端认识的样子。
 *
 * 为什么单独一个文件：归一化函数要能**离线单测**。
 * 这里只保证「上游那份 JSON 有没有被正确读懂」——拿一份样例响应就能跑。
 * 关键：**读不懂就当失败**，绝不猜一条出来 —— 联网搜索这个模块宁可什么都不推。
 *
 * 「这条结果能不能配图 / 是不是视频」是另一件事，在 `media.mjs` 里（要真取一遍才知道）。
 */

export const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

/** 上游失败原因 → 界面上直接显示的一句话（前端也有一份同样的表，两边对齐） */
export const SEARCH_ERROR_TEXT = {
  NOT_CONFIGURED: '还没配搜索服务（设置 → 接入 里填博查 Key）',
  EMPTY_QUERY: '搜索词是空的',
  FETCH_FAILED: '连不上搜索服务（这台机器出不了外网？）',
  TIMEOUT: '搜索服务没在 15 秒内回话',
  BAD_KEY: 'Key 不对或者没权限',
  QUOTA: '额度用完了 / 被限流了',
  BAD_RESPONSE: '搜索服务回的格式看不懂',
  NO_RESULT: '搜索服务这次没返回可用的结果',
  HTTP_ERROR: '搜索服务报了个错',
}

const clampCount = (n) => Math.max(1, Math.min(10, Math.round(Number(n) || 5)))
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v))

/**
 * 把博查的响应归一化
 *
 * 官方返回外面包了一层（文档里两种写法都出现过，两种都认）：
 *   { code: 200, data: { webPages: {...}, images: {...}, videos: {...} } }
 *   { webPages: {...}, images: {...}, videos: {...} }
 *
 * 真机打出来的形状（文档里没写全，这是拿真 Key 探出来的）：
 *   · `webPages.value[]` 每条都带 `siteIcon`（真 favicon）—— 卡片上直接能用；
 *   · `images.value[]` **有时候有**（0~5 张），字段是 `contentUrl` / `thumbnailUrl` / `hostPageUrl`；
 *   · `videos.value[]` **永远是空的**（8/8 都是 null）—— 博查这个接口不给视频数据，
 *     所以视频只能靠「这条结果是不是视频页」来判（见 `media.mjs`），不靠这个容器。
 *
 * 图片**只做归一化，不做验证**：能不能用是 `media.mjs` 的事（要真取一遍才知道）。
 */
export function normalizeBocha(json) {
  const code = json?.code
  if (code != null && Number(code) !== 200) {
    return { ok: false, error: 'HTTP_ERROR', detail: str(json?.msg || json?.message) || `上游 code=${code}` }
  }
  const data = json?.data ?? json
  const pages = data?.webPages?.value
  if (!Array.isArray(pages)) return { ok: false, error: 'BAD_RESPONSE', detail: '响应里没有 webPages.value' }

  const results = pages
    .map((p) => ({
      name: str(p?.name ?? p?.title),
      url: str(p?.url),
      siteName: str(p?.siteName ?? p?.site),
      /** 站点图标（真 favicon，博查给的） */
      siteIcon: str(p?.siteIcon),
      snippet: str(p?.snippet),
      summary: str(p?.summary),
      datePublished: str(p?.datePublished),
    }))
    // 没链接、或者标题摘要都空的，直接不要（这种推进聊天也没意义）
    .filter((r) => r.url && (r.name || r.snippet || r.summary))

  if (!results.length) {
    return { ok: false, error: 'NO_RESULT', detail: `上游给了 ${pages.length} 条，但没有一条带标题和链接` }
  }

  const images = (Array.isArray(data?.images?.value) ? data.images.value : [])
    .map((i) => ({
      url: str(i?.contentUrl || i?.thumbnailUrl),
      thumb: str(i?.thumbnailUrl),
      hostPageUrl: str(i?.hostPageUrl ?? i?.hostPageDisplayUrl),
    }))
    .filter((i) => i.url)

  const videos = (Array.isArray(data?.videos?.value) ? data.videos.value : [])
    .map((v) => ({
      url: str(v?.contentUrl ?? v?.url),
      hostPageUrl: str(v?.hostPageUrl),
      name: str(v?.name),
      duration: str(v?.duration ?? v?.durationText),
    }))
    .filter((v) => v.url)

  return { ok: true, results, images, videos }
}

/**
 * 真去搜一次
 *
 * @param {{apiKey:string, freshness?:string, count?:number}} conf
 * @returns {Promise<{ok:true, results:Array} | {ok:false, error:string, detail?:string}>}
 */
export async function bochaSearch(conf, { query, count, freshness } = {}) {
  const q = str(query)
  if (!q) return { ok: false, error: 'EMPTY_QUERY' }
  if (!conf?.apiKey) return { ok: false, error: 'NOT_CONFIGURED' }

  const body = {
    query: q,
    freshness: str(freshness || conf.freshness) || 'noLimit',
    summary: true,
    count: clampCount(count ?? conf.count),
  }

  let r
  try {
    r = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conf.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return { ok: false, error: timeout ? 'TIMEOUT' : 'FETCH_FAILED', detail: str(e?.message || e) }
  }

  if (r.status === 401 || r.status === 403) return { ok: false, error: 'BAD_KEY', detail: `HTTP ${r.status}` }
  if (r.status === 429) return { ok: false, error: 'QUOTA', detail: 'HTTP 429' }

  const json = await r.json().catch(() => null)
  if (!r.ok) {
    return { ok: false, error: 'HTTP_ERROR', detail: `HTTP ${r.status}${json?.msg ? ` · ${str(json.msg)}` : ''}` }
  }
  if (!json) return { ok: false, error: 'BAD_RESPONSE', detail: '响应不是 JSON' }

  const out = normalizeBocha(json)
  return out.ok ? { ...out } : out
}
