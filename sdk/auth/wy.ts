// 网易云登录 —— 扫码 / 手机号，weapi 加密请求
// 参考实现：NeteaseCloudMusicApi（login_qr_key / login_qr_check / login_cellphone / login_status）

import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { weapi } from '../wy/utils/crypto.ts'
import { getWyCookie, setCredentials } from './store.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const requestWeapi = async(path, data, cookie = getWyCookie()) => {
  const r = await httpFetch(`https://music.163.com/weapi${path}`, {
    method: 'post',
    headers: {
      'User-Agent': UA,
      origin: 'https://music.163.com',
      Referer: 'https://music.163.com/',
      ...(cookie ? { cookie } : {}),
    },
    form: weapi(data),
    timeout: 15000,
  }).promise
  if (r.statusCode !== 200) throw new Error('网易请求失败')
  return { body: r.body, setCookie: r.headers['set-cookie'] ?? [] }
}

/** 明文 api 请求（二维码接口只提供该形态，weapi 形态已 404） */
const requestApi = async(path, data) => {
  const r = await httpFetch(`https://music.163.com${path}`, {
    method: 'post',
    headers: {
      'User-Agent': UA,
      origin: 'https://music.163.com',
      Referer: 'https://music.163.com/',
    },
    form: data,
    timeout: 15000,
  }).promise
  if (r.statusCode !== 200) throw new Error('网易请求失败')
  return { body: r.body, setCookie: r.headers['set-cookie'] ?? [] }
}

/** 从 Set-Cookie 数组提取登录 cookie 串与 MUSIC_U */
const extractLoginCookie = (setCookie) => {
  const joined = setCookie.map(c => c.split(';')[0]).filter(Boolean).join('; ')
  const musicU = /MUSIC_U=([^;]+)/.exec(joined)?.[1]
  return { cookie: joined, musicU }
}

/** 登录成功后拉取账号资料 */
const fetchProfile = async() => {
  const { body } = await requestWeapi('/api/w/nuser/account/get', {})
  return {
    userid: body?.account?.id ?? null,
    nickname: body?.profile?.nickname ?? null,
    avatar: body?.profile?.avatarUrl ?? null,
    vipType: body?.profile?.vipType ?? null,
  }
}

/** 应用登录 cookie（成功后调用） */
const applyLogin = async(setCookie) => {
  const { cookie, musicU } = extractLoginCookie(setCookie)
  if (!musicU) throw new Error('登录响应中缺少 MUSIC_U')
  const profile = await fetchProfile()
  setCredentials('wy', { cookie, musicU, ...profile })
  return profile
}

/** 创建扫码登录 key 与二维码内容 */
export const qrKey = async() => {
  const { body } = await requestApi('/api/login/qrcode/unikey', { type: 3 })
  if (body?.code !== 200 || !body.unikey) throw new Error('获取二维码 key 失败')
  const key = body.unikey
  const qrurl = `https://music.163.com/login?codekey=${key}`
  const qrimg = await import('qrcode').then(m => m.default.toDataURL(qrurl)).catch(() => '')
  return { key, qrurl, qrimg }
}

/**
 * 轮询扫码状态
 * @returns {{ code: 800|801|802|803, message?: string, profile? }} 800 过期 / 801 等待 / 802 已扫码 / 803 已授权（完成登录）
 */
export const qrCheck = async(key) => {
  const { body, setCookie } = await requestApi('/api/login/qrcode/client/login', { key, type: 3 })
  if (body.code === 803) {
    const profile = await applyLogin(setCookie)
    return { code: 803, message: '登录成功', profile }
  }
  const messages = { 800: '二维码已过期', 801: '等待扫码', 802: '已扫码，待确认' }
  return { code: body.code, message: messages[body.code] ?? body.message ?? '未知状态' }
}

/**
 * 手机号登录（密码为明文，传输前本地 MD5；或直接传验证码 captcha）
 */
export const cellphoneLogin = async({ phone, password, captcha, countrycode = '86' }) => {
  const data = {
    type: '1',
    https: 'true',
    phone,
    countrycode,
    remember: 'true',
    [captcha ? 'captcha' : 'password']: captcha ?? crypto.createHash('md5').update(password ?? '').digest('hex'),
  }
  const { body, setCookie } = await requestWeapi('/api/w/login/cellphone', data)
  if (body.code !== 200) {
    const err = new Error(body.message ?? body.msg ?? '登录失败')
    ;(err as any).status = 401
    throw err
  }
  const profile = await applyLogin(setCookie)
  return profile
}

/**
 * 手动绑定 cookie（从已登录的 music.163.com 浏览器请求头复制，须含 MUSIC_U）。
 * 绑定前用 account/get 实测校验，失效直接报 401，与 kg 绑定 token 同款语义。
 */
export const loginByCookie = async(cookieInput: string) => {
  const cookie = String(cookieInput || '').trim()
  const musicU = /MUSIC_U=([^;\s]+)/.exec(cookie)?.[1]
  if (!musicU) throw Object.assign(new Error('cookie 需包含 MUSIC_U 字段'), { status: 422 })
  const { body } = await requestWeapi('/api/w/nuser/account/get', {}, cookie)
  if (!body?.account?.id) {
    throw Object.assign(new Error('cookie 无效或已过期（MUSIC_U 校验未通过）'), { status: 401 })
  }
  const profile = {
    userid: body.account.id,
    nickname: body.profile?.nickname ?? null,
    avatar: body.profile?.avatarUrl ?? null,
    vipType: body.profile?.vipType ?? null,
  }
  setCredentials('wy', { cookie, musicU, ...profile })
  return profile
}

/** 当前账号资料（未登录返回 null） */
export const status = async() => {
  if (!getWyCookie()) return null
  return fetchProfile()
}
