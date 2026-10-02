// 酷我歌单 —— 搜索 / 详情 / 分类 / 分类歌单 / 推荐 / 链接解析
// 上游对应：music-lib/kuwo/playlist.go
// 复用既有内部实现（不重复造轮子）：
//   - 搜索：songList.search
//   - 详情：songList.getListDetail（nplserver，服务端固定 1000 条/页，本地按 page/limit 开窗）
//   - 分类：songList.getTag / getHotTag（同上游 getTagList / getRcmTagList）
//   - 分类歌单 / 推荐：songList.getList（wapi getTagPlayList / getRcmPlayList）
// 上游 GetRecommendedPlaylists 用 getRcmPlayList(order=hot) 且 limit=30；既有 getList 的
// limit_list=36（模块常量），故推荐条数以 36 为准，显式 limit 更小时本地截断。
import songList from './songList.ts'

// songList.getListDetailUrl 固定 rn=limit_song=1000
const SERVER_PAGE_SIZE = 1000
const MAX_SERVER_PAGES = 60

const firstNonEmpty = (...values: any[]): string => {
  for (const value of values) {
    if (value == null) continue
    const str = String(value).trim()
    if (str) return str
  }
  return ''
}

/** 歌单链接 / digest 前缀 id → 平台内部 id（digest 前缀形态原样保留，交给 songList 分流） */
const normalizePlaylistId = (id: any): string => {
  const raw = String(id ?? '').trim()
  if (!raw) return ''
  const patterns = [
    /playlist_detail\/(\d+)/, // http://www.kuwo.cn/playlist_detail/2886046289
    /\/playlist\/(\d+)/, // https://m.kuwo.cn/h5app/playlist/2736267853?t=qqfriend
    /playlistId=(\d+)/,
  ]
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (match) return match[1]!
  }
  return raw
}

/** 歌单摘要（对齐契约形状：id/name/cover/trackCount/playCount/creator/description/link/source） */
const toSummary = (item: any) => {
  const id = String(item?.id ?? '').trim()
  const plainId = id.replace(/^digest-\w+__/, '')
  const playCount = Number(item?.play_count)
  return {
    ...item,
    id,
    name: String(item?.name ?? '').trim(),
    cover: firstNonEmpty(item?.img, item?.cover),
    trackCount: Number(item?.total ?? item?.trackCount ?? 0) || 0,
    playCount: Number.isFinite(playCount) ? playCount : (item?.play_count ?? 0),
    creator: firstNonEmpty(item?.author, item?.creator, item?.uname),
    description: firstNonEmpty(item?.desc, item?.description),
    link: plainId ? `http://www.kuwo.cn/playlist_detail/${plainId}` : '',
    source: 'kw' as const,
  }
}

/** 歌单搜索（上游 SearchPlaylist；复用 songList.search 的 legacy r.s 接口） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const word = String(keyword ?? '').trim()
  if (!word) return { source: 'kw' as const, list: [] as any[], page, limit, total: 0 }
  const res = await songList.search(word, page, limit)
  const list = (res?.list ?? []).map(toSummary).filter((item: any) => item.id)
  return {
    source: 'kw' as const,
    list,
    page,
    limit,
    total: Number(res?.total ?? 0) || list.length,
  }
}

/**
 * 歌单详情（含元数据与曲目）
 * 服务端 1000 条/页，按调用方 page/limit 开窗，只抓所需的 1~2 个服务端页。
 */
export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const playlistId = normalizePlaylistId(id)
  if (!playlistId) throw new Error('酷我歌单 id 为空')
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 50)
  const start = (pageNo - 1) * pageSize

  let serverPage = Math.floor(start / SERVER_PAGE_SIZE) + 1
  let skip = start % SERVER_PAGE_SIZE
  const list: any[] = []
  let info: any = null
  let total = 0

  while (list.length < pageSize && serverPage <= MAX_SERVER_PAGES) {
    const res = await songList.getListDetail(playlistId, serverPage)
    if (!res) break
    if (!info) info = res.info ?? null
    total = Number(res.total ?? 0) || total
    const rawList: any[] = res.list ?? []
    if (!rawList.length) break
    list.push(...rawList.slice(skip, skip + (pageSize - list.length)))
    skip = 0
    if (rawList.length < SERVER_PAGE_SIZE) break
    if (total > 0 && serverPage * SERVER_PAGE_SIZE >= total) break
    serverPage += 1
  }

  return {
    source: 'kw' as const,
    info: {
      name: firstNonEmpty(info?.name, playlistId),
      img: firstNonEmpty(info?.img),
      desc: firstNonEmpty(info?.desc),
      author: firstNonEmpty(info?.author),
      play_count: info?.play_count ?? '',
    },
    list,
    page: pageNo,
    limit: pageSize,
    total: total || list.length,
  }
}

