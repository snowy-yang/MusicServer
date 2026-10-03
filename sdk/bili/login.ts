// Bilibili 扫码登录（上游 bilibili/login.go 的 CreateQRLogin/CheckQRLogin + account.go 的 IsVipAccount）
// 接口:
//   GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate → data.{url, qrcode_key}
//   GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key= → data.code
//       0 成功 / 86038 过期 / 86090 已扫码待确认 / 86101 未扫码
// 成功时登录态 Cookie 在 poll 响应的 Set-Cookie 与 data.url 的 crossDomain 查询串里（两处都收集）。
// 凭据落盘到 sdk/auth/store.ts 的 `bili` 记录（cookie / refreshToken / 账号资料），与 kg/wy 一致；
// 上游 New(cookie) 的实例化语义由 getCredentials('bl') 承担（见 util.ts getCookie）。
// 状态码沿用本仓库约定：800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功。
import QRCode from 'qrcode'
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from '../auth/store.ts'
import { REFERER, UA } from './util.ts'
import { resetVipCache } from '../apis/bili.ts'

const QR_GENERATE_API = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL_API = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'

/** 上游 utils.WithRandomIPHeader：随机国内 IP，规避部分区域限制 */
const randomChinaIp = (): string => {
  const first = [36, 42, 58, 60, 101, 106, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 171, 175, 180, 182, 183, 210, 211, 218, 219, 220, 221, 222, 223][Math.floor(Math.random() * 35)]
  return `${first}.${1 + Math.floor(Math.random() * 254)}.${1 + Math.floor(Math.random() * 254)}.${1 + Math.floor(Math.random() * 254)}`
}

const qrHeaders = (): Record<string, string> => {
  const ip = randomChinaIp()
  return {
    'User-Agent': UA,
    Referer: REFERER,
    'X-Forwarded-For': ip,
    'X-Real-IP': ip,
  }
}

const cookieMapFromHeaders = (headers: any): Record<string, string> => {
  const raw = headers?.['set-cookie']
  const values: string[] = Array.isArray(raw) ? raw : raw ? [String(raw)] : []
  const jar: Record<string, string> = {}
  for (const value of values) {
    const pair = String(value).split(';')[0].trim()
    const idx = pair.indexOf('=')
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return jar
}

/** crossDomain 回跳地址的查询串里也带 SESSDATA 等（无 cookie 包时后备） */
const cookieMapFromCrossDomain = (crossUrl: string): Record<string, string> => {
  const jar: Record<string, string> = {}
  try {
    const url = new URL(String(crossUrl || ''))
    for (const name of ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct', 'sid']) {
      const value = url.searchParams.get(name)
      if (value) jar[name] = value
    }
  } catch {
    // 非 URL 时忽略
  }
  return jar
}

const cookieString = (jar: Record<string, string>): string =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')

/** 创建扫码登录会话：返回 { key, qrurl, qrimg, expiresAt }（qrimg 可直接展示） */
export const createQRLogin = async() => {
  const { statusCode, body } = await httpFetch(QR_GENERATE_API, { headers: qrHeaders(), timeout: 15000 }).promise as any
  if (statusCode !== 200 || !body || typeof body !== 'object') {
    throw new Error(`获取B站登录二维码失败（HTTP ${statusCode}）`)
  }
  if (body.code !== 0 || !String(body.data?.qrcode_key || '').trim()) {
    throw new Error(`获取B站登录二维码失败（${body.code}${body.message ? `: ${body.message}` : ''}）`)
  }
  const key = String(body.data.qrcode_key)
  const url = String(body.data.url || '')
  const qrimg = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 360 }).catch(() => '')
  return {
    key,
    qrurl: url,
    qrimg,
    // 上游 QRLoginSession.ExpiresAt：3 分钟有效期
    expiresAt: Math.floor(Date.now() / 1000) + 180,
  }
}

/** 拉取账号资料（nav；失败不阻断登录） */
const fetchProfile = async(cookie: string) => {
  try {
    const { body } = await httpFetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: REFERER, Cookie: cookie },
      timeout: 15000,
    }).promise as any
    const data = body?.data ?? {}
    return {
      mid: data.mid ?? null,
      nickname: data.uname ?? null,
      vipType: Number(data.vipType) || 0,
      vipStatus: Number(data.vipStatus) || 0,
    }
  } catch {
    return { mid: null, nickname: null, vipType: 0, vipStatus: 0 }
  }
}

/**
 * 轮询扫码状态
 * @returns {{ code: 800|801|802|803, message: string, status: string, profile? }}
 *   800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（凭据已落盘）
 */
export const checkQRLogin = async(key: string) => {
  const qrcodeKey = String(key || '').trim()
  if (!qrcodeKey) throw new Error('B站扫码 key 为空')
  const { statusCode, headers, body } = await httpFetch(`${QR_POLL_API}?qrcode_key=${encodeURIComponent(qrcodeKey)}`, {
    headers: { 'User-Agent': UA, Referer: REFERER },
    timeout: 15000,
  }).promise as any
  if (statusCode !== 200) {
    throw Object.assign(new Error(`轮询B站扫码状态失败（HTTP ${statusCode}）`), { status: 502 })
  }
  const data = body?.data ?? {}
  const code = Number(data.code)

  if (code === 0) {
    const jar = { ...cookieMapFromCrossDomain(data.url), ...cookieMapFromHeaders(headers) }
    const cookie = cookieString(jar)
    if (!cookie) throw new Error('B站登录成功但未获取到 Cookie，请重试')
    const profile = await fetchProfile(cookie)
    setCredentials('bl', {
      cookie,
      refreshToken: String(data.refresh_token || ''),
      mid: profile.mid,
      nickname: profile.nickname,
      vipType: profile.vipType,
      vipStatus: profile.vipStatus,
    })
    resetVipCache()
    return { code: 803, message: '登录成功', status: 'success', profile }
  }

  const statusMap: Record<number, [number, string, string]> = {
    86038: [800, '二维码已过期', 'expired'],
    86090: [802, '已扫码，待确认', 'scanned'],
    86101: [801, '等待扫码', 'waiting'],
  }
  const [mappedCode, message, status] = statusMap[code] ?? [800, String(data.message || `未知状态 ${code}`), 'failed']
  return { code: mappedCode, message, status }
}

/** 当前登录态（凭据存在性 + 落盘时保存的账号资料） */
export const status = () => {
  const cred = getCredentials('bl') as any
  return cred?.cookie
    ? {
        logged: true,
        nickname: cred.nickname ?? null,
        mid: cred.mid ?? null,
        vipType: cred.vipType ?? 0,
        updatedAt: cred.updatedAt,
      }
    : { logged: false }
}

export default { createQRLogin, checkQRLogin, status }
