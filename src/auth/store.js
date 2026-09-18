// 登录态存储 —— 各平台凭据持久化（data/auth.json，不入库）
// 结构：{ wy: { cookie, musicU, userid?, nickname?, updatedAt }, kg: { token, userid, nickname?, updatedAt } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../data/auth.json')

let cache = null

const load = () => {
  if (!cache) {
    try {
      cache = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : {}
    } catch {
      cache = {}
    }
  }
  return cache
}

const save = (data) => {
  cache = data
  mkdirSync(dirname(DATA_FILE), { recursive: true })
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

export const getCredentials = (platform) => load()[platform] ?? null

export const setCredentials = (platform, credentials) => {
  const data = load()
  data[platform] = { ...data[platform], ...credentials, updatedAt: new Date().toISOString() }
  save(data)
}

export const clearCredentials = (platform) => {
  const data = load()
  delete data[platform]
  save(data)
}

/** wy 登录 cookie 字符串（未登录返回空串） */
export const getWyCookie = () => getCredentials('wy')?.cookie || ''

/** kg 登录态（未登录返回 null） */
export const getKgAuth = () => {
  const cred = getCredentials('kg')
  return cred?.token ? { token: cred.token, userid: cred.userid || 0 } : null
}
