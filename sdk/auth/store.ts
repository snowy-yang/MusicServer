// 登录态存储 —— 各平台凭据持久化（data/auth.json，不入库）
// 结构：{ wy: {...}, kg: {...}, tx: {...}, _kg_device: {...} }
// 注意：store.js 为 tsc 就地发射产物（不入库）；改逻辑只改本文件，然后 pnpm build

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../data/auth.json')

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
  updatedAt?: string
}

let cache: Record<string, any> = {}
let loaded = false

const load = (): Record<string, any> => {
  if (loaded) return cache
  try {
    cache = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : {}
  } catch {
    cache = {}
  }
  loaded = true
  return cache
}

const save = (data: Record<string, any>): void => {
  cache = data
  loaded = true
  mkdirSync(dirname(DATA_FILE), { recursive: true })
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
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
