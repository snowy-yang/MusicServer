// 5sing 歌单（上游 fivesing/fivesing.go + playlist.go 移植）
// 搜索: GET http://search.5sing.kugou.com/home/json?...&type=1  → list[].songListId/title/pictureUrl/playCount/userName/songCnt/content/userId
//       上游对 userName 为空的条目再调 getsonglist?songfields=user 补创建者名（并发 10）；本移植用同样回退、并发 5。
// 详情: ① GET mobileapi.5sing.kugou.com/song/getsonglist?id=&songfields=ID,user（元数据 T/C/P/H/E + user.ID/NN）
//       ② 抓 http://5sing.kugou.com/{userId}/dj/{id}.html 解析 <li class="p_rel"> 块（上游 parseSongsFromHTML）
//       ③ 数字 userId 页会 302 到个性域名页（如 /yeluoluo/dj/...），httpFetch 不跟跳 → util.fetch5sing 手动跟跳。
// 分类/个人歌单：上游显式返回不支持（model.ErrPlaylistCategoriesUnsupported / ErrUserPlaylistsUnsupported），本移植保留同样语义（抛错）。
// 链接解析: 上游正则只认数字 userId；本移植放宽支持个性域名（/name/dj/xxx.html）与省略 user 段，ID 以 API 反查为准。

import { MOBILE_API, SEARCH_API, fetch5sing, fetch5singJson, removeEmTags, unescapeHtml, buildSongLink, buildPlaylistLink, extractPlaylistLink, kindName } from './util.ts'

/** 上游 GetPlaylistCategories / GetCategoryPlaylists：显式不支持 */
export const getCategories = async() => {
  throw new Error('playlist categories not supported')
}
export const getCategoryPlaylists = async(_categoryId?: any, _page = 1, _limit = 30) => {
  throw new Error('playlist categories not supported')
}

/** 歌单列表项（HTML 解析出的歌曲）→ 统一 Song 形状 */
const mapPlaylistSong = (songID: string, kind: string, name: string, artist: string) => ({
  songmid: `${songID}|${kind}`,
  name,
  singer: artist,
  albumId: '',
  albumName: '',
  interval: 0,
  img: null,
  lrc: null,
  types: [],
  _types: {},
  songType: kind,
  typeName: kindName(kind),
  link: buildSongLink(kind, songID),
  source: '5sing' as const,
})

/**
 * 上游 parseSongsFromHTML：从歌单页 HTML 提取歌曲。
 * 块正则 `<li class="p_rel">([\s\S]*?)</li>`；块内 href 提取 yc/fc/bz 与 id，s_soner 提取歌手（上游的拼写错误 soner 保留）。
 */
export const parseSongsFromHTML = (htmlContent: string) => {
  const blocks = [...String(htmlContent ?? '').matchAll(/<li class="p_rel">([\s\S]*?)<\/li>/g)]
  if (!blocks.length) throw new Error('no songs found in playlist html (structure mismatch)')

  // 上游正则要求 href="http://5sing.kugou.com/..."；这里放宽协议（http/https/协议相对）
  const songRe = /href="(?:(?:https?:)?\/\/)?5sing\.kugou\.com\/(yc|fc|bz)\/(\d+)\.html"[^>]*>([^<]+)<\/a>/
  const artistRe = /class="s_soner[^"]*".*?>([^<]+)<\/a>/

  const songs: any[] = []
  const seen = new Set<string>()
  for (const match of blocks) {
    const blockHTML = match[1]
    const songMatch = songRe.exec(blockHTML)
    if (!songMatch) continue
    const kind = songMatch[1]
    const songID = songMatch[2]
    const rawName = songMatch[3]

    let artist = 'Unknown'
    const artistMatch = artistRe.exec(blockHTML)
    if (artistMatch) artist = artistMatch[1]

    const uniqueKey = `${kind}|${songID}`
    if (seen.has(uniqueKey)) continue
    seen.add(uniqueKey)

    const name = removeEmTags(unescapeHtml(rawName)).trim()
    artist = removeEmTags(unescapeHtml(artist)).trim()
    songs.push(mapPlaylistSong(songID, kind, name, artist))
  }
  return songs
}

/** 上游 fetchCreatorName：userName 为空时用 getsonglist?songfields=user 反查创建者名（data 必须是对象） */
export const fetchCreatorName = async(playlistId: string): Promise<string> => {
  if (!playlistId) return ''
  try {
    const { statusCode, body } = await fetch5singJson(`${MOBILE_API}/song/getsonglist?id=${encodeURIComponent(playlistId)}&songfields=user`)
    if (statusCode != 200 || !body || typeof body !== 'object') return ''
    const data = body.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
    return String(data?.user?.NN ?? '')
  } catch {
    return ''
  }
}

/** 歌单搜索项 → 摘要（与既有平台 playlist 搜索项对齐） */
const mapPlaylistSummary = (item: any) => {
  const id = String(item?.songListId ?? '')
  const userId = String(item?.userId ?? '')
  const desc = removeEmTags(unescapeHtml(item?.content))
  const creator = String(item?.userName ?? '') || (userId ? `ID: ${userId}` : '')
  return {
    id,
    name: removeEmTags(unescapeHtml(item?.title)),
    cover: String(item?.pictureUrl ?? ''),
    trackCount: Number(item?.songCnt) || 0,
    playCount: Number(item?.playCount) || 0,
    creator,
    creatorId: userId,
    // 上游怪癖：content 为字符串 "0" 时视为空简介
    description: desc === '0' ? '' : desc,
    link: buildPlaylistLink(userId, id),
    source: '5sing' as const,
  }
}

