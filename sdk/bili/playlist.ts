// Bilibili 歌单（上游 bilibili/playlist.go；B站的"歌单"= 合集 ugc_season / 多分P稿件）
// SearchPlaylist: 用视频搜索 + view 判断，把「合集」和「多分P稿件」当歌单返回；
// GetPlaylistSongs / ParsePlaylist: id 约定 `season:<season_id>:<mid>:<bvid>` 或 `bvid:<bvid>`；
// GetPlaylistCategories / GetCategoryPlaylists: 上游显式返回 ErrPlaylistCategoriesUnsupported，本移植保持不支持（抛错）。
// 注意：上游用于补全合集信息的 x/space/ugc/season 接口现已 404，bvid 路径（view 内自带 sections）是主通道。
import { apiGet, buildSongsFromPages, buildSongsFromSeasonSections, cleanTitle, extractAid, extractBvid, fetchPageList, fetchSeasonArchiveIndex, fetchSeasonSongs, fetchView, mapLimit, normalizeCover } from './util.ts'

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type'

const countSeasonEpisodes = (sections: any[]): number => {
  let count = 0
  for (const sec of sections || []) count += (sec?.episodes || []).length
  return count
}

const seasonKey = (seasonId: any, mid: any, bvid: string) => `season:${seasonId}:${mid}:${bvid}`
const bvidKey = (bvid: string) => `bvid:${bvid}`

/** 搜索合集/多分P（上游 SearchPlaylist；page/limit 为移植新增的翻页能力，语义同其它平台） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(Math.max(1, Number(limit) || 20), 50)
  const url = `${SEARCH_URL}?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${p}&page_size=${l}`
  const { statusCode, body } = await apiGet(url)
  if (statusCode !== 200 || !body || typeof body !== 'object') {
    throw new Error(`B站歌单搜索失败（HTTP ${statusCode}）`)
  }
  if (body.code !== 0) {
    throw new Error(`B站歌单搜索失败（${body.code}${body.message ? `: ${body.message}` : ''}）`)
  }

  const items: any[] = body.data?.result ?? []
  const seen = new Set<string>()
  const result = await mapLimit(items, 4, async(item: any) => {
    if (!item?.bvid) return null
    const view = await fetchView(item.bvid)
    const cover = normalizeCover(item.pic || view?.pic || '')
    const season = view?.ugc_season
    if (season) {
      const id = seasonKey(season.id, view?.owner?.mid, item.bvid)
      if (seen.has(id)) return null
      seen.add(id)
      let trackCount = countSeasonEpisodes(season.sections)
      if (!trackCount && season.id && view?.owner?.mid) {
        try {
          trackCount = (await fetchSeasonSongs(view.owner.mid, season.id)).length
        } catch {
          // 上游 fetchSeasonSongs 失败同样保持 trackCount 0
        }
      }
      return {
        id,
        name: season.title || cleanTitle(item.title),
        cover: normalizeCover(season.cover) || cover,
        trackCount,
        playCount: Number(season?.stat?.view) || undefined,
        creator: view?.owner?.name || item.author || '',
        description: season.intro || '',
        link: `https://www.bilibili.com/video/${item.bvid}`,
        source: 'bili' as const,
      }
    }
    const pages: any[] = view?.pages ?? []
    if (pages.length > 1) {
      const id = bvidKey(item.bvid)
      if (seen.has(id)) return null
      seen.add(id)
      return {
        id,
        name: cleanTitle(item.title),
        cover,
        trackCount: pages.length,
        creator: view?.owner?.name || item.author || '',
        description: '',
        link: `https://www.bilibili.com/video/${item.bvid}`,
        source: 'bili' as const,
      }
    }
    return null
  })

  const list = result.filter(Boolean)
  return { list, page: p, limit: l, total: list.length, source: 'bili' as const }
}

/** 由 bvid 构造歌单详情（上游 GetPlaylistSongs 的 bvid 分支 + ParsePlaylist 的元数据） */
const detailFromBvid = async(bvid: string) => {
  const view = await fetchView(bvid)
  const realBvid = view?.bvid || bvid
  let pages: any[] = view?.pages ?? []
  if (pages.length <= 1) {
    const pageList = await fetchPageList(realBvid).catch(() => null)
    if (pageList?.length) pages = pageList
  }
  if (!pages.length) throw new Error('未找到视频分P')
  const songs = buildSongsFromPages(realBvid, view?.title || '', view?.owner?.name || '', view?.pic || '', pages)
  return {
    info: {
      name: view?.title || realBvid,
      img: normalizeCover(view?.pic || ''),
      desc: String(view?.desc || ''),
      author: view?.owner?.name || '',
    },
    songs,
  }
}

