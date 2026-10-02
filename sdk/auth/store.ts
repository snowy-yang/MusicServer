// 登录态存储 —— 各平台凭据持久化（data/auth.json，不入库）
// 结构：{ wy: {...}, kg: {...}, tx: {...}, _kg_device: {...}, _qs_device: {...}, _qs_passport_device: {...} }
// 凭据是明文敏感数据：文件以 0600 创建；写入走「同目录临时文件 + rename」原子替换，
// 避免写中途崩溃留下截断 JSON（那会导致下次启动解析失败而丢掉全部平台凭据）。
// DATA_DIR 环境变量可覆盖存储目录（测试用，避免污染真实登录态）。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : join(dirname(fileURLToPath(import.meta.url)), '../../data')
const DATA_FILE = join(DATA_DIR, 'auth.json')

export interface WyCredentials {
  cookie: string
  musicU: string
  userid?: number
  nickname?: string | null
  avatar?: string | null
  vipType?: number | null
  updatedAt?: string
}

export interface KgCredentials {
  token: string
  userid: number | string
  nickname?: string | null
  updatedAt?: string
}

export interface KgDevice {
  guid: string
  mid: string
  dfid: string
  updatedAt?: string
}

export interface TxCredentials {
  cookie: string
  // App 抓包的完整凭据（可选）：提供后可自动续期（music.login.LoginServer），
  // 仅浏览器 cookie 时 qm_keyst 无法主动续期，只能做 VIP 检测
  openId?: string
  accessToken?: string
  refreshToken?: string
  refreshKey?: string
  uin?: string
  vipType?: 'svip' | 'vip' | 'normal' | null
  updatedAt?: string
}

export interface XmCredentials {
  // www.ximalaya.com 登录 Cookie（须含 1&_token，从已登录浏览器请求头复制）
  // baseInfo 付费内容授权依赖它；无法主动续期，失效后需重新复制绑定
  cookie: string
  updatedAt?: string
}

export interface MeCredentials {
  // App 登录 Cookie（须含 token=，从猫耳 App 抓包或已登录 m.missevan.com 浏览器复制）
  // App API 付费声音授权依赖它；无法主动续期
  cookie: string
  updatedAt?: string
}

export interface LrCredentials {
  // m.lrts.me 登录会话 Cookie（/login/lr 账号密码登录后由服务端保存）
  // 取流接口必须携带（免费章节也要求登录态）
  cookie: string
  phone?: string
  updatedAt?: string
}

let cache: Record<string, any> = {}
let loaded = false

const load = (): Record<string, any> => {
  if (loaded) return cache
  if (!existsSync(DATA_FILE)) {
    cache = {}
    loaded = true
    return cache
  }
  try {
    cache = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
  } catch (err) {
    // 解析失败绝不能静默清空：先改名备份，让残留凭据仍可人工抢救；
    // 否则下一次 setCredentials 就会用空表覆盖掉本可恢复的文件。
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`
    try {
      renameSync(DATA_FILE, backup)
      console.error(`[auth/store] ${DATA_FILE} 解析失败，已备份为 ${backup}，本次以空凭据启动: ${(err as Error).message}`)
    } catch {
      console.error(`[auth/store] ${DATA_FILE} 解析失败且备份未成功，本次以空凭据启动: ${(err as Error).message}`)
    }
    cache = {}
  }
  loaded = true
  return cache
}

const save = (data: Record<string, any>): void => {
  cache = data
  loaded = true
  mkdirSync(dirname(DATA_FILE), { recursive: true })
  // 原子写：先落同目录临时文件（0600，仅属主可读），再 rename 覆盖。
  // 直接覆写会在进程中途被杀时留下截断 JSON —— 那正是「凭据全丢」的触发路径。
  const tmp = `${DATA_FILE}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, DATA_FILE)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 清理失败不掩盖原始错误 */ }
    throw err
  }
}

export const getCredentials = (platform: string): any => load()[platform] ?? null

export const setCredentials = (platform: string, credentials: Record<string, any>): void => {
  const data = load()
  data[platform] = { ...data[platform], ...credentials, updatedAt: new Date().toISOString() }
  save(data)
}

export const clearCredentials = (platform: string): void => {
  const data = load()
  delete data[platform]
  save(data)
}

/** wy 登录 cookie 字符串（未登录返回空串） */
export const getWyCookie = (): string => (getCredentials('wy') as WyCredentials | null)?.cookie || ''

/** kg 登录态（未登录返回 null） */
export const getKgAuth = (): { token: string; userid: number | string } | null => {
  const cred = getCredentials('kg') as KgCredentials | null
  return cred?.token ? { token: cred.token, userid: cred.userid || 0 } : null
}

/** tx(QQ) 登录态：cookie 与其中的 uin（未登录返回 null） */
export const getTxAuth = (): { cookie: string; uin: string } | null => {
  const cred = getCredentials('tx') as TxCredentials | null
  if (!cred?.cookie) return null
  const uin = cred.cookie.match(/uin=(\d+)/)?.[1] ?? '0'
  return { cookie: cred.cookie, uin }
}
