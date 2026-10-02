// 网易云歌单（上游 music-lib/netease/playlist.go 移植）
// 搜索/分类：复用现有 wy/songList（search=cloudsearch type1000、getTag=catalogue、getList=playlist/list）
// 推荐：weapi/personalized/playlist（上游 GetRecommendedPlaylists，匿名可用）
// 详情/曲目：复用 songList.getListDetail（linuxapi forward），按 page/limit 切片
// 链接解析：#/playlist?id= / /playlist?id= / /playlist/<id>/<n>/... / 裸数字 id（上游 parseNeteaseLink）
import { httpFetch } from '../request.ts'
import { weapi } from './utils/crypto.ts'
import { formatPlayCount } from '../index.ts'
import { getWyCookie } from '../auth/store.ts'
import songList from './songList.ts'
import { parseNeteaseLink } from './link.ts'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36'
// catalogue/list 接口固定页大小（songList.limit_list = 30，运行时读取以避免模块环上的 TDZ）
const apiLimit = () => Number(songList.limit_list) || 30

const playlistLink = (id: string) => `https://music.163.com/#/playlist?id=${id}`

/** 歌单摘要：兼容既有 songList 字段并补 spec 形状（id/name/cover/trackCount/creator/...） */
const toSummary = (item: any, categoryId?: string) => {
  const id = String(item?.id ?? '').trim()
  if (!id) return null
  const trackCount = Number(item?.trackCount ?? item?.total ?? 0) || 0
  const playCount = Number(item?.playCount ?? 0) || 0
  return {
    ...item,
    id,
    name: item?.name ?? '',
    cover: item?.cover ?? item?.img ?? '',
    trackCount,
    playCount,
    play_count: item?.play_count ?? formatPlayCount(playCount),
    creator: item?.creator ?? item?.author ?? '',
    description: item?.description ?? item?.desc ?? '',
    link: playlistLink(id),
    source: 'wy' as const,
    ...(categoryId ? { categoryId } : {}),
  }
}

/** 歌单搜索（上游 SearchPlaylist；复用 songList.search） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const result = await songList.search(String(keyword ?? ''), page, limit)
  const list = (result?.list ?? []).map(item => toSummary(item)).filter(Boolean)
  return { list, page, limit, total: result?.total ?? list.length, source: 'wy' as const }
}

/** 歌单详情（上游 fetchPlaylistDetail；复用 songList.getListDetail，按 page/limit 切片） */
export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const detail = await songList.getListDetail(String(id ?? ''), 1)
  const start = Math.max(0, (page - 1) * limit)
  return {
    source: 'wy' as const,
    info: detail.info,
    list: detail.list.slice(start, start + limit),
    page,
    limit,
    total: detail.total ?? detail.list.length,
  }
}

/** 歌单曲目全量（上游 GetPlaylistSongs） */
export const getPlaylistSongs = async(id: string) => (await songList.getListDetail(String(id ?? ''), 1)).list

/** 歌单分类（上游 GetPlaylistCategories；复用 songList.getTag/getHotTag 并摊平） */
export const getCategories = async() => {
  const [groups, hotTags] = await Promise.all([
    songList.getTag().catch(() => []),
    songList.getHotTag().catch(() => []),
  ])
  const hotSet = new Set((hotTags ?? []).map((item: any) => String(item.id)))
  const list: any[] = [{ id: '', name: '全部', group: '全部' }]
  const seen = new Set<string>([''])
  for (const group of groups ?? []) {
    for (const item of group?.list ?? []) {
      const id = String(item?.id ?? '').trim()
      const name = String(item?.name ?? '').trim()
      if (!id || !name || seen.has(id)) continue
      seen.add(id)
      list.push({ id, name, group: group.name ?? '', hot: hotSet.has(id) })
    }
  }
  return { source: 'wy' as const, list }
}

/** 分类歌单（上游 GetCategoryPlaylists；接口每页 30 条，按入参 limit 重新切片） */
export const getCategoryPlaylists = async(categoryId: string, page = 1, limit = 20) => {
  const cat = String(categoryId ?? '').trim() || '全部'
  const start = Math.max(0, (page - 1) * limit)
  const apiPages = Math.max(1, Math.ceil((start + limit) / apiLimit()))
  const items: any[] = []
  let total = 0
  for (let apiPage = 1; apiPage <= apiPages; apiPage++) {
    const result = await songList.getList('hot', cat, apiPage)
    total = Number(result?.total ?? total) || total
    const batch = result?.list ?? []
    items.push(...batch)
    if (batch.length < apiLimit()) break
  }
  const list = items.slice(start, start + limit).map(item => toSummary(item, cat)).filter(Boolean)
  return { list, page, limit, total: total || items.length, source: 'wy' as const }
}

/** 推荐歌单（上游 GetRecommendedPlaylists：weapi/personalized/playlist） */
export const getRecommended = async(page = 1, limit = 20) => {
  const cookie = getWyCookie()
  const { statusCode, body } = await httpFetch('https://music.163.com/weapi/personalized/playlist', {
    method: 'post',
    headers: {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      origin: 'https://music.163.com',
      ...(cookie ? { cookie } : {}),
    },
    form: weapi({ limit: 30, total: true, n: 1000 }),
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || body?.code != 200) {
    throw new Error(`wy 推荐歌单获取失败 (code ${body?.code ?? statusCode})`)
  }

  const rawList: any[] = body?.result ?? []
  const list = rawList.map(item => {
    const id = String(item?.id ?? '').trim()
    if (!id) return null
    const playCount = Number(item?.playCount ?? 0) || 0
    return {
      id,
      name: item?.name ?? '',
      cover: item?.picUrl ?? '',
      trackCount: Number(item?.trackCount ?? 0) || 0,
      playCount,
      play_count: formatPlayCount(playCount),
      creator: item?.copywriter || '网易云推荐',
      description: item?.copywriter ?? '',
      link: playlistLink(id),
      alg: item?.alg ?? '',
      source: 'wy' as const,
    }
  }).filter(Boolean)
  if (!list.length) throw new Error('no recommended playlists found')

  const start = Math.max(0, (page - 1) * limit)
  return { list: list.slice(start, start + limit), page, limit, total: list.length, source: 'wy' as const }
}

export const getRecommendedPlaylists = getRecommended

/** 歌单链接解析（上游 ParsePlaylist） */
export const parsePlaylistLink = async(link: string) => {
  const raw = String(link ?? '').trim()
  if (!raw) throw new Error('无效的网易云歌单链接')
  if (/^\d+$/.test(raw)) return getPlaylistDetail(raw)
  const { kind, id } = parseNeteaseLink(raw)
  if (kind !== 'playlist') throw new Error('无效的网易云歌单链接')
  return getPlaylistDetail(id)
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  getCategories,
  getCategoryPlaylists,
  getRecommended,
  getRecommendedPlaylists,
  parsePlaylistLink,
}
