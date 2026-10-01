// 酷狗登录 —— token 绑定 / 扫码 / 短信验证码（与 MakcRe/KuGouMusicApi 协议对齐）
// 扫码走 login-user.kugou.com 的 web 签名通道；短信走 android 签名 + AES/RSA；
// token 也可从酷狗 App 抓包获取（login.token）后经 /login/kg 绑定

import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from './store.ts'
import type { KgCredentials } from './store.ts'

const md5 = s => crypto.createHash('md5').update(s).digest('hex')
const SALT_KEY = '57ae12eb6890223e355ccfcb74edf70d'
const SALT_SIGN = 'OIlwieks28dk2k092lksi2UIkp'
const APPID = 1005
const CLIENTVER = 11430
// 登录专用域按参考实现固定 clientver 20489（qr/短信接口实测通过的版本）
const LOGIN_CLIENTVER = 20489
const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const SRC_APPID = 2919
const QR_URL_PREFIX = 'https://h5.kugou.com/apps/loginQRCode/html/index.html'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`

const calculateMid = (guid) => BigInt(`0x${md5(guid)}`).toString()
const randomString = (n) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export const androidSign = (params, data = '') => {
  const s = Object.keys(params).sort()
    .map(k => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
    .join('')
  return md5(SALT_SIGN + s + data + SALT_SIGN)
}

/** 设备标识持久化（guid/mid/dfid 稳定复用，登录验证与取流共用同一指纹） */
export const getDevice = () => {
  const dev = getCredentials('_kg_device') ?? { guid: crypto.randomUUID(), mid: '', dfid: randomString(24) }
  if (!dev.mid) {
    dev.mid = calculateMid(dev.guid)
    setCredentials('_kg_device', dev)
  }
  return dev
}

/** 网关移动端签名请求（默认 gateway.kugou.com + x-router，可 host 直连登录专用域） */
const gatewayRequest = async(url, { params: extraParams, data, router, host = 'https://gateway.kugou.com', headers: extraHeaders = {} }: {
  params?: Record<string, any>
  data?: any
  router?: string
  host?: string
  headers?: Record<string, string>
}) => {
  const dev = getDevice()
  const params = {
    dfid: dev.dfid, mid: dev.mid, uuid: '-', appid: APPID, clientver: CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    ...extraParams,
  }
  const signature = androidSign(params, data ? JSON.stringify(data) : '')
  const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
  const r = await httpFetch(`${host}${url}?${qs}&signature=${signature}`, {
    method: 'post',
    headers: {
      dfid: dev.dfid, mid: dev.mid, clienttime: String(params.clienttime),
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      ...(router ? { 'x-router': router } : {}),
      ...extraHeaders,
    },
    body: data ?? undefined,
    timeout: 15000,
  }).promise
  return r.body ?? {}
}

/**
 * 验证 token 并返回账号资料（usercenter /v3/get_my_info）
 * p = RSA 原始加密（零填充 128 字节）{ token, clienttime }
 */
export const verifyToken = async({ token, userid }) => {
  const unixSec = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ token, clienttime: unixSec }))
  const padded = Buffer.concat([Buffer.alloc(128 - payload.length), payload])
  const p = crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex').toUpperCase()

  const body = await gatewayRequest('/v3/get_my_info', {
    router: 'usercenter.kugou.com',
    params: { plat: 1 },
    data: { visit_time: unixSec, usertype: 1, p, userid: Number(userid) || 0 },
  })
  if (body.status !== 1 || !body.data) {
    const err = new Error(body.error ?? 'token 无效或已过期')
    ;(err as any).status = 401
    throw err
  }
  return {
    userid: body.data.userid ?? Number(userid),
    nickname: body.data.nickname ?? body.data.username ?? null,
    vip: body.data.vip ? Boolean(body.data.vip) : null,
  }
}

/** 绑定并验证 kg token */
export const loginByToken = async({ token, userid }) => {
  const profile = await verifyToken({ token, userid })
  setCredentials('kg', { token, userid: profile.userid, nickname: profile.nickname })
  return profile
}

// ---- 扫码登录（login-user.kugou.com，web 签名，盐与 H5 网页端一致）----

const webSign = (params) => {
  const s = Object.keys(params).map(k => `${k}=${params[k]}`).sort().join('')
  return md5(`${WEB_SALT}${s}${WEB_SALT}`)
}

/** login-user.kugou.com GET 请求（web 签名，与取流共用同一设备指纹） */
const loginUserGet = async(url, extraParams = {}) => {
  const dev = getDevice()
  const params = {
    dfid: dev.dfid, mid: dev.mid, uuid: '-',
    appid: APPID, clientver: LOGIN_CLIENTVER, clienttime: Math.floor(Date.now() / 1000),
    ...extraParams,
  }
  const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
  const r = await httpFetch(`https://login-user.kugou.com${url}?${qs}&signature=${webSign(params)}`, {
    headers: {
      dfid: dev.dfid, mid: dev.mid, clienttime: String(params.clienttime),
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    },
    timeout: 15000,
  }).promise
  const body = r.body ?? {}
  if (body.status !== 1) {
    const err = new Error(body.error ?? '酷狗登录服务请求失败')
    ;(err as any).status = 502
    throw err
  }
  return body
}