/** 上游 GetPlaylistSongs：聚合全部页曲目（去重） */
export const getPlaylistSongs = async(id: string) => {
  const playlistId = normalizePlaylistId(id)
  if (!playlistId) throw new Error('酷我歌单 id 为空')
  const songListResult: any[] = []
  const seen = new Set<string>()
  for (let serverPage = 1; serverPage <= MAX_SERVER_PAGES; serverPage++) {
    const res = await songList.getListDetail(playlistId, serverPage)
    const rawList: any[] = res?.list ?? []
    for (const song of rawList) {
      const key = String(song?.songmid ?? '')
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      songListResult.push(song)
    }
    const total = Number(res?.total ?? 0) || 0
    if (rawList.length < SERVER_PAGE_SIZE) break
    if (total > 0 && songListResult.length >= total) break
  }
  return songListResult
}

/** 歌单分类（上游 GetPlaylistCategories；复用 getTag/getHotTag，tagId 形如 `<id>-<digest>`） */
export const getCategories = async() => {
  const { tags, hotTag } = await songList.getTags()
  const hotIds = new Set((hotTag ?? []).map((item: any) => String(item?.id ?? '')))
  const list: Array<{ id: string, name: string, group: string, hot?: boolean }> = [
    { id: '', name: '全部', group: '全部' },
  ]
  for (const group of tags ?? []) {
    for (const item of group?.list ?? []) {
      const id = String(item?.id ?? '').trim()
      const name = String(item?.name ?? '').trim()
      if (!id || !name) continue
      list.push({ id, name, group: String(group?.name ?? '').trim() || '其他', hot: hotIds.has(id) })
    }
  }
  return { source: 'kw' as const, list }
}

/**
 * 分类歌单（上游 GetCategoryPlaylists）
 * categoryId 为空 → getRcmPlayList(order=hot)；否则按 `<id>-<digest>` 走 getTagPlayList。
 */
export const getCategoryPlaylists = async(categoryId: string, page = 1, limit = 20) => {
  const tagId = String(categoryId ?? '').trim()
  const pageNo = Math.max(1, Number(page) || 1)
  const res = await songList.getList('hot', tagId || undefined, pageNo)
  let list = (res?.list ?? []).map(toSummary).filter((item: any) => item.id)
  const requested = Number(limit) || 0
  const serverLimit = Number(res?.limit ?? 0) || 0
  if (requested > 0 && list.length > requested) list = list.slice(0, requested)
  return {
    source: 'kw' as const,
    list,
    page: pageNo,
    limit: (requested > 0 && serverLimit > 0 ? Math.min(requested, serverLimit) : serverLimit) || list.length,
    total: Number(res?.total ?? 0) || list.length,
  }
}

/** 推荐歌单（上游 GetRecommendedPlaylists；复用 getList(order=hot)） */
export const getRecommended = async(page = 1, limit = 30) => {
  const pageNo = Math.max(1, Number(page) || 1)
  const res = await songList.getList('hot', undefined, pageNo)
  let list = (res?.list ?? []).map(toSummary).filter((item: any) => item.id)
  const requested = Number(limit) || 0
  const serverLimit = Number(res?.limit ?? 0) || 0
  if (requested > 0 && list.length > requested) list = list.slice(0, requested)
  return {
    source: 'kw' as const,
    list,
    page: pageNo,
    limit: (requested > 0 && serverLimit > 0 ? Math.min(requested, serverLimit) : serverLimit) || list.length,
    total: Number(res?.total ?? 0) || list.length,
  }
}

/** 上游 ParsePlaylist：playlist_detail/<id>、m.kuwo.cn/h5app/playlist/<id>（含 ?/# 尾串） */
export const parsePlaylistLink = async(link: string) => {
  const match = String(link ?? '').match(/playlist_detail\/(\d+)/) ||
    String(link ?? '').match(/\/playlist\/(\d+)/) ||
    String(link ?? '').match(/playlistId=(\d+)/)
  if (!match) throw new Error('无效的酷我歌单链接')
  return getPlaylistDetail(match[1]!, 1)
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  getCategories,
  getCategoryPlaylists,
  getRecommended,
  parsePlaylistLink,
}
