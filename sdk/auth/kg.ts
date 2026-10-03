// 酷狗登录 —— token 绑定 / 扫码 / 短信验证码 / 账号密码（与 MakcRe/KuGouMusicApi 协议对齐）
// 扫码走 login-user.kugou.com 的 web 签名通道；短信走 android 签名 + AES/RSA；
// 账密走 /v9/login_by_pwd，触发 20028 风控时返回验证码挑战（ssa-code 事件 +
// sid/edt 行为指纹，指纹由 kgSimulate.ts 服务端生成，无需浏览器 WASM）；
// token 也可从酷狗 App 抓包获取（login.token）后经 /login/kg 绑定

import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from './store.ts'
import { generateSimulate } from './kgSimulate.ts'
import type { KgCredentials } from './store.ts'

const md5 = s => crypto.createHash('md5').update(s).digest('hex')
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

/** RSA PKCS1 v1.5 加密（register_dev 专用；与登录的 RSA 裸填充不同） */
const rsaEncryptPkcs1Hex = (data: object) =>
  crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(JSON.stringify(data), 'utf8')).toString('hex')

// ---- 设备 dfid 正式注册（userservice.kugou.com /risk/v2/r_register_dev）----
// 随机 dfid 匿名取流易撞 20028 验证；注册后的 dfid 是官方客户端形态，可显著降低风控。
// 协议（参考 KuGouMusicApi register_dev.js）：设备画像 → AES-128-CBC(随机 6 位 key，
// key=md5(key)[0:16]、iv=md5(key)[16:32]) → base64 作 body；p = RSA-PKCS1({aes:key, uid, token})。
// 响应为原始二进制密文（非 JSON），按 base64 解码后同密钥 AES 解密得 {status, data:{dfid}}。

const playlistAesEncrypt = (data: object) => {
  const key = randomString(6)
  const keyHex = md5(key)
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyHex.slice(0, 16), 'utf8'), Buffer.from(keyHex.slice(16, 32), 'utf8'))
  return {
    key,
    str: Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]).toString('base64'),
  }
}

const playlistAesDecrypt = (rawBase64: string, key: string) => {
  const keyHex = md5(key)
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyHex.slice(0, 16), 'utf8'), Buffer.from(keyHex.slice(16, 32), 'utf8'))
  const out = Buffer.concat([d.update(Buffer.from(rawBase64, 'base64')), d.final()]).toString('utf8')
  try { return JSON.parse(out) } catch { return out }
}

