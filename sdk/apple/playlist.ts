// Apple Music 歌单（上游 apple.go 的 SearchPlaylist / ParsePlaylist / GetPlaylistSongs /
// GetPlaylistCategories / GetCategoryPlaylists 与 applePlaylistToPlaylist 映射）
// 详情：amp-api /v1/catalog/<sf>/playlists/<id>?limit[tracks]=300&extend=extendedAssetUrls
//   曲目超过一页时沿 relationships.tracks.next 全量拉取（上游 fetchAllTrackResources，带 20 页上限防死循环）。
// 分类：上游使用写死的 Apple Music genre curator 列表（appleCuratorCategories），
//   GetCategoryPlaylists 固定 storefront=cn + l=zh-Hans-CN（curator id 取自 cn 区）。
// 链接：extractAppleID(link, 'playlist')，支持 pl.* 裸 id 与 /us/playlist/<slug>/pl.* 链接。
import {
  appleAmpGet,
  applePlaylistToPlaylist,
  appleSongFromCatalog,
  extractAppleID,
  fetchAllTrackResources,
  getAppleConfig,
} from './util.ts'

export { searchPlaylist } from './musicSearch.ts'

import { searchPlaylist } from './musicSearch.ts'

/** 上游 appleCuratorCategories（从公开搜索落地页提取的 Apple Music genre curators） */
export const appleCuratorCategories: Array<{ id: string, name: string }> = [
  { id: '1526756058', name: '热门' },
  { id: '1479949880', name: 'C-Pop' },
  { id: '1019400042', name: '国语流行' },
  { id: '1019398918', name: '粤语流行' },
  { id: '1019399540', name: '国际流行' },
  { id: '1019399551', name: 'K-Pop' },
  { id: '1019399547', name: 'J-Pop' },
  { id: '989061415', name: '嘻哈/说唱' },
  { id: '1019400044', name: 'R&B' },
  { id: '1019400046', name: '摇滚' },
  { id: '1019397973', name: '另类音乐' },
  { id: '976439535', name: '舞曲' },
  { id: '976439536', name: '电子' },
  { id: '976439541', name: '独立音乐' },
  { id: '1019399549', name: '爵士乐' },
  { id: '1019398924', name: '古典音乐' },
  { id: '976439528', name: '蓝调' },
  { id: '976439534', name: '乡村音乐' },
  { id: '1531542847', name: '拉丁音乐' },
  { id: '988656348', name: '非洲音乐' },
  { id: '976439543', name: '金属乐' },
  { id: '976439550', name: '朋克乐' },
  { id: '1019400049', name: '不插电' },
  { id: '1231181168', name: '影视原声' },
  { id: '1441811365', name: 'DJ 混音精选' },
  { id: '1532467784', name: '瞩目之星' },
  { id: '1554938339', name: '年代之声' },
  { id: '1564180390', name: '空间音频' },
  { id: '989010186', name: '亲子' },
]

/** 上游 GetPlaylistCategories：静态返回 Apple Music genre curators */
export const getCategories = async() => ({
  source: 'ap' as const,
  list: appleCuratorCategories.map(item => ({ id: item.id, name: item.name, group: 'Apple Music 分类', source: 'ap' as const })),
})

/** 上游 GetCategoryPlaylists：按 curator 分类取歌单（cn storefront，单请求上限 25，循环补齐） */
export const getCategoryPlaylists = async(categoryID: string, page = 1, limit = 20) => {
  const categoryId = String(categoryID ?? '').trim()
  if (!categoryId) throw new Error('apple 分类 id 不能为空')
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(Math.max(1, Number(limit) || 20), 300)
  const apiMax = 25
  let offset = (p - 1) * l
  const all: any[] = []

  while (all.length < l) {
    const batchSize = Math.min(apiMax, l - all.length)
    let body: any
    try {
      body = await appleAmpGet(`/v1/catalog/cn/apple-curators/${categoryId}/playlists`, {
        limit: batchSize,
        offset,
        l: 'zh-Hans-CN',
      })
    } catch (err) {
      if (all.length > 0) break // 上游：已有数据时返回已取部分
      throw err
    }
    const data = body?.data ?? []
    all.push(...data.map((item: any) => applePlaylistToPlaylist(item)))
    // 没有更多数据或没有下一页
    if (data.length < batchSize || !body?.next) break
    offset += data.length
  }

  return {
    source: 'ap' as const,
    list: all.slice(0, l),
    page: p,
    limit: l,
    total: all.length,
  }
}

/** 歌单详情（全量曲目后按 page/limit 切片） */
export const getPlaylistDetail = async(rawId: string, page = 1, limit = 100) => {
  const playlistId = extractAppleID(String(rawId ?? ''), 'playlist')
  if (!playlistId) throw new Error(`invalid apple music playlist id/link: ${rawId}`)

  const cfg = getAppleConfig()
  const body: any = await appleAmpGet(`/v1/catalog/${cfg.storefront}/playlists/${playlistId}`, {
    'limit[tracks]': 300,
    extend: 'extendedAssetUrls',
  })
  const item = (body?.data ?? [])[0]
  if (!item) throw new Error(`apple playlist not found: ${playlistId}`)

  const tracks = await fetchAllTrackResources(item?.relationships?.tracks)
  const songs = tracks.map((track: any) => appleSongFromCatalog(track))

  const p = Math.max(1, Number(page) || 1)
  const l = Math.max(1, Number(limit) || 100)
  const summary = applePlaylistToPlaylist(item)
  if (!summary.trackCount || songs.length > summary.trackCount) summary.trackCount = songs.length

  return {
    source: 'ap' as const,
    info: {
      id: playlistId,
      name: summary.name,
      img: summary.cover,
      desc: summary.description,
      author: summary.creator,
      link: summary.link,
      trackCount: summary.trackCount,
    },
    list: songs.slice((p - 1) * l, (p - 1) * l + l),
    page: p,
    limit: l,
    total: songs.length,
  }
}

/** 上游 GetPlaylistSongs：只返回曲目数组 */
export const getPlaylistSongs = async(id: string): Promise<any[]> => {
  const { list } = await getPlaylistDetail(id, 1, 100000)
  return list
}

/** 上游 ParsePlaylist：歌单链接 → 详情（曲目全量，不分页） */
export const parsePlaylistLink = async(link: string) => {
  const detail = await getPlaylistDetail(link, 1, 100000)
  return {
    source: 'ap' as const,
    id: detail.info.id,
    info: detail.info,
    list: detail.list,
    page: 1,
    limit: Math.max(detail.total, 1),
    total: detail.total,
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