/** 保存登录凭据并拉取账号资料（扫码/短信登录共用；资料校验失败不阻断登录） */
const applyKgLogin = async({ token, userid }) => {
  try {
    const profile = await verifyToken({ token, userid })
    setCredentials('kg', { token, userid: profile.userid, nickname: profile.nickname })
    return profile
  } catch {
    const uid = Number(userid) || 0
    setCredentials('kg', { token, userid: uid })
    return { userid: uid, nickname: null, vip: null }
  }
}

/** 创建扫码登录 key 与二维码（qrimg 为可直接展示的 data URL） */
export const qrKey = async() => {
  const body = await loginUserGet('/v2/qrcode', {
    appid: 1001, type: 1, plat: 4,
    qrcode_txt: `${QR_URL_PREFIX}?appid=${APPID}&`,
    srcappid: SRC_APPID,
  })
  const key = body.data?.qrcode
  if (!key) throw new Error('获取二维码 key 失败')
  const qrurl = `${QR_URL_PREFIX}?qrcode=${key}`
  const qrimg = body.data.qrcode_img
    || await import('qrcode').then(m => m.default.toDataURL(qrurl)).catch(() => '')
  return { key, qrurl, qrimg }
}

/**
 * 轮询扫码状态（沿用登录路由的 800/801/802/803 语义，酷狗原生为 0/1/2/4）
 * @returns {{ code: 800|801|802|803, message?: string, profile? }} 800 过期 / 801 等待 / 802 已扫码 / 803 已授权（完成登录）
 */
export const qrCheck = async(key) => {
  const body = await loginUserGet('/v2/get_userinfo_qrcode', {
    plat: 4, appid: APPID, srcappid: SRC_APPID, qrcode: key,
  })
  const qrStatus = body.data?.status
  if (qrStatus === 4) {
    const { token, userid } = body.data
    if (!token) throw new Error('登录响应中缺少 token')
    return { code: 803, message: '登录成功', profile: await applyKgLogin({ token, userid }) }
  }
  const map = { 0: [800, '二维码已过期'], 1: [801, '等待扫码'], 2: [802, '已扫码，待确认'] }
  const [code, message] = map[qrStatus] ?? [qrStatus, `未知状态 ${qrStatus}`]
  return { code, message }
}

// ---- 手机验证码登录 ----
// 参考 KuGouMusicApi captcha_sent / login_cellphone：签名数据中 mobile 打码
// （前 2 位 + ***** + 末位），完整号码与验证码走 AES 随机密钥加密；
// pk = RSA 裸加密 {clienttime_ms, key}，服务端解出密钥后还原 params。

const signLoginKey = (clienttimeMs) => md5(`${APPID}${SALT_SIGN}${LOGIN_CLIENTVER}${clienttimeMs}`)

/** 发送短信验证码（businessid 5 = 登录场景） */
export const sendCaptcha = async(mobile) => {
  const body = await gatewayRequest('/v7/send_mobile_code', {
    router: 'login.user.kugou.com',
    params: { clientver: LOGIN_CLIENTVER },
    data: { businessid: 5, mobile: String(mobile), plat: 3 },
  })
  if (body.status !== 1) {
    const err = new Error(body.error ?? body.msg ?? '验证码发送失败')
    ;(err as any).status = 502
    throw err
  }
  return { sent: true }
}

/** 手机验证码登录（mobile + code，成功后自动保存凭据并返回账号资料） */
export const cellphoneLogin = async({ mobile, code }) => {
  const clienttimeMs = Date.now()
  const enc = aesEncryptRandom({ mobile: String(mobile), code: String(code) })
  const body = await gatewayRequest('/v7/login_by_verifycode', {
    host: 'https://loginserviceretry.kugou.com',
    params: { clientver: LOGIN_CLIENTVER },
    data: {
      plat: 1,
      support_multi: 1,
      t1: 0,
      t2: 0,
      clienttime_ms: clienttimeMs,
      mobile: `${String(mobile).slice(0, 2)}*****${String(mobile).slice(10, 11)}`,
      key: signLoginKey(clienttimeMs),
      pk: rsaEncryptHex({ clienttime_ms: clienttimeMs, key: enc.key }).toUpperCase(),
      params: enc.str,
      t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
    },
    headers: {
      'User-Agent': 'Android16-1070-11440-130-0-LOGIN-wifi',
      'support-calm': '1',
    },
  })
  if (body.status !== 1) {
    const err = new Error(body.error ?? `登录失败（code ${body.error_code ?? '未知'}）`)
    ;(err as any).status = 401
    throw err
  }
  const decrypted = body.data?.secu_params ? aesDecryptHex(body.data.secu_params, enc.key) : null
  const token = typeof decrypted === 'object' ? decrypted?.token : decrypted
  if (!token) throw new Error('登录响应解密失败')
  return applyKgLogin({ token, userid: decrypted?.userid ?? body.data?.userid ?? 0 })
}

