// QQ音乐凭据 —— cookie 解析、扫码登录、VIP 检测与登录态续期（music.login.LoginServer）
// 登录态续期走本项目既有的 musicu.fcg 未签名通道（与 apis/tx.ts 一致）；
// Login/VipLogin 模块若拒绝未签名请求则以 code != 0 失败，
// 此时保留原凭据并抛错，由调用方记录日志。
// 续期条件：仅浏览器 cookie（无 openId 等抓包字段）时只带 musicid/musickey 尝试，
// 失败率较高；完整凭据（/login/tx 可选传入 openId/accessToken/refreshToken/refreshKey）最可靠。
// 扫码登录（参考 sansenjian/qq-music-api）：ptlogin 扫码 → check_sig →
// graph.qq.com OAuth authorize 换 code → QQConnectLogin.LoginServer/QQLogin 换凭据，
// 成功响应体一般携带 refresh_key 等完整字段，可走自动续期。

import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from './store.ts'
import type { TxCredentials } from './store.ts'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
  Referer: 'https://y.qq.com/',
}

/** 解析 cookie 中的关键字段（uin / qm_keyst 即 musickey / tmeLoginType） */
export const parseCookie = (cookie: string) => ({
  uin: cookie.match(/uin=(\d+)/)?.[1] ?? '0',
  musickey: cookie.match(/qm_keyst=([^;]+)/)?.[1] ?? '',
  tmeLoginType: cookie.match(/tmeLoginType=(\d+)/)?.[1] ?? '',
})

const musicuRequest = async(data: object, cred: TxCredentials | null) => {
  const r = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { ...HEADERS, ...(cred?.cookie ? { cookie: cred.cookie } : {}) },
    body: data,
    timeout: 15000,
  }).promise
  return r.body ?? {}
}

/**
 * 检测当前账号 VIP 等级（vip_login_base），结果写入凭据存储。
 * 成功返回 'svip' / 'vip' / 'normal'；请求失败返回 null（不改动已存值）。
 */
export const checkVip = async() => {
  const cred = getCredentials('tx') as TxCredentials | null
  if (!cred?.cookie) return null
  const { uin } = parseCookie(cred.cookie)
  const body = await musicuRequest({
    comm: { ct: '19', cv: '1859', uin },
    req: {
      module: 'VipLogin.VipLoginInter',
      method: 'vip_login_base',
      param: {},
    },
  }, cred)
  if (body.req?.code !== 0) return null
  const identity = body.req.data?.identity ?? {}
  const vipType = identity.HugeVip ? 'svip' : identity.LMFlag ? 'vip' : 'normal'
  setCredentials('tx', { vipType })
  return vipType
}

/**
 * 续期 tx 登录态（music.login.LoginServer），成功后用新 musickey 替换 cookie 中的
 * qm_keyst 并写回凭据存储（附带 openId 等抓包字段时一并更新）。随后顺带检测 VIP。
 * 无登录态返回 { skipped: true }；网关拒绝抛错。
 */
export const refreshLogin = async() => {
  const cred = getCredentials('tx') as TxCredentials | null
  if (!cred?.cookie) return { skipped: true }
  const { uin, musickey } = parseCookie(cred.cookie)
  if (!musickey) throw new Error('cookie 缺少 qm_keyst 字段')

  const body = await musicuRequest({
    comm: { ct: '19', cv: '1859', uin },
    req: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: {
        ...{ musicid: Number(uin) || 0, musickey, loginMode: 2, expired_in: 0 },
        // App 抓包的完整凭据（存在才携带）
        ...(cred.openId ? { openid: cred.openId } : {}),
        ...(cred.accessToken ? { access_token: cred.accessToken } : {}),
        ...(cred.refreshToken ? { refresh_token: cred.refreshToken } : {}),
        ...(cred.refreshKey ? { refresh_key: cred.refreshKey } : {}),
      },
    },
  }, cred)

  if (body.req?.code !== 0 || !body.req.data?.musickey) {
    throw new Error(`刷新失败（code ${body.req?.code}${body.req?.msg ? `: ${body.req.msg}` : ''}）`)
  }

  const data = body.req.data
  // musickey 可能含 $ 等字符，必须用函数替换（字符串替换的 $&/$' 会被转义展开）
  const cookie = cred.cookie.replace(/qm_keyst=[^;]*/, () => `qm_keyst=${data.musickey}`)
  setCredentials('tx', {
    cookie,
    uin: String(data.musicid ?? uin),
    ...(data.openid ? { openId: String(data.openid) } : {}),
    ...(data.access_token ? { accessToken: String(data.access_token) } : {}),
    ...(data.refresh_key ? { refreshKey: String(data.refresh_key) } : {}),
  })

  const vipType = await checkVip().catch(() => null)
  return { refreshed: true, ...(vipType ? { vipType } : {}) }
}

