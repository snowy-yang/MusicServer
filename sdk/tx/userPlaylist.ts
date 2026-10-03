// QQ音乐个人歌单（上游 music-lib/qq/user_playlist.go 移植）
// 需登录 cookie（sdk/auth/store.ts 的 getCredentials('tx').cookie，须含 uin 类字段）：
//   未登录/缺 uin 抛出清晰错误；不静默返回空列表
// 数据源（与上游一致，结果去重）：
//   1) fcg_user_created_diss  → 自建歌单
//   2) fcg_get_profile_order_asset reqtype=3 → 收藏歌单
//   3) fcg_get_profile_order_asset reqtype=1 → 「我喜欢的歌曲」虚拟歌单摘要（有歌才附上）
// 说明：虚拟条目的 id 为 profile:favorites（与上游一致），歌曲需凭 cookie 走同一接口拉取
import { httpFetch } from '../common/request.ts'
import { formatPlayCount } from '../index.ts'
import { getCredentials } from '../auth/store.ts'
import type { TxCredentials } from '../auth/store.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const FAVORITE_ID = 'profile:favorites'
const FAVORITE_NAME = '我喜欢的歌曲'

/** 内联读取 cookie（与 sdk/auth/store.ts 的 TxCredentials 同源；避免动 store） */
const readCookie = (): string => {
  const cred = getCredentials('tx') as TxCredentials | null
  return String(cred?.cookie ?? '').trim()
}

/** 上游 normalizeQQUIN：从 cookie 中按已知键取 uin */
const cookieValue = (cookie: string, key: string): string => {
  for (const part of cookie.split(';')) {
    const kv = part.trim().split(/=(.*)/s)
    if (kv.length === 2 && kv[0].trim() === key) return kv[1].trim()
  }
  return ''
}

export const normalizeQQUIN = (cookie: string): string => {
  const raw = [
    'wxuin', 'uin', 'ptui_loginuin', 'luin', 'pt2gguin', 'superuin', 'p_uin', 'musicid', 'userid',
  ].map(key => cookieValue(cookie, key)).find(value => value) ?? ''
  return raw.replace(/^o/, '').replace(/^0+/, '').trim()
}

const playlistLink = (id: string) => `https://y.qq.com/n/ryqq/playlist/${id}`

const normalizeCover = (cover: string): string => {
  const value = String(cover ?? '').trim()
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('http://')) return value.replace('http://', 'https://')
  return value
}

type PlaylistSummary = {
  id: string
  name: string
  cover: string
  trackCount: number
  playCount: number
  play_count: string
  creator: string
  description: string
  link: string
  source: 'tx'
}

const makeSummary = (partial: Partial<PlaylistSummary> & { id: string, name: string }): PlaylistSummary => {
  const playCount = Number(partial.playCount ?? 0) || 0
  return {
    id: partial.id,
    name: partial.name,
    cover: normalizeCover(partial.cover ?? ''),
    trackCount: Number(partial.trackCount ?? 0) || 0,
    playCount,
    play_count: formatPlayCount(playCount),
    creator: partial.creator ?? '',
    description: partial.description ?? '',
    link: partial.link ?? playlistLink(partial.id),
    source: 'tx',
  }
}

/** 上游 profileOrderAssetParams */
const profileAssetUrl = (uin: string, reqtype: string, page: number, limit: number) => {
  const offset = (Math.max(1, page) - 1) * limit
  const params = new URLSearchParams({
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    platform: 'yqq.json',
    needNewCode: '0',
    loginUin: uin,
    hostUin: '0',
    notice: '0',
    g_tk: '5381',
    ct: '20',
    cid: '205360956',
    userid: uin,
    reqtype,
    sin: String(offset),
    ein: String(offset + limit - 1),
  })
  return `https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg?${params.toString()}`
}

const fetchJson = async(url: string, cookie: string) => {
  const { statusCode, body } = await httpFetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/', Cookie: cookie },
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || !body || typeof body !== 'object') throw new Error('tx 个人歌单接口请求失败')
  return body
}

