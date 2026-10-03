// 懒人听书登录（web 通道 m.lrts.me/ajax/logon）
// 参考社区下载器（yoval/lrts 等）：POST form {account, pwd: base64(password)}，
// 成功响应 json.phone 非空，Set-Cookie 种下会话；取流接口必须携带该会话
// （免费章节匿名也返回"收费章节未购买"，2026-10-02 实测）。
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from '../auth/store.ts'

const UA_MI = 'Mozilla/5.0 (Linux; U; Android 4.1.1; zh-cn; MI2 Build/JRO03L) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 XiaoMi/MiuiBrowser/1.0'
const LOGON_URL = 'https://m.lrts.me/ajax/logon'

/** 账号密码登录（成功保存会话 Cookie） */
export const login = async({ account, password }: { account: string, password: string }) => {
  const form = `account=${encodeURIComponent(account)}&pwd=${Buffer.from(String(password), 'utf8').toString('base64')}`
  const { statusCode, body, headers } = await httpFetch(LOGON_URL, {
    method: 'post',
    headers: {
      'User-Agent': UA_MI,
      Referer: 'https://m.lrts.me/',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    timeout: 15000,
  }).promise as any
  const b = body ?? {}
  if (statusCode != 200 || !b.phone) {
    const err = new Error(b.msg || '登录失败（账号或密码错误）')
    ;(err as any).status = 401
    throw err
  }
  const setCookies = (headers as any)?.['set-cookie'] ?? []
  const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
    .map((c: string) => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  if (!cookie) throw new Error('登录成功但未返回会话 Cookie')
  setCredentials('lr', { cookie, phone: String(b.phone) })
  return { logged: true, phone: String(b.phone) }
}

/** 登录会话 Cookie（未登录返回空串） */
export const getLrCookie = (): string => (getCredentials('lr') as any)?.cookie || ''

/** 登录状态 */
export const status = () => {
  const cred = getCredentials('lr') as { cookie?: string, phone?: string, updatedAt?: string } | null
  return cred?.cookie
    ? { logged: true, phone: cred.phone, updatedAt: cred.updatedAt }
    : { logged: false }
}

export default { login, getLrCookie, status }