// ---------------- 扫码登录 ----------------

/** ptqrtoken：hash33(qrsig) */
const hash33 = (str: string): number => {
  let hash = 0
  for (let i = 0; i < str.length; ++i) hash += (hash << 5) + str.charCodeAt(i)
  return 2147483647 & hash
}

/** g_tk：p_skey 的 5381 哈希 */
const getGtk = (skey: string): number => {
  let hash = 5381
  for (let i = 0; i < skey.length; ++i) hash += (hash << 5) + skey.charCodeAt(i)
  return 2147483647 & hash
}

const randomGuid = (): string => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16).toUpperCase()
})

/** 登录链路共享的 cookie 罐：同名后到优先，存「name=value」对 */
class CookieJar {
  private jar = new Map<string, string>()

  merge(setCookie: string[] | undefined) {
    for (const item of setCookie ?? []) {
      const pair = item.split(';')[0]
      const name = pair.split('=')[0]?.trim()
      if (name && pair.includes('=')) this.jar.set(name, pair)
    }
  }

  get(name: string) { return this.jar.get(name)?.split('=').slice(1).join('=') ?? '' }

  entries() { return this.jar.entries() }

  header() { return [...this.jar.values()].join('; ') }
}

const ptloginRequest = async(path: string, query: Record<string, string>, cookie: string) => {
  const r = await httpFetch(`https://ssl.ptlogin2.qq.com/${path}?${new URLSearchParams(query)}`, {
    method: 'get',
    ...(cookie ? { headers: { cookie } } : {}),
    timeout: 15000,
  }).promise
  if (r.statusCode !== 200) {
    const err = new Error(`ptlogin ${path} 失败（HTTP ${r.statusCode}）`) as any
    err.statusCode = r.statusCode
    throw err
  }
  return r
}

/** 创建扫码登录二维码（客户端扫码后轮询 qrCheck），qrsig 需原样回传 */
export const qrShow = async() => {
  const r = await httpFetch(
    'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4' +
    `&t=${Math.random()}&daid=383&pt_3rd_aid=100497308&u1=${encodeURIComponent('https://graph.qq.com/oauth2.0/login_jump')}`,
    { method: 'get', timeout: 15000 },
  ).promise
  const qrsig = (r.headers['set-cookie'] ?? []).map(c => c.match(/qrsig=([^;]+)/)?.[1]).find(Boolean)
  if (!qrsig) throw new Error('获取二维码失败（响应缺少 qrsig）')
  return { qrimg: `data:image/png;base64,${r.raw.toString('base64')}`, qrsig }
}

/**
 * 轮询扫码状态（与 wy 扫码一致的状态码语义）
 * @returns {{ code: 800|801|802|803, message?: string, uin?, vipType? }} 800 过期 / 801 等待 / 802 已扫码 / 803 成功（凭据已保存）
 */
