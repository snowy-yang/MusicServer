// 千千音乐歌单
// 详情：/v1/tracklist/info?id=&type=0&pageNo=&pageSize=（支持分页，默认 pageSize=20）
// 分类：/v1/tracklist/category（group.categoryName + subCate[]）
// 分类歌单：/v1/tracklist/list?subCateId=&pageNo=&pageSize=（不传 subCateId 为全部）
// 搜索：上游用 /v1/search?type=6，但 2026-10 实测服务端已下线该搜索类型
//   （errno 23001 "不被支持的搜索类型(10000)"），官网搜索页也只有 单曲/歌手/专辑 三个 tab；
//   上游在 !state 时静默返回空列表，本实现保持一致并保留 typeSonglist 解析以备恢复。
import { APP_ID, apiGet, apiOk, firstNonEmpty, mapTrack, playlistLink } from './util.ts'

const mapPlaylistSummary = (item: any) => {
  const id = item?.id == null ? '' : String(item.id)
  const rawDesc = String(item?.desc ?? '').trim()
  const tagList = Array.isArray(item?.tagList) ? item.tagList : []
  return {
    id,
    name: String(item?.title ?? '').trim(),
    cover: String(item?.pic ?? '').trim(),
    trackCount: Number(item?.trackCount ?? 0) || 0,
    creator: firstNonEmpty(item?.creator, item?.author, item?.userName, item?.nickName, item?.ownerName),
    description: rawDesc || tagList.join('、'),
    link: id ? playlistLink(id) : '',
    source: 'bd' as const,
  }
}

/** 上游 SearchPlaylist（type=6 歌单搜索；服务端已停用，返回空列表） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 10) => {
  const word = String(keyword ?? '').trim()
  const empty = { source: 'bd' as const, list: [] as any[], total: 0, page, limit }
  if (!word) return empty

  const body = await apiGet('/v1/search', {
    word,
    type: '6',
    pageNo: String(page),
    pageSize: String(limit),
    appid: APP_ID,
  })
  if (!body?.state) return empty

  const items = Array.isArray(body?.data?.typeSonglist) ? body.data.typeSonglist : []
  const list = items.map(mapPlaylistSummary).filter((item: any) => item.id)
  return { source: 'bd' as const, list, total: Number(body?.data?.total) || list.length, page, limit }
}

/** 歌单详情（含曲目；tracklist/info 支持 pageNo/pageSize） */
export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const playlistId = String(id ?? '').trim()
  if (!playlistId) throw new Error('千千歌单 id 为空')

  const body = await apiGet('/v1/tracklist/info', {
    id: playlistId,
    type: '0',
    pageNo: String(Math.max(1, page)),
    pageSize: String(Math.max(1, limit)),
    appid: APP_ID,
  })
  if (!apiOk(body)) throw new Error(body?.errmsg || `千千歌单获取失败（errno ${body?.errno}）`)

  const data = body?.data ?? {}
  const rawTracks = Array.isArray(data?.trackList) ? data.trackList : []
  const list = rawTracks.map((item: any) => mapTrack(item)).filter((song: any) => song.songmid)

  const title = firstNonEmpty(data?.title, playlistId)
  const tagList = Array.isArray(data?.tagList) ? data.tagList : []
  const cover = firstNonEmpty(data?.pic, list[0]?.img)
  const creator = firstNonEmpty(data?.creator, data?.author, data?.userName, data?.nickName, data?.ownerName)
  const description = firstNonEmpty(data?.desc, data?.description) || tagList.join('、')
  const total = Number(data?.trackCount) || list.length

  return {
    source: 'bd' as const,
    info: { id: playlistId, name: title, img: cover, desc: description, author: creator, link: playlistLink(playlistId) },
    list,
    page,
    limit,
    total,
    allPage: Math.ceil(total / Math.max(1, limit)) || 1,
  }
}

/** 上游 GetPlaylistSongs：只取曲目列表 */
export const getPlaylistSongs = async(id: string) => {
  const { list } = await getPlaylistDetail(id, 1, 1000)
  return list
}

/**
 * 上游 GetPlaylistCategories
 * 返回 { source, list: [{ id, name, group, count }] }，首项为 "全部"（id=''）。
 */
export const getCategories = async() => {
  const body = await apiGet('/v1/tracklist/category', { appid: APP_ID })
  if (!apiOk(body)) throw new Error(body?.errmsg || `千千歌单分类获取失败（errno ${body?.errno}）`)

  const list: Array<{ id: string; name: string; group: string; count?: number }> = [
    { id: '', name: '全部', group: '全部' },
  ]
  for (const group of Array.isArray(body?.data) ? body.data : []) {
    const groupName = String(group?.categoryName ?? '').trim()
    for (const item of Array.isArray(group?.subCate) ? group.subCate : []) {
      const id = String(item?.id ?? '').trim()
      const name = String(item?.categoryName ?? '').trim()
      if (!id || !name) continue
      list.push({ id, name, group: groupName, count: Number(item?.count ?? 0) || 0 })
    }
  }
  return { source: 'bd' as const, list }
}

/** 上游 GetCategoryPlaylists（page >= 1，limit 1..100） */
export const getCategoryPlaylists = async(categoryId: string | number, page = 1, limit = 30) => {
  const cateId = String(categoryId ?? '').trim()
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 30))

  const params: Record<string, any> = { appid: APP_ID, pageNo: String(pageNo), pageSize: String(pageSize) }
  if (cateId) params.subCateId = cateId

  const body = await apiGet('/v1/tracklist/list', params)
  if (!apiOk(body)) throw new Error(body?.errmsg || `千千分类歌单获取失败（errno ${body?.errno}）`)

  const result = Array.isArray(body?.data?.result) ? body.data.result : []
  const list = result
    .map((item: any) => ({ ...mapPlaylistSummary(item), categoryId: cateId }))
    .filter((item: any) => item.id)
  return {
    source: 'bd' as const,
    list,
    total: Number(body?.data?.total) || list.length,
    page: pageNo,
    limit: pageSize,
  }
}

/** 上游 ParsePlaylist：songlist/tracklist/playlist 链接、*id= 参数、或裸歌单 id */
export const parsePlaylistLink = async(link: string) => {
  const raw = String(link ?? '').trim()
  const patterns = [
    /music\.91q\.com\/(?:songlist|tracklist|playlist)\/([A-Za-z0-9]+)/,
    /(?:songlistid|tracklistid|playlistid|id)=([A-Za-z0-9]+)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    if (match) return getPlaylistDetail(match[1])
  }
  if (raw && !raw.includes('/')) return getPlaylistDetail(raw)
  throw new Error('无效的千千歌单链接')
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  getCategories,
  getCategoryPlaylists,
  parsePlaylistLink,
}