// ---- token 自动续期 ----
// login_by_token 协议：
//   p3 = AES({clienttime, token})，密钥由固定串派生；params = AES({})（随机密钥）；
//   pk = RSA 裸加密 {clienttime_ms, key: 随机密钥}（右侧零填充 128 字节）；
//   成功响应 data.secu_params 用随机密钥 AES 解密得到新 token。

const AES_KEY_SEED = '90b8382a1bb4ccdcf063102053fd75b8'
const AES_IV = 'f063102053fd75b8'

const aesCbcEncryptHex = (data: string, keyHex: string, ivHex: string) => {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'utf8'), Buffer.from(ivHex, 'utf8'))
  return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('hex')
}

const aesEncryptRandom = (data: string | object) => {
  const tempKey = randomString(16)
  const keyHex = md5(tempKey)
  return {
    str: aesCbcEncryptHex(typeof data === 'string' ? data : JSON.stringify(data), keyHex, keyHex.slice(16, 32)),
    key: tempKey,
  }
}

const aesDecryptHex = (hex: string, tempKey: string) => {
  const keyHex = md5(tempKey)
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(keyHex, 'utf8'), Buffer.from(keyHex.slice(16, 32), 'utf8'))
  const out = Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()])
  const text = out.toString('utf8')
  try { return JSON.parse(text) } catch { return text }
}

/** RSA 裸加密（零填充 128 字节，与参考实现一致：负载在前、零在后） */
const rsaEncryptHex = (data: object) => {
  const payload = Buffer.from(JSON.stringify(data))
  if (payload.length > 128) throw new Error('RSA 负载超长')
  const padded = Buffer.concat([payload, Buffer.alloc(128 - payload.length)])
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex')
}

/**
 * 刷新 kg token（login_by_token），成功后写回凭据存储。
 * 无登录态时返回 { skipped: true }；网关拒绝（token 已失效等）抛错。
 */
export const refreshLogin = async() => {
  const cred = getCredentials('kg') as KgCredentials | null
  if (!cred?.token || cred.userid === '' || cred.userid === 0 || cred.userid === '0') {
    return { skipped: true }
  }

  const clienttime = Math.floor(Date.now() / 1000)
  const p3 = aesCbcEncryptHex(JSON.stringify({ clienttime, token: cred.token }), md5(AES_KEY_SEED), AES_IV)
  const enc = aesEncryptRandom({})
  const pk = rsaEncryptHex({ clienttime_ms: clienttime * 1000, key: enc.key })

  const body = await gatewayRequest('/v5/login_by_token', {
    router: 'login.user.kugou.com',
    params: { clientver: 20349 },
    data: {
      p3,
      params: enc.str,
      userid: Number(cred.userid) || 0,
      need_toneinfo: 1,
      clienttime_ms: clienttime * 1000,
      dfid: '-',
      dev: 'SDY-AN00',
      plat: 1,
      pk,
      t1: '0',
      gitversion: 'a23c277',
      t2: '0',
      t3: 'MCwwLDEsMSwwLDYsMSw2LDA=',
    },
    headers: {
      'kg-thash': '6a6a1ba',
      'User-Agent': 'Android12-AndroidPhone-20349-201-0-ting#958959317/661004247-LOGIN-wifi',
      'support-calm': '1',
    },
  })

  if (body.error_code !== 0 || !body.data?.secu_params) {
    throw new Error(`刷新失败（code ${body.error_code}${body.error ? `: ${body.error}` : ''}）`)
  }
  const decrypted = aesDecryptHex(body.data.secu_params, enc.key)
  if (!decrypted?.token) throw new Error('刷新响应解密失败')
  setCredentials('kg', { token: decrypted.token })
  return { refreshed: true }
}

/** 当前 kg 登录资料（未登录返回 null） */
export const status = () => {
  const cred = getCredentials('kg')
  return cred?.token ? { userid: cred.userid, nickname: cred.nickname ?? null } : null
}