/** 上游 SearchPlaylist（type=1），补创建者名（并发 5） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const word = String(keyword ?? '').trim()
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 20)
  const empty = { list: [] as any[], total: 0, page: pageNo, limit: pageSize, source: '5sing' as const }
  if (!word) return empty

  const url = `${SEARCH_API}?keyword=${encodeURIComponent(word)}&sort=1&page=${pageNo}&filter=0&type=1`
  const { statusCode, body } = await fetch5singJson(url)
  if (statusCode != 200) throw new Error(`5sing 歌单搜索失败（HTTP ${statusCode}）`)

  const rawList: any[] = Array.isArray(body?.list) ? body.list : []
  const list = rawList.slice(0, pageSize).map(mapPlaylistSummary)

  // 上游并行回退：item.userName 为空时反查真实创建者名（失败保留 "ID: xxx"）
  const targets = list.filter((pl) => pl.creatorId && pl.creator === `ID: ${pl.creatorId}`)
  for (let i = 0; i < targets.length; i += 5) {
    await Promise.all(targets.slice(i, i + 5).map(async(pl) => {
      const name = await fetchCreatorName(pl.id)
      if (name) pl.creator = name
    }))
  }

  const total = Number(body?.pageInfo?.totalCount) || list.length
  return { list, total, page: pageNo, limit: pageSize, source: '5sing' as const }
}

/** 元数据 + 全量曲目（上游 fetchPlaylistDetail 核心；HTML 不分页，一次拿全） */
export const fetchPlaylistAll = async(playlistIdRaw: string) => {
  const playlistId = String(playlistIdRaw ?? '').trim()
  if (!playlistId) throw new Error('invalid 5sing playlist id')

  // 1) API 元数据（标题/封面/统计/UserID）
  const { statusCode, body } = await fetch5singJson(
    `${MOBILE_API}/song/getsonglist?id=${encodeURIComponent(playlistId)}&songfields=ID,user`,
  )
  if (statusCode != 200) throw new Error(`fetch info failed: HTTP ${statusCode}`)

  // 上游用 RawMessage 判多态：歌单不存在/无权限时 data 为 []（数组），直接报错
  const data = body?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('playlist info not found or invalid (api returned empty list)')
  }

  const userId = String(data?.user?.ID ?? '')
  if (!userId) throw new Error('playlist user not found or invalid id')

  const playlist = {
    id: playlistId,
    name: String(data?.T ?? ''),
    cover: String(data?.P ?? ''),
    trackCount: Number(data?.E) || 0,
    playCount: Number(data?.H) || 0,
    creator: String(data?.user?.NN ?? ''),
    description: String(data?.C ?? ''),
    link: buildPlaylistLink(userId, playlistId),
    userId,
    source: '5sing' as const,
  }

  // 2) 歌单页 HTML（数字 userId 会 302 → 个性域名页，fetch5sing 已跟跳）
  const page = await fetch5sing(playlist.link)
  if (page.statusCode != 200) throw new Error(`fetch html failed: HTTP ${page.statusCode}`)

  // 3) 解析曲目（上游：解析失败不影响元数据返回，返回空列表）
  let songs: any[] = []
  try {
    songs = parseSongsFromHTML(String(page.body ?? ''))
  } catch {
    songs = []
  }
  return { playlist, songs }
}

/** 歌单详情（分页切片；total 为解析到的有效曲目数，trackCount 保留上游元数据 E） */
export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const { playlist, songs } = await fetchPlaylistAll(id)
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 50)
  const start = (pageNo - 1) * pageSize
  const list = songs.slice(start, start + pageSize)
  const total = songs.length
  return {
    source: '5sing' as const,
    info: {
      id: playlist.id,
      name: playlist.name,
      img: playlist.cover,
      desc: playlist.description,
      author: playlist.creator,
      link: playlist.link,
      trackCount: playlist.trackCount,
      playCount: playlist.playCount,
    },
    list,
    page: pageNo,
    limit: pageSize,
    total,
    allPage: Math.ceil(total / pageSize) || 1,
  }
}

/** 上游 GetPlaylistSongs：仅返回曲目列表（全量） */
export const getPlaylistSongs = async(id: string) => {
  const { songs } = await fetchPlaylistAll(id)
  return songs
}

/** 上游 ParsePlaylist：歌单链接 → 详情（全量曲目，匹配上游返回全部歌曲的行为） */
export const parsePlaylistLink = async(link: string) => {
  const parsed = extractPlaylistLink(link)
  if (!parsed) throw new Error('invalid 5sing playlist link')
  const { playlist, songs } = await fetchPlaylistAll(parsed.playlistId)
  return {
    source: '5sing' as const,
    info: {
      id: playlist.id,
      name: playlist.name,
      img: playlist.cover,
      desc: playlist.description,
      author: playlist.creator,
      link: playlist.link,
      trackCount: playlist.trackCount,
      playCount: playlist.playCount,
    },
    list: songs,
    page: 1,
    limit: songs.length || 1,
    total: songs.length,
    allPage: 1,
  }
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  getCategories,
  getCategoryPlaylists,
  parsePlaylistLink,
}
