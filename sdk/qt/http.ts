// 蜻蜓FM SSR 请求助手 —— 域名迁移（www.qingting.fm → www.qtfm.cn）伴随华为 WAF 会话，
// 302 时需带上 Set-Cookie 的 HWWAFSESID/HWWAFSESTIME 再请求 Location，否则可能被 WAF 拦
import { httpFetch } from '../request.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** GET 并跟随最多 3 跳重定向（累计收集 Cookie 回带），返回最终响应 */
export const ssrGet = async(url: string): Promise<{ statusCode: number, html: string }> => {
  let current = url
  let cookie = ''
  for (let hop = 0; hop < 4; hop++) {
    const { statusCode, headers, raw, body } = await httpFetch(current, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.qtfm.cn/',
        Accept: 'text/html,application/xhtml+xml',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 15000,
    }).promise as any
    const setCookies = (headers as any)?.['set-cookie'] ?? []
    const pairs = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .map((c: string) => String(c).split(';')[0].trim())
      .filter(Boolean)
    if (pairs.length) cookie = [...cookie.split('; ').filter(Boolean), ...pairs].join('; ')

    if (statusCode >= 300 && statusCode < 400) {
      const loc = String((headers as any)?.location || '')
      if (loc) {
        current = loc.startsWith('http') ? loc : new URL(loc, current).href
        continue
      }
    }
    return { statusCode, html: raw ? raw.toString('utf8') : String(body ?? '') }
  }
  throw new Error('重定向次数过多')
}

export default { ssrGet }
