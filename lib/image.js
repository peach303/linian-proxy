import { Buffer } from 'node:buffer'
import { probeImage } from './media.js'

export const b64u = (s) => Buffer.from(String(s), 'utf8').toString('base64url')
export const unb64u = (s) => {
  try {
    return Buffer.from(String(s ?? ''), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

export function imgProxyPath(origin, src, referer) {
  return `${origin}/api/v1/image?u=${b64u(src)}${referer ? `&ref=${b64u(referer)}` : ''}`
}

export async function proxyImage(src, referer) {
  if (!/^https?:\/\//i.test(src)) return { ok: false, status: 400, error: 'BAD_URL' }
  const got = await probeImage(src, referer)
  if (!got.ok) return { ok: false, status: 404, error: 'IMAGE_UNAVAILABLE', detail: got.reason }
  return got
}
