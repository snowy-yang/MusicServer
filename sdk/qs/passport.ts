// 汽水音乐扫码登录 —— 复刻官方 PC 客户端（SodaMusic）的扫码链路
// 接口:
//   GET  https://api.qishui.com/passport/web/get_qrcode/       → token + 初始化 Cookie
//   GET  二维码内容不是响应里的 qrcode 图，而是用 qrcode_index_url 的 token 重建的官方扫码页：
//        https://bff-pc.qishui.com/light/invoke/scan_login?token=<token>&os=Windows&computer_name=<主机名>
//        （官方 renderer getHandleScanCodeH5Img 即此算法；响应自带的 qrcode 图指向旧页
//         ucenter_web/app/sdk-next，该页已 404，抖音扫码会提示「无法访问页面」）
//   POST https://api.qishui.com/passport/web/check_qrconnect/  → 轮询状态，确认后 Set-Cookie 带 sessionid
// 状态映射沿用本仓库约定：800 过期/拒绝 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（自动保存）
import os from 'node:os'
import QRCode from 'qrcode'
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from '../auth/store.ts'

const PASSPORT_HOST = 'https://api.qishui.com'
const SCAN_LOGIN_URL = 'https://bff-pc.qishui.com/light/invoke/scan_login'
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

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
  version_code: '30020100',
}

/**
 * PC 设备身份（同步读，首次懒生成并持久化）：passport 登录与 PC 签名公共参数共用，
 * 持久化于 data/auth.json 的 `_qs_passport_device`，保证同一实例「同一设备」。
 */
export const getDeviceIds = (): { deviceId: string; installId: string } => {
  const existing = getCredentials('_qs_passport_device') as { deviceId?: string; installId?: string } | null
  if (existing?.deviceId && existing.installId) return { deviceId: String(existing.deviceId), installId: String(existing.installId) }
  const now = Date.now()
  const ids = { deviceId: String(now), installId: String(now + 1) }
  setCredentials('_qs_passport_device', ids)
  return ids
}

// 各 passport 请求共用的公共参数（设备身份 + 平台/版本）
const commonParams = (): Record<string, string> => {
  const { deviceId, installId } = getDeviceIds()
  return {
    passport_jssdk_version: PASSPORT_FIXED.passport_jssdk_version,
    passport_jssdk_type: PASSPORT_FIXED.passport_jssdk_type,
    is_from_ttaccountsdk: PASSPORT_FIXED.is_from_ttaccountsdk,
    aid: PASSPORT_FIXED.aid,
    language: 'zh',
    is_new_login: PASSPORT_FIXED.is_new_login,
    device_id: deviceId,
    install_id: installId,
    did: deviceId,
    iid: installId,
    device_platform: 'PC',
    version_code: PASSPORT_FIXED.version_code,
  }
}

const webHeaders = (cookie = '') => ({
  'User-Agent': WEB_UA,
  ...(cookie ? { Cookie: cookie } : {}),
})

const cookieValues = (headers: Record<string, any>): string[] => {
  const raw = headers?.['set-cookie']
  return Array.isArray(raw) ? raw : raw ? [raw] : []
}

const cookiePairsFrom = (headers: Record<string, any>): string[] =>
  cookieValues(headers).map(c => String(c).split(';')[0].trim()).filter(Boolean)

const cookieMapFrom = (headers: Record<string, any>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const pair of cookiePairsFrom(headers)) {
    const idx = pair.indexOf('=')
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return out
}

const mergeCookies = (current: string, fresh: Record<string, string>): string => {
  for (const pair of current.split(';')) {
    const idx = pair.indexOf('=')
    if (idx > 0) {
      const name = pair.slice(0, idx).trim()
      if (name) fresh[name] = fresh[name] || pair.slice(idx + 1).trim()
    }
  }
  return Object.entries(fresh).map(([k, v]) => `${k}=${v}`).join('; ')
}

// 登录态 cookie 名（passport 确认后下发；sessionid 为必需项）
const SESSION_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt']

const sessionIdOf = (cookie: string): string =>
  cookie.match(/(?:^|;\s*)sessionid=([^;]+)/)?.[1] ?? ''