/** 自建歌单（上游 fcg_user_created_diss 段） */
const fetchCreated = async(cookie: string, uin: string, page: number, limit: number) => {
  const params = new URLSearchParams({
    hostuin: uin,
    sin: String((page - 1) * limit),
    size: String(limit),
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
  })
  const body = await fetchJson(`https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?${params.toString()}`, cookie)
  if (body.code != 0) throw new Error(`tx 自建歌单获取失败: ${body.message ?? ''} (code ${body.code})`)
  const list: any[] = []
  for (const item of body?.data?.disslist ?? []) {
    const dissID = Number(item?.dissid) || 0
    const tid = Number(item?.tid) || 0
    const dirID = Number(item?.dirid) || 0
    const id = dissID > 0 ? String(dissID) : tid > 0 ? String(tid) : dirID > 0 ? `profile:dir:${dirID}` : ''
    const name = String(item?.diss_name ?? item?.title ?? '').trim()
    if (!id || !name) continue
    list.push(makeSummary({
      id,
      name,
      cover: item?.diss_cover ?? item?.cover,
      trackCount: Number(item?.song_count ?? item?.song_num ?? item?.song_cnt ?? 0) || 0,
      playCount: Number(item?.listen_num ?? item?.visitnum ?? 0) || 0,
      creator: uin,
      description: String(item?.diss_desc ?? item?.desc ?? ''),
    }))
  }
  for (const item of body?.data?.list ?? []) {
    const id = String(item?.dissid ?? '').trim()
    const name = String(item?.dissname ?? '').trim()
    if (!id || !name) continue
    list.push(makeSummary({
      id,
      name,
      cover: item?.imgurl,
      trackCount: Number(item?.song_count ?? item?.song_num ?? 0) || 0,
      playCount: Number(item?.listennum ?? 0) || 0,
      creator: uin,
      description: String(item?.introduction ?? ''),
    }))
  }
  return list
}

/** 收藏歌单（上游 fetchProfileOrderPlaylists，reqtype=3） */
const fetchCollected = async(cookie: string, uin: string, page: number, limit: number) => {
  const body = await fetchJson(profileAssetUrl(uin, '3', page, limit), cookie)
  if (body.code != 0) return []
  const list: any[] = []
  for (const item of body?.data?.cdlist ?? []) {
    const id = Number(item?.dissid) || 0
    const name = String(item?.dissname ?? '').trim()
    if (id <= 0 || !name) continue
    list.push(makeSummary({
      id: String(id),
      name,
      cover: item?.logo,
      trackCount: Number(item?.songnum ?? 0) || 0,
      playCount: Number(item?.listennum ?? 0) || 0,
      creator: String(item?.nickname ?? item?.uin ?? uin),
    }))
  }
  return list
}

/** 「我喜欢的歌曲」摘要（上游 fetchFavoriteSongsPlaylistSummary，reqtype=1 limit=1） */
const fetchFavoriteSummary = async(cookie: string, uin: string) => {
  const body = await fetchJson(profileAssetUrl(uin, '1', 1, 1), cookie)
  if (body.code != 0) return null
  const total = Number(body?.data?.totalsong ?? 0) || 0
  if (total <= 0) return null
  const first = body?.data?.songlist?.[0]?.data
  return makeSummary({
    id: FAVORITE_ID,
    name: FAVORITE_NAME,
    cover: first?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${first.albummid}.jpg` : '',
    trackCount: total,
    creator: uin,
    description: 'QQ音乐我喜欢的歌曲',
    link: 'https://y.qq.com/n/ryqq/profile',
  })
}

/**
 * 个人歌单列表（上游 GetUserPlaylists）
 * 未登录（无 cookie 或无 uin）时抛出清晰错误，不返回空列表
 */
export const getList = async(page = 1, limit = 30) => {
  const cookie = readCookie()
  if (!cookie) throw new Error('tx 个人歌单需要登录 cookie（请先登录 QQ音乐）')
  const uin = normalizeQQUIN(cookie)
  if (!uin) throw new Error('tx 个人歌单需要 cookie 中的 uin（当前 cookie 不含 uin/wxuin 等字段）')

  const safePage = Math.max(1, Number(page) || 1)
  let safeLimit = Number(limit) || 30
  if (safeLimit <= 0) safeLimit = 30
  if (safeLimit > 100) safeLimit = 100

  const seen = new Set<string>()
  const list: PlaylistSummary[] = []
  const add = (summary: PlaylistSummary | null) => {
    if (!summary || !summary.id || !summary.name || seen.has(summary.id)) return
    seen.add(summary.id)
    list.push(summary)
  }

  try {
    add(await fetchFavoriteSummary(cookie, uin))
  } catch {
    // 摘要失败不阻塞列表（与上游一致）
  }
  for (const item of await fetchCreated(cookie, uin, safePage, safeLimit)) add(item)
  for (const item of await fetchCollected(cookie, uin, safePage, safeLimit)) add(item)

  return { list, page: safePage, limit: safeLimit, total: list.length, source: 'tx' as const }
}

export const getUserPlaylists = getList

export default { getList, getUserPlaylists, normalizeQQUIN }