export const qrCheck = async(qrsig: string) => {
  if (!qrsig) {
    const err = new Error('缺少 qrsig') as any
    err.status = 422
    throw err
  }
  const jar = new CookieJar()
  jar.merge([`qrsig=${qrsig}`])

  // 1. 轮询扫码状态：0 成功 / 65 已失效 / 66 未扫描 / 67 已扫描 / 68 授权中
  //    qrsig 无效/已被 ptlogin 下线时返回 403，按二维码过期处理
  let poll
  try {
    poll = await ptloginRequest('ptqrlogin', {
      u1: 'https://graph.qq.com/oauth2.0/login_jump',
      ptqrtoken: String(hash33(qrsig)),
      ptredirect: '0', h: '1', t: '1', g: '1',
      from_ui: '1', ptlang: '2052',
      action: `0-0-${Date.now()}`,
      js_ver: '23111510', js_type: '1',
      pt_uistyle: '40', aid: '716027609', daid: '383',
      pt_3rd_aid: '100497308',
      o1vId: randomGuid(),
    }, jar.header())
  } catch (err: any) {
    if (err.statusCode === 403) return { code: 800, message: '二维码已失效' }
    throw err
  }
  jar.merge(poll.headers['set-cookie'])

  const text = typeof poll.body === 'string' ? poll.body : ''
  const cb = text.match(/ptuiCB\('(\d+)','[^']*','([^']*)'/)
  const state = cb?.[1] ?? ''
  if (state !== '0') {
    const states: Record<string, [number, string]> = {
      65: [800, '二维码已失效'],
      66: [801, '等待扫码'],
      67: [802, '已扫码，待确认'],
      68: [802, '授权中'],
    }
    const [code, message] = states[state] ?? [801, '等待扫码']
    return { code, message }
  }

  // 2. check_sig 换 p_skey（g_tk 需要）
  const checkSigUrl = cb?.[2]
  if (!checkSigUrl?.startsWith('http')) throw new Error('登录检查失败（未返回 check_sig 地址）')
  const checkSig = await httpFetch(checkSigUrl, {
    method: 'get',
    headers: { cookie: jar.header() },
    timeout: 15000,
  }).promise
  jar.merge(checkSig.headers['set-cookie'])
  const pSkey = jar.get('p_skey')
  if (!pSkey) throw new Error('登录检查失败（响应缺少 p_skey）')

  // 3. OAuth authorize 换 code（appid 100497308 为 QQ 音乐开放平台）
  const authorize = await httpFetch('https://graph.qq.com/oauth2.0/authorize', {
    method: 'post',
    headers: { Referer: 'https://graph.qq.com/oauth2.0/authorize', cookie: jar.header() },
    form: {
      response_type: 'code',
      client_id: '100497308',
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
      scope: 'get_user_info,get_app_friends',
      state: 'state',
      switch: '',
      from_ptlogin: '1',
      src: '1',
      update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(getGtk(pSkey)),
      auth_time: String(Date.now()),
      ui: randomGuid(),
    },
    timeout: 15000,
  }).promise
  jar.merge(authorize.headers['set-cookie'])
  const code = String(authorize.headers.location ?? '').match(/[?&]code=([^&]+)/)?.[1]
  if (!code) throw new Error('OAuth 授权失败（未取得 code）')

  // 4. QQLogin 换凭据：响应体 req.data 携带 musickey/musicid（及 openid 等续期字段），
  //    同时响应 Set-Cookie 也会下发 y.qq.com 登录 cookie
  const login = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { ...HEADERS, cookie: jar.header() },
    body: {
      comm: { g_tk: getGtk(pSkey), platform: 'yqq', ct: 24, cv: 0 },
      req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } },
    },
    timeout: 15000,
  }).promise
  jar.merge(login.headers['set-cookie'])

  const data = login.body?.req?.data ?? {}
  const musickey = data.musickey || jar.get('qm_keyst')
  if (!musickey) throw new Error('登录失败（未取得 musickey）')
  // ptlogin 域的 uin 可能带 o 前缀（如 o0123456），统一剥掉
  const uin = String(data.musicid || jar.get('uin')).replace(/^o0*/, '') || '0'

  // 最终 cookie：uin/qm_keyst 用凭据值放最前，其余链路 cookie 原样保留（排除 ptlogin 域噪声）
  const pairs = [`uin=${uin}`, `qm_keyst=${musickey}`]
  if (data.encryptUin) pairs.push(`euin=${data.encryptUin}`)
  for (const [name, pair] of jar.entries()) {
    if (!['qrsig', 'ptui_loginuin', 'uin', 'qm_keyst', 'euin'].includes(name)) pairs.push(pair)
  }

  setCredentials('tx', {
    cookie: pairs.join('; '),
    uin,
    ...(data.openid ? { openId: String(data.openid) } : {}),
    ...(data.access_token ? { accessToken: String(data.access_token) } : {}),
    ...(data.refresh_token ? { refreshToken: String(data.refresh_token) } : {}),
    ...(data.refresh_key ? { refreshKey: String(data.refresh_key) } : {}),
  })

  const vipType = await checkVip().catch(() => null)
  return { code: 803, message: '登录成功', uin, ...(vipType ? { vipType } : {}) }
}