// get_qrcode 的 Set-Cookie 需在轮询时原样带上（内存暂存，随二维码生命周期）
const qrCookies = new Map<string, string>()

/** 官方扫码页地址：响应 qrcode_index_url 里的 token + PC 标识（官方 renderer 同款算法） */
export const buildScanUrl = (indexUrl: string, computerName = os.hostname() || 'Windows-PC'): string => {
  let token = ''
  try {
    token = new URL(String(indexUrl)).searchParams.get('token') || ''
  } catch {
    token = ''
  }
  if (!token) throw new Error(`二维码地址缺少 token: ${String(indexUrl).slice(0, 80)}`)
  const url = new URL(SCAN_LOGIN_URL)
  url.searchParams.set('token', token)
  url.searchParams.set('os', 'Windows')
  url.searchParams.set('computer_name', String(computerName).trim() || 'Windows-PC')
  // 抖音/客户端把 + 解析成空格，官方实现同样显式替换
  return url.toString().replace(/\+/g, '%20')
}

/** 创建扫码登录二维码（本地渲染官方扫码页，响应自带的 qrcode 图已失效不可用） */
export const createQr = async (): Promise<{ token: string; qrimg: string; expireTime: number; scanApp: string; scanUrl: string }> => {
  const query = new URLSearchParams({
    ...commonParams(),
    next: PASSPORT_FIXED.next,
    need_logo: PASSPORT_FIXED.need_logo,
    need_short_url: PASSPORT_FIXED.need_short_url,
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
  const scanUrl = buildScanUrl(data.qrcode_index_url ?? '', undefined)
  const qrimg = await QRCode.toDataURL(scanUrl, { errorCorrectionLevel: 'M', margin: 2, width: 360 })
  qrCookies.set(data.token, mergeCookies('', cookieMapFrom(headers)))
  return {
    token: String(data.token),
    qrimg,
    expireTime: Number(data.expire_time) || 0,
    // 官方 PC 客户端扫码文案要求「打开汽水音乐 APP → 搜索框右侧 扫一扫」（passport 的
    // copywriting 写的是抖音 APP，但扫描目标是 bff-pc 的 scan_login 页，实际须汽水 App）
    scanApp: 'qishui',
    scanUrl,
  }
}

export interface QrDecision {
  state: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed' | 'mfa'
  message: string
  status: string
  errorCode: number
  rateLimited?: boolean
}

// 官方状态语义（SodaMusic renderer use-scan-code-login）：
//   1/new 等待扫码；2/scanned 已扫码待确认；3/confirmed 已确认；4/5/refused/expired 过期或被拒
export const decideQrStatus = (data: Record<string, any>): QrDecision => {
  const status = String(data?.status ?? '').toLowerCase()
  const errorCode = Number(data?.error_code) || 0
  const accountFlow = String(data?.account_flow ?? '').toLowerCase()
  const description = String(data?.description ?? '')

  if (errorCode === 2046 || accountFlow === 'verify') {
    return { state: 'mfa', message: '需要手机端二次验证（本服务无法自动完成，请在汽水 App 内完成验证后重试）', status, errorCode }
  }
  if (errorCode === 7) {
    return { state: 'waiting', message: '接口限流，请降低轮询频率', status, errorCode, rateLimited: true }
  }
  if (['3', 'confirmed'].includes(status)) {
    return { state: 'confirmed', message: '已确认，等待登录态下发', status, errorCode }
  }
  if (['2', 'scanned'].includes(status)) {
    return { state: 'scanned', message: '已扫码，待确认', status, errorCode }
  }
  if (['4', '5', 'refused', 'expired'].includes(status) || errorCode === 4 || /expire|过期|失效/i.test(description)) {
    const refused = status === 'refused' || /refus|拒绝/i.test(description)
    return { state: 'expired', message: refused ? '已在手机端拒绝登录' : '二维码已失效', status, errorCode }
  }
  if (['error', 'failed'].includes(status) || (errorCode !== 0 && status !== 'new' && status !== '1' && status !== '')) {
    return { state: 'failed', message: description || `扫码失败 (code=${errorCode})`, status, errorCode }
  }
  return { state: 'waiting', message: '等待扫码', status, errorCode }
}

/**
 * 轮询扫码状态（确认后可能还需再轮询一次才下发登录态）
 * @returns {{ code: 800|801|802|803, message: string, status?: string, errorCode?: number, nickname? }}
 */
export const checkQr = async (token: string): Promise<Record<string, any>> => {
  const query = new URLSearchParams(commonParams())
  const form = new URLSearchParams({
    need_logo: PASSPORT_FIXED.need_logo,
    need_short_url: PASSPORT_FIXED.need_short_url,
    is_frontier: PASSPORT_FIXED.is_frontier,
    token,
    is_new_login: PASSPORT_FIXED.is_new_login,
    next: PASSPORT_FIXED.next,
  })
  const request = httpFetch(`${PASSPORT_HOST}/passport/web/check_qrconnect/?${query}`, {
    method: 'post',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...webHeaders(qrCookies.get(token) || ''),
    },
    body: form.toString(),
    timeout: 15000,
  })
  const { statusCode, headers, body } = await request.promise
  if (statusCode != 200) throw Object.assign(new Error(`轮询扫码状态失败: HTTP ${statusCode}`), { status: 502 })
  const data = (body as any)?.data ?? {}
  const decision = decideQrStatus(data)

  // 采集本次轮询下发的 Set-Cookie（确认后登录态就在这里）
  let cookie = mergeCookies(qrCookies.get(token) || '', cookieMapFrom(headers))

  // 确认后若响应体带 redirect_url（浏览器里跳这一跳才落 sessionid），服务端补跳一次收 cookie
  if (decision.state === 'confirmed' && !SESSION_COOKIE_NAMES.some(name => new RegExp(`(?:^|;\\s*)${name}=`).test(cookie))) {
    const redirectUrl = String(data.redirect_url || '')
    if (redirectUrl) {
      try {
        const hop = await httpFetch(redirectUrl, { method: 'get', headers: webHeaders(cookie), timeout: 15000 }).promise
        cookie = mergeCookies(cookie, cookieMapFrom(hop.headers))
      } catch {
        // 补跳失败不致命：下一轮轮询仍可能下发登录态
      }
    }
  }

  const sessionid = sessionIdOf(cookie)
  if (sessionid && SESSION_COOKIE_NAMES.some(name => new RegExp(`(?:^|;\\s*)${name}=`).test(cookie))) {
    setCredentials('qs', { sessionid, cookie })
    qrCookies.delete(token)
    const profile = (body as any)?.data?.user_info ?? {}
    return {
      code: 803,
      message: '登录成功',
      nickname: profile.nickname ?? profile.name ?? undefined,
      status: decision.status,
      errorCode: decision.errorCode,
    }
  }

  qrCookies.set(token, cookie)

  if (decision.state === 'confirmed') {
    return { code: 802, message: decision.message, status: decision.status, errorCode: decision.errorCode }
  }
  if (decision.state === 'expired' || decision.state === 'failed') {
    qrCookies.delete(token)
    return { code: 800, message: decision.message, status: decision.status, errorCode: decision.errorCode }
  }
  if (decision.state === 'scanned' || decision.state === 'mfa') {
    return { code: 802, message: decision.message, status: decision.status, errorCode: decision.errorCode }
  }
  return { code: 801, message: decision.message, status: decision.status, errorCode: decision.errorCode }
}

/** 当前登录态 */
export const status = (): { logged: boolean; updatedAt?: string } => {
  const cred = getCredentials('qs') as { sessionid?: string; updatedAt?: string } | null
  return cred?.sessionid ? { logged: true, updatedAt: cred.updatedAt } : { logged: false }
}

/** 登录态 sessionid（未登录返回空串） */
export const getSessionId = (): string => (getCredentials('qs') as any)?.sessionid || ''

/** 登录态完整 Cookie（未登录返回空串；取流优先用它，sessionid 只是最小集） */
export const getCookie = (): string => (getCredentials('qs') as any)?.cookie || ''

export default { createQr, checkQr, status, getSessionId, getCookie, buildScanUrl, decideQrStatus }
