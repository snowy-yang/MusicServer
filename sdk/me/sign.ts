// 猫耳FM（MissEvan）App API 签名 —— app.missevan.com 域鉴权
// 算法（知乎 p/359692208 + zunley/gofm pkg/missevan/utils.go，2026-10-02 实测可用）：
//   authorization = "MissEvan " + base64(HMAC-SHA256(appsecret, DATA))
//   DATA = METHOD\n + url(冒号转义%3A)\n + querystring\n + equip_id:<id>\n [+ token:<t>\n]
//          + x-m-date:<UTC毫秒ISO>\n + x-m-nonce:<uuid>\n [+ base64(sha256(body))\n]
//   头：User-Agent MissEvanApp、x-m-date、x-m-nonce、Cookie(equip_id[+token])
// 该通道返回的是免签名 CDN 明文直链（sound-ali*-cdn-cn.maoercdn.com，m4a 原文件/-128k 变体）；
// 网页版 hls.m3u8 为 Widevine 加密，与此无关。
import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { getCredentials } from '../auth/store.ts'

const APP_SECRET = 'f8Yw1M3u0e5MV7z34PcbY9wgP56YwJ'
const APP_UA = 'MissEvanApp/4.7.4 (iOS;15.1;iPhone11,6)'
const EQUIP_ID = '52e76e9a-7592-43af-ae72-8ec755094e41'

const utcMillis = () => new Date().toISOString().replace(/\.\d+Z$/, '.000Z')

/** 构造 authorization 签名（GET 便捷封装；POST 需补 body 摘要行） */
const buildAuth = (method: string, url: string, query: string, { equipId, token, date, nonce }: {
  equipId: string, token?: string, date: string, nonce: string
}) => {
  const lines = [
    method,
    url.replace(/:/g, '%3A'),
    query,
    `equip_id:${equipId}`,
    ...(token ? [`token:${token}`] : []),
    `x-m-date:${date}`,
    `x-m-nonce:${nonce}`,
  ]
  return 'MissEvan ' + crypto.createHmac('sha256', APP_SECRET).update(lines.join('\n') + '\n').digest('base64')
}

/** 登录 token（/login/me 绑定的 cookie 中提取；未登录为空） */
export const getMeToken = (): string => {
  const cookie = (getCredentials('me') as any)?.cookie || ''
  return cookie.match(/(?:^|;\s*)token=([^;\s]+)/)?.[1] || ''
}

/** App API GET 请求（自动携带登录态 token） */
export const appApiGet = async(path: string, query = ''): Promise<any> => {
  const full = `https://app.missevan.com${path}`
  const date = utcMillis()
  const nonce = crypto.randomUUID()
  const token = getMeToken()
  const { statusCode, body } = await httpFetch(query ? `${full}?${query}` : full, {
    headers: {
      'User-Agent': APP_UA,
      Accept: 'application/json',
      'Accept-Language': 'zh-Hans-CN;q=1',
      'x-m-date': date,
      'x-m-nonce': nonce,
      Cookie: `equip_id=${EQUIP_ID}${token ? `; token=${token}` : ''}`,
      Authorization: buildAuth('GET', full, query, { equipId: EQUIP_ID, token, date, nonce }),
    },
    timeout: 15000,
  }).promise as any
  if (statusCode != 200) throw new Error(`猫耳 App API HTTP ${statusCode}`)
  const b = body ?? {}
  if (b.success === false || (b.code != null && b.code !== 0)) {
    throw new Error(b.info || `猫耳 App API code ${b.code}`)
  }
  return b.info ?? b
}

export const ME_UA = APP_UA
export default { appApiGet, getMeToken, ME_UA }