/** 由 `season:<season_id>:<mid>:<bvid>` 构造歌单详情（上游 GetPlaylistSongs 的 season 分支） */
const detailFromSeason = async(seasonId: string, mid: string, bvid: string) => {
  let info = { name: '', img: '', desc: '', author: '' }
  let songs: any[] = []

  if (bvid) {
    const view = await fetchView(bvid)
    const season = view?.ugc_season
    if (season) {
      let archiveIndex: Record<string, { title: string, cover: string, duration: number }> = {}
      let seasonTitle = season.title || ''
      let seasonCover = season.cover || ''
      // 上游会先拉 archive 索引补全缺失字段；该接口现已 404，失败时按空索引继续
      const idx = await fetchSeasonArchiveIndex(mid, seasonId).catch(() => null)
      if (idx) {
        archiveIndex = idx.index
        seasonTitle = seasonTitle || idx.title
        seasonCover = seasonCover || idx.cover
      }
      songs = buildSongsFromSeasonSections(season.sections || [], seasonTitle, seasonCover, view?.owner?.name || '', archiveIndex)
      info = {
        name: seasonTitle || view?.title || '',
        img: normalizeCover(seasonCover || view?.pic || ''),
        desc: season.intro || '',
        author: view?.owner?.name || '',
      }
    }
  }

  if (!songs.length) {
    songs = await fetchSeasonSongs(mid, seasonId)
    if (!info.name) {
      const idx = await fetchSeasonArchiveIndex(mid, seasonId).catch(() => null)
      if (idx) info = { ...info, name: idx.title || '', img: normalizeCover(idx.cover || ''), desc: '', author: '' }
    }
  }
  if (!songs.length) throw new Error('合集为空或合集接口不可用')
  return { info, songs }
}

/** 解析 id（兼容链接/裸 BV/av/bvid: 前缀） */
const resolveId = async(id: string): Promise<{ kind: 'link' | 'season' | 'bvid', value: string, parts?: string[] }> => {
  const raw = String(id || '').trim()
  if (/^https?:/i.test(raw)) return { kind: 'link', value: raw }
  if (/^season:/i.test(raw)) return { kind: 'season', value: raw, parts: raw.split(':') }
  // 注意先去 `bvid:` 前缀再提 BV：extractBvid 的大小写不敏感匹配会把前缀 "bvid" 本身当成 BV 号
  const bvid = extractBvid(/^bvid:/i.test(raw) ? raw.replace(/^bvid:/i, '') : raw)
  if (bvid) return { kind: 'bvid', value: bvid }
  const aid = extractAid(raw)
  if (aid) {
    const view = await fetchView(aid)
    const realBvid = view?.bvid || ''
    if (!realBvid) throw new Error('未找到视频 BV 号')
    return { kind: 'bvid', value: realBvid }
  }
  throw new Error('无效的歌单 id（支持 season:<season_id>:<mid>:<bvid>、bvid:<bvid> 或 BV 号/链接）')
}

const pageSlice = (detail: { info: any, songs: any[] }, page: any, limit: any) => {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(Math.max(1, Number(limit) || 100), 10000)
  return {
    source: 'bili' as const,
    info: detail.info,
    list: detail.songs.slice((p - 1) * l, p * l),
    page: p,
    limit: l,
    total: detail.songs.length,
  }
}

/** 歌单详情（契约键 playlist.getPlaylistDetail） */
export const getPlaylistDetail = async(id: string, page = 1, limit = 100) => {
  const target = await resolveId(id)
  if (target.kind === 'link') return parsePlaylistLink(target.value)
  if (target.kind === 'season') {
    const parts = target.parts || []
    if (parts.length < 3) throw new Error('无效的合集 id')
    return pageSlice(await detailFromSeason(parts[1], parts[2], parts[3] || ''), page, limit)
  }
  return pageSlice(await detailFromBvid(target.value), page, limit)
}

/** 上游 GetPlaylistSongs 的等价导出（只返回歌曲数组） */
export const getPlaylistSongs = async(id: string): Promise<any[]> => {
  const detail = await getPlaylistDetail(id, 1, 10000)
  return detail.list
}

/** 解析合集/多分P链接（上游 ParsePlaylist；返回详情对象，list 为全量） */
export const parsePlaylistLink = async(link: string) => {
  const raw = String(link || '').trim()
  const bvid = extractBvid(/^bvid:/i.test(raw) ? raw.replace(/^bvid:/i, '') : raw)
  if (!bvid) {
    const aid = extractAid(raw)
    if (!aid) throw new Error('无效的B站歌单链接：未找到 BV/av 号')
    const view = await fetchView(aid)
    return parsePlaylistView(view?.bvid || '', view)
  }
  const view = await fetchView(bvid)
  return parsePlaylistView(bvid, view)
}

const parsePlaylistView = async(bvid: string, view: any) => {
  const season = view?.ugc_season
  if (season) {
    const id = seasonKey(season.id, view?.owner?.mid, bvid)
    const detail = await detailFromSeason(String(season.id), String(view?.owner?.mid ?? ''), bvid)
    let trackCount = countSeasonEpisodes(season.sections)
    if (!trackCount) trackCount = detail.songs.length
    return {
      source: 'bili' as const,
      id,
      info: { ...detail.info, trackCount, playCount: Number(season?.stat?.view) || undefined },
      list: detail.songs,
      page: 1,
      limit: Math.max(detail.songs.length, 1),
      total: detail.songs.length,
    }
  }
  const detail = await detailFromBvid(bvid)
  return {
    source: 'bili' as const,
    id: bvidKey(bvid),
    info: { ...detail.info, trackCount: detail.songs.length },
    list: detail.songs,
    page: 1,
    limit: Math.max(detail.songs.length, 1),
    total: detail.songs.length,
  }
}

/** 上游 GetPlaylistCategories 返回 ErrPlaylistCategoriesUnsupported */
export const getCategories = async(): Promise<any> => {
  throw new Error('B站不支持歌单分类（上游未实现）')
}

/** 上游 GetCategoryPlaylists 返回 ErrPlaylistCategoriesUnsupported */
export const getCategoryPlaylists = async(_id: string, _page = 1, _limit = 20): Promise<any> => {
  throw new Error('B站不支持歌单分类（上游未实现）')
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  parsePlaylistLink,
  getCategories,
  getCategoryPlaylists,
}
