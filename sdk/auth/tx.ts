// QQ音乐凭据 —— cookie 解析、VIP 检测与登录态续期（music.login.LoginServer）
// 与 lx-music-api-server 的 refresh/tx.py 对齐，但走本项目既有的 musicu.fcg 未签名通道
// （与 apis/tx.ts 一致）；Login/VipLogin 模块若拒绝未签名请求则以 code != 0 失败，
// 此时保留原凭据并抛错，由调用方记录日志。
// 续期条件：仅浏览器 cookie（无 openId 等抓包字段）时只带 musicid/musickey 尝试，
// 失败率较高；完整凭据（/login/tx 可选传入 openId/accessToken/refreshToken/refreshKey）最可靠。

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
