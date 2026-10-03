// 懒人听书 App API（dapis.mting.info）—— 搜索通道（游客 token 匿名可用）
// 签名（移植 loyalflower/lrts_download download.go）：
//   sc = md5(urlPath + "?" + <按 key 排序的 query(不含sc) 拼接> + secret)，secret = "iJ0DgxmdC83#I&j@iwg"
//   头：UA Android13/yyting/... / Referer yytingting.com / ClientVersion 6.3.4.0
// 端点：/yyting/search/searchBatch.action（q=2150）
// 注意：章节/取流 App 端点（q=1930/2224）游客 token 已失效（482 请登录），取流走 web 通道（见 apis/lr.ts）
import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'

const DOMAIN = 'http://dapis.mting.info'
const SECRET = 'iJ0DgxmdC83#I&j@iwg'
const GUEST_TOKEN = 'OqzlvCxt2i_P1SZKF6GjFg**_lK0uCQpm5tN-P6XdFZYawCDKSgeC4anU'
const GUEST_IMEI = 'MDI6MDA6MDA6MDA6MDA6DDA='

const APP_HEADERS = {
  'User-Agent': 'Android13/yyting/vivo/V2133A/ch_uc_beta/167/Android',
  Referer: 'yytingting.com',
  ClientVersion: '6.3.4.0',
}

const signed = (path: string, params: Record<string, string>) => {
  const q: Record<string, string> = { token: GUEST_TOKEN, imei: GUEST_IMEI, nwt: '1', ...params }
  const qs = Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('&')
  q.sc = crypto.createHash('md5').update(path + '?' + qs + SECRET).digest('hex')
  return `${DOMAIN}${path}?${Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}

/** App API GET（游客态，仅搜索可用；章节/取流会 482 需登录） */
export const appApiGet = async(path: string, params: Record<string, string>): Promise<any> => {
  const { statusCode, body } = await httpFetch(signed(path, params), { headers: APP_HEADERS, timeout: 15000 }).promise as any
  if (statusCode != 200) throw new Error(`懒人 App API HTTP ${statusCode}`)
  return body ?? {}
}

export default { appApiGet }
