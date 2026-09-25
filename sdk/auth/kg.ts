// 酷狗登录 —— token 绑定与验证（网关 android 签名，与 KuGouMusicApi 对齐）
// 完整的手机号/扫码登录需移植其 RSA/AES 全套协议，后续按需扩展；
// token 可从酷狗 App 抓包获取（login.token）

import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from './store.ts'

const md5 = s => crypto.createHash('md5').update(s).digest('hex')
const SALT_KEY = '57ae12eb6890223e355ccfcb74edf70d'
const SALT_SIGN = 'OIlwieks28dk2k092lksi2UIkp'
const APPID = 1005
const CLIENTVER = 11430
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

/** 网关移动端签名请求（gateway.kugou.com + x-router） */
const gatewayRequest = async(url, { params: extraParams, data, router }) => {
  const dev = getDevice()
  const params = {
    dfid: dev.dfid, mid: dev.mid, uuid: '-', appid: APPID, clientver: CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    ...extraParams,
  }
  const signature = androidSign(params, data ? JSON.stringify(data) : '')
  const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
  const r = await httpFetch(`https://gateway.kugou.com${url}?${qs}&signature=${signature}`, {
    method: 'post',
    headers: {
      dfid: dev.dfid, mid: dev.mid, clienttime: String(params.clienttime),
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      'x-router': router,
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
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

/** 当前 kg 登录资料（未登录返回 null） */
export const status = () => {
  const cred = getCredentials('kg')
  return cred?.token ? { userid: cred.userid, nickname: cred.nickname ?? null } : null
}
