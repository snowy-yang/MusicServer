// Apple Music 专辑（上游 apple.go 的 SearchAlbum / ParseAlbum / GetAlbumSongs）
// 详情：amp-api /v1/catalog/<sf>/albums/<id>?extend=extendedAssetUrls
//   → data[0].relationships.tracks.data[]（>300 首时分页，next 由 fetchAllTrackResources 跟进）
// 链接：extractAppleID(link, 'album')，支持裸数字 id 与 /us/album/<slug>/<id> 链接。
import {
  appleAmpGet,
  appleAlbumToPlaylist,
  appleSongFromCatalog,
  extractAppleID,
  fetchAllTrackResources,
  getAppleConfig,
} from './util.ts'

export { searchAlbum } from './musicSearch.ts'

import { searchAlbum } from './musicSearch.ts'

/** 专辑详情（page/limit 在完整曲目上切片，与其它平台 getAlbumDetail 契约一致） */
export const getAlbumDetail = async(rawId: string, page = 1, limit = 50) => {
  const albumId = extractAppleID(String(rawId ?? ''), 'album')
  if (!albumId) throw new Error(`invalid apple music album id/link: ${rawId}`)

  const cfg = getAppleConfig()
  const body: any = await appleAmpGet(`/v1/catalog/${cfg.storefront}/albums/${albumId}`, { extend: 'extendedAssetUrls' })
  const album = (body?.data ?? [])[0]
  if (!album) throw new Error(`apple album not found: ${albumId}`)

  const tracks = await fetchAllTrackResources(album?.relationships?.tracks)
  const songs = tracks.map((track: any) => appleSongFromCatalog(track, albumId))

  const p = Math.max(1, Number(page) || 1)
  const l = Math.max(1, Number(limit) || 50)
  const summary = appleAlbumToPlaylist(album)
  // 上游 fetchPlaylistDetail 的做法：接口未给 trackCount 时以实际曲目数补齐
  if (!summary.trackCount || songs.length > summary.trackCount) summary.trackCount = songs.length

  return {
    source: 'ap' as const,
    info: {
      id: albumId,
      name: summary.name,
      img: summary.cover,
      desc: summary.description,
      author: summary.creator,
      link: summary.link,
      trackCount: summary.trackCount,
      releaseDate: summary.extra?.release_date || '',
      recordLabel: summary.extra?.record_label || '',
    },
    list: songs.slice((p - 1) * l, (p - 1) * l + l),
    page: p,
    limit: l,
    total: songs.length,
  }
}

/** 上游 GetAlbumSongs：只返回曲目数组 */
export const getAlbumSongs = async(id: string): Promise<any[]> => {
  const { list } = await getAlbumDetail(id, 1, 100000)
  return list
}

/** 上游 ParseAlbum：专辑链接 → 详情（曲目全量，不分页） */
export const parseAlbumLink = async(link: string) => {
  const detail = await getAlbumDetail(link, 1, 100000)
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

export default { getAlbumDetail, getAlbumSongs, searchAlbum, parseAlbumLink }