/** 注册正式 dfid（幂等：已注册直接返回；失败抛错由调用方决定是否容忍） */
export const registerDfid = async() => {
  const dev = getDevice()
  if ((dev as any).dfidRegistered) return dev

  const cred = getCredentials('kg') as KgCredentials | null
  const userid = Number(cred?.userid || 0)
  const deviceMap = {
    availableRamSize: 4983533568, availableRomSize: 48114719, availableSDSize: 48114717,
    basebandVer: '', batteryLevel: 100, batteryStatus: 3,
    brand: 'Redmi', buildSerial: 'unknown', device: 'marble',
    imei: dev.guid, imsi: '', manufacturer: 'Xiaomi', uuid: dev.guid,
    accelerometer: false, accelerometerValue: '', gravity: false, gravityValue: '',
    gyroscope: false, gyroscopeValue: '', light: false, lightValue: '',
    magnetic: false, magneticValue: '', orientation: false, orientationValue: '',
    pressure: false, pressureValue: '', step_counter: false, step_counterValue: '',
    temperature: false, temperatureValue: '',
  }
  const enc = playlistAesEncrypt(deviceMap)
  const p = rsaEncryptPkcs1Hex({ aes: enc.key, uid: userid, token: cred?.token || '' })

  const params: Record<string, any> = {
    dfid: dev.dfid, mid: dev.mid, uuid: '-', appid: APPID, clientver: CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    part: 1, platid: 1, p,
  }
  params.signature = androidSign(params, enc.str)
  const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
  const r = await httpFetch(`https://userservice.kugou.com/risk/v2/r_register_dev?${qs}`, {
    method: 'post',
    headers: {
      dfid: dev.dfid, mid: dev.mid, clienttime: String(params.clienttime),
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    },
    body: enc.str,
    timeout: 15000,
  }).promise as any

  // 响应为二进制密文：raw base64 → AES 解密
  const raw = r.raw ? Buffer.from(r.raw).toString('base64') : Buffer.from(JSON.stringify(r.body ?? '')).toString('base64')
  const body = playlistAesDecrypt(raw, enc.key)
  if (body?.status !== 1 || !body.data?.dfid) {
    throw new Error(`dfid 注册失败（status ${body?.status ?? '未知'} ${body?.error ?? ''}）`.trim())
  }
  const updated = { ...dev, dfid: String(body.data.dfid), dfidRegistered: true }
  setCredentials('_kg_device', updated)
  return updated
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

/** 网关移动端签名请求（默认 gateway.kugou.com + x-router，可 host 直连登录专用域）；withHeaders 时返回 { body, headers } */
const gatewayRequest = async(url, { params: extraParams, data, router, host = 'https://gateway.kugou.com', headers: extraHeaders = {}, withHeaders = false }: {
  params?: Record<string, any>
  data?: any
  router?: string
  host?: string
  headers?: Record<string, string>
  withHeaders?: boolean
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
  if (withHeaders) return { body: r.body ?? {}, headers: (r as any).headers ?? {} }
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

// ---- 账号密码登录（/v9/login_by_pwd）+ 20028 验证码挑战 ----
// 参考 KuGouMusicApi login.js / get_verify_info.js / verify_user_info.js 与 issue #206：
//   密码与验证码走 AES 随机密钥加密（params/pk）；风控触发时响应 error_code=20028，
//   事件 id 在响应头 ssa-code（gz_tx_event_xxx）；/verifyservice/v3/get_verify_info
//   按 data.url/v_type 区分验证类型（23 腾讯滑块、32 手机验证码、22 活体、34 人脸…）；
//   验证结果经 /v4/verify_user_info 提交（verifycode 格式 KGCodeXX|{json} 或短信码），
//   sid/edt 为行为指纹（kgSimulate 服务端生成），随后重试登录（短信码经 code 字段随密文上送）。

// login_by_pwd 的设备校验常量（与参考实现一致，疑似风控指纹固定值）
const PWD_T1 = '562a6f12a6e803453647d16a08f5f0c2ff7eee692cba2ab74cc4c8ab47fc467561a7c6b586ce7dc46a63613b246737c03a1dc8f8d162d8ce1d2c71893d19f1d4b797685a4c6d3d81341cbde65e488c4829a9b4d42ef2df470eb102979fa5adcdd9b4eecfea8b909ff7599abeb49867640f10c3c70fc444effca9d15db44a9a6c907731e2bb0f22cd9b3536380169995693e5f0e2424e3378097d3813186e3fe96bbe7023808a0981b4e2b6135a76faac'
const PWD_T2 = '31c4daf4cf480169ccea1cb7d4a209295865a9d2b788510301694db229b87807469ea0d41b4d4b9173c2151da7294aeebfc9738df154bbdf11a4e117bb5dff6a3af8ce5ce333e681c1f29a44038f27567d58992eb81283e080778ac77db1400fdf49b7cf7e26be2e5af4da7830cc3be4'
const PWD_T3 = 'MCwwLDAsMCwwLDAsMCwwLDA='
const PWD_CLIENTVER = 11440

// 验证码类型（get_verify_info 的 data.url 前缀 / v_type）
const VERIFY_VTYPES: Record<string, string> = {
  16: 'QQ 绑定验证', 18: '微信绑定验证', 22: '活体认证', 23: '滑块/图形验证码', 32: '手机短信验证码', 34: '人脸核身',
}
const VERIFY_URL_TYPES: Record<string, string> = {
  KGCodeGT: '极验', KGCodeTX: '腾讯', KGCodeKG: '酷狗旋转', KGCodeKG2: '酷狗滑块', KGCodeSM: '数美', KGCodeYD: '易盾',
}

export interface VerifyChallenge {
  eventid: string
  v_type: number
  vTypeLabel: string
  url?: string
  provider?: string
  txappid?: string
  sessionid?: string
  sid: string
  edt: string
}

/** 查询验证事件详情（/verifyservice/v3/get_verify_info） */
export const getVerifyInfo = async(eventid: string) => {
  const body = await gatewayRequest('/verifyservice/v3/get_verify_info', {
    data: {
      eventid, userid: Number(getCredentials('kg')?.userid ?? 0), platid: 2, rtype: 1,
      wasm: 1, i: '', sid: '', edt: '',
    },
  })
  if (body.status !== 1 && body.error_code !== 0) {
    throw new Error(body.error ?? `查询验证信息失败（code ${body.error_code ?? '未知'}）`)
  }
  return body.data ?? {}
}

/** 提交验证结果（/v4/verify_user_info，verifycode 为 KGCodeXX|{json} 或短信码） */
export const verifyUserInfo = async({ eventid, v_type, verifycode, sid, edt }: {
  eventid: string
  v_type: number
  verifycode: string
  sid?: string
  edt?: string
}) => {
  const dev = getDevice()
  const userid = Number(getCredentials('kg')?.userid ?? 0)
  const fp = sid && edt ? { sid, edt } : generateSimulate(dev.mid, userid, dev.dfid)
  const dataMap: Record<string, any> = {
    eventid, userid, platid: 2, v_type: Number(v_type) || 23, wasm: 1, i: '',
    sid: fp.sid, edt: fp.edt,
  }
  if (dataMap.v_type === 32) {
    // 手机短信验证码：明文 code + 密文 params 均携带
    const enc = aesEncryptRandom({ code: verifycode })
    Object.assign(dataMap, {
      code: verifycode, verifycode,
      pk: rsaEncryptHex({ key: enc.key }), params: enc.str,
    })
  } else {
    // 滑块等图形验证码：KGCodeXX|{ticket,...} 明文上送
    const enc = aesEncryptRandom({})
    Object.assign(dataMap, {
      verifycode,
      pk: rsaEncryptHex({ key: enc.key }), params: enc.str,
    })
  }
  const body = await gatewayRequest('/v4/verify_user_info', {
    host: 'https://verifyservice.kugou.com',
    params: { clientver: 11510 },
    data: dataMap,
  })
  if (body.status !== 1) {
    const err = new Error(body.error ?? `验证提交失败（code ${body.error_code ?? '未知'}）`)
    ;(err as any).status = 401
    throw err
  }
  return { verified: true }
}

/**
 * 账号密码登录（/v9/login_by_pwd）
 * 成功返回账号资料；命中 20028 风控返回 VerifyChallenge（先 /login/kg/verify 提交验证，
 * 短信码场景再带 code 重试本接口）
 */
export const passwordLogin = async({ username, password, code }: { username: string, password: string, code?: string }) => {
  // 账密登录风控最敏感，先确保 dfid 已正式注册（失败容忍，随机 dfid 继续尝试）
  await registerDfid().catch(() => {})
  const clienttimeMs = Date.now()
  const enc = aesEncryptRandom({ pwd: String(password), code: String(code || ''), clienttime_ms: clienttimeMs })
  const { body, headers } = await gatewayRequest('/v9/login_by_pwd', {
    router: 'login.user.kugou.com',
    params: { clientver: PWD_CLIENTVER },
    data: {
      plat: 1,
      support_multi: 1,
      clienttime_ms: clienttimeMs,
      t1: PWD_T1,
      t2: PWD_T2,
      t3: PWD_T3,
      dev: 'SDY-AN00',
      username: String(username),
      params: enc.str,
      pk: rsaEncryptHex({ clienttime_ms: clienttimeMs, key: enc.key }).toUpperCase(),
    },
    headers: {
      'User-Agent': `Android16-1070-${PWD_CLIENTVER}-130-0-LOGIN-wifi`,
      'support-calm': '1',
    },
    withHeaders: true,
  }) as { body: any, headers: Record<string, any> }

  if (body.status === 1 && body.data?.secu_params) {
    const decrypted = aesDecryptHex(body.data.secu_params, enc.key)
    const token = typeof decrypted === 'object' ? decrypted?.token : decrypted
    if (!token) throw new Error('登录响应解密失败')
    return applyKgLogin({ token, userid: decrypted?.userid ?? body.data?.userid ?? 0 })
  }

  if (body.error_code === 20028) {
    const eventid = String(headers?.['ssa-code'] ?? headers?.['SSA-CODE'] ?? body.ssaCode ?? '')
    if (!eventid) {
      throw new Error('触发风控验证但未返回事件 id（ssa-code），请改用扫码或短信登录')
    }
    const dev = getDevice()
    const userid = Number(getCredentials('kg')?.userid ?? 0)
    const { sid, edt } = generateSimulate(dev.mid, userid, dev.dfid)
    const info = await getVerifyInfo(eventid).catch(() => ({}) as any)
    const vType = Number(info.v_type ?? 23)
    const url: string = String(info.url ?? '')
    const provider = Object.keys(VERIFY_URL_TYPES).find(k => url.includes(k))
    const challenge: VerifyChallenge = {
      eventid,
      v_type: vType,
      vTypeLabel: VERIFY_VTYPES[vType] ?? `未知类型 ${vType}`,
      url: url || undefined,
      provider: provider ? VERIFY_URL_TYPES[provider] : undefined,
      txappid: info.txappid,
      sessionid: info.sessionid,
      sid,
      edt,
    }
    return challenge
  }

  const err = new Error(body.error ?? `登录失败（code ${body.error_code ?? '未知'}）`)
  ;(err as any).status = 401
  throw err
}

/** 当前 kg 登录资料（未登录返回 null） */
export const status = () => {
  const cred = getCredentials('kg')
  return cred?.token ? { userid: cred.userid, nickname: cred.nickname ?? null } : null
}
