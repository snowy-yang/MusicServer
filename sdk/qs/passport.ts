// 汽水音乐扫码登录 —— 抖音 passport web 二维码（须用「抖音 APP」扫码，汽水 App 扫可能不完成确认）
// 接口:
//   GET  https://api.qishui.com/passport/web/get_qrcode/       → token + qrcode 图片 + 初始化 Cookie
//   POST https://api.qishui.com/passport/web/check_qrconnect/  → 轮询状态，确认后 Set-Cookie 带 sessionid
// 状态映射沿用本仓库约定：800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（自动保存）
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from '../auth/store.ts'

const PASSPORT_HOST = 'https://api.qishui.com'

const PASSPORT_FIXED = {
  aid: '386088',
  passport_jssdk_version: '2.4.13',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  next: 'https://api.qishui.com',
  need_logo: 'false',
  need_short_url: 'false',
  is_frontier: 'true',
  is_new_login: '1',
  iid: '27960026095955',
  version_code: '30020100',
}

const webHeaders = (cookie = '') => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  ...(cookie ? { Cookie: cookie } : {}),
})

const cookieValues = (headers: Record<string, any>): string[] => {
  const raw = headers?.['set-cookie']
  return Array.isArray(raw) ? raw : raw ? [raw] : []
}

const cookiePairsFrom = (headers: Record<string, any>): string[] =>
  cookieValues(headers).map(c => String(c).split(';')[0].trim()).filter(Boolean)

const sessionIdFrom = (headers: Record<string, any>): string => {
  for (const value of cookieValues(headers)) {
    const match = String(value).match(/(?:^|[;,]\s*)sessionid=([^;,\s]+)/i)
    if (match) return match[1]
  }
  return ''
}

// get_qrcode 的 Set-Cookie 需在轮询时原样带上（内存暂存，随二维码生命周期）
const qrCookies = new Map<string, string>()

/** 创建扫码登录二维码 */
export const createQr = async (): Promise<{ token: string; qrimg: string; expireTime: number; scanApp: string }> => {
  const query = new URLSearchParams({
    passport_jssdk_version: PASSPORT_FIXED.passport_jssdk_version,
    passport_jssdk_type: PASSPORT_FIXED.passport_jssdk_type,
    is_from_ttaccountsdk: PASSPORT_FIXED.is_from_ttaccountsdk,
    aid: PASSPORT_FIXED.aid,
    next: PASSPORT_FIXED.next,
    need_logo: PASSPORT_FIXED.need_logo,
    need_short_url: PASSPORT_FIXED.need_short_url,
    is_new_login: PASSPORT_FIXED.is_new_login,
  })
  const request = httpFetch(`${PASSPORT_HOST}/passport/web/get_qrcode/?${query}`, {
    method: 'get',
    headers: webHeaders(),
    timeout: 15000,
  })
  const { statusCode, headers, body } = await request.promise
  const data = (body as any)?.data ?? {}
  if (statusCode != 200 || !data.token) {
    throw new Error(`获取二维码失败: HTTP ${statusCode} ${JSON.stringify(body).slice(0, 120)}`)
  }
  qrCookies.set(data.token, cookiePairsFrom(headers).join('; '))

  // qrcode 可能是 data URL，也可能是图片链接——后者取回转 data URL 方便直接展示
  let qrimg = String(data.qrcode || '')
  if (qrimg && !qrimg.startsWith('data:')) {
    try {
      const imgRes = await httpFetch(qrimg, { method: 'get', timeout: 15000 }).promise
      qrimg = `data:image/png;base64,${imgRes.raw.toString('base64')}`
    } catch {
      // 取图失败时退回原始链接，由调用方处理
    }
  }
  return {
    token: String(data.token),
    qrimg,
    expireTime: Number(data.expire_time) || 0,
    scanApp: String(data.copywriting || '').includes('抖音') ? 'douyin' : '',
  }
}

/**
 * 轮询扫码状态
 * @returns {{ code: 800|801|802|803, message: string, status?: string, errorCode?: number, nickname? }}
 */
export const checkQr = async (token: string): Promise<Record<string, any>> => {
  const query = new URLSearchParams({
    passport_jssdk_version: PASSPORT_FIXED.passport_jssdk_version,
    passport_jssdk_type: PASSPORT_FIXED.passport_jssdk_type,
    is_from_ttaccountsdk: PASSPORT_FIXED.is_from_ttaccountsdk,
    aid: PASSPORT_FIXED.aid,
    iid: PASSPORT_FIXED.iid,
  })
  const form = new URLSearchParams({
    need_logo: PASSPORT_FIXED.need_logo,
    need_short_url: PASSPORT_FIXED.need_short_url,
    is_frontier: PASSPORT_FIXED.is_frontier,
    token,
    is_new_login: PASSPORT_FIXED.is_new_login,
    next: PASSPORT_FIXED.next,
  })
  const cookie = qrCookies.get(token) || ''
  const request = httpFetch(`${PASSPORT_HOST}/passport/web/check_qrconnect/?${query}`, {
    method: 'post',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...webHeaders(cookie),
    },
    body: form.toString(),
    timeout: 15000,
  })
  const { statusCode, headers, body } = await request.promise
  if (statusCode != 200) throw Object.assign(new Error(`轮询扫码状态失败: HTTP ${statusCode}`), { status: 502 })
  const data = (body as any)?.data ?? {}
  const sessionid = sessionIdFrom(headers)
  const status = String(data.status ?? '')
  const errorCode = Number(data.error_code) || 0

  if (sessionid) {
    setCredentials('qs', { sessionid })
    qrCookies.delete(token)
    const profile = (body as any)?.data?.user_info ?? {}
    return {
      code: 803,
      message: '登录成功',
      nickname: profile.nickname ?? profile.name ?? undefined,
      status,
      errorCode,
    }
  }

  // 未确认：区分等待/已扫码/过期。上游状态语义未完全公开，按观察到的值映射，未知值一律视为等待
  const expired = errorCode === 4 || /expire|过期|失效/i.test(String(data.description ?? ''))
  if (expired) {
    qrCookies.delete(token)
    return { code: 800, message: '二维码已失效', status, errorCode }
  }
  if (/scan/i.test(status) || errorCode === 205) {
    return { code: 802, message: '已扫码，待确认', status, errorCode }
  }
  return { code: 801, message: '等待扫码', status, errorCode }
}

/** 当前登录态 */
export const status = (): { logged: boolean; updatedAt?: string } => {
  const cred = getCredentials('qs') as { sessionid?: string; updatedAt?: string } | null
  return cred?.sessionid ? { logged: true, updatedAt: cred.updatedAt } : { logged: false }
}

/** 登录态 sessionid（未登录返回空串） */
export const getSessionId = (): string => (getCredentials('qs') as any)?.sessionid || ''

export default { createQr, checkQr, status, getSessionId }
