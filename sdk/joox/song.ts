// JOOX 歌曲形状映射（统一 Song 形状，见 tmp/port-spec.md）
// 兼容来源：openjoox2 track/album/playlist 条目、openjoox v3 search 的 song_info、
// 以及 SSR 页面上的 track 条目（字段有 snake/camel 两套命名，上游 Go 也两套都兜底）。

import { formatPlayTime } from '../common/utils.ts'
import {
  normalizeJooxID,
  pickJooxImage,
  jooxArtists,
  firstNonEmpty,
  firstNonZero,
} from './util.ts'

/** 详情/列表 track 条目 → 统一 Song 形状 */
export const jooxSongFromTrack = (
  item: any,
  fallbackAlbum = '',
  fallbackCover = '',
  fallbackAlbumId = '',
): any | null => {
  const songmid = normalizeJooxID(item?.id)
  if (!songmid) return null

  const artists = Array.isArray(item?.artist_list) && item.artist_list.length
    ? item.artist_list
    : item?.artistList
  const albumId = normalizeJooxID(firstNonEmpty(item?.album_id, item?.albumId, fallbackAlbumId))

  return {
    songmid,
    name: String(firstNonEmpty(item?.name, item?.title, 'Unknown')),
    singer: String(firstNonEmpty(jooxArtists(artists), 'Unknown')),
    albumId: String(albumId || ''),
    albumName: String(firstNonEmpty(item?.album_name, item?.albumName, fallbackAlbum)),
    interval: formatPlayTime(firstNonZero(item?.play_duration, item?.playDuration, item?.duration)),
    img: String(firstNonEmpty(
      pickJooxImage(item?.images),
      item?.imgSrc,
      item?.cover,
      item?.image,
      item?.pic,
      fallbackCover,
    )) || null,
    lrc: null,
    vip: Number(item?.vip_flag ?? 0) === 1,
    types: [],
    _types: {},
    source: 'joox' as const,
  }
}

/** openjoox v3 搜索歌曲条目（song_info）→ 统一 Song 形状 */
export const jooxSongFromSearch = (info: any): any | null => jooxSongFromTrack(info)

/** 详情接口返回的整曲信息（parse 用，含可播放地址）→ 统一 Song 形状 */
export const jooxSongFromDetail = (detail: any, playUrl = ''): any => {
  const song = jooxSongFromTrack(detail) ?? {
    songmid: normalizeJooxID(detail?.id),
    name: String(detail?.name ?? ''),
    singer: String(jooxArtists(detail?.artist_list)),
    albumId: String(normalizeJooxID(detail?.album_id)),
    albumName: String(detail?.album_name ?? ''),
    interval: formatPlayTime(firstNonZero(detail?.play_duration)),
    img: String(pickJooxImage(detail?.images)) || null,
    lrc: null,
    types: [],
    _types: {},
    source: 'joox' as const,
  }
  if (playUrl) song.url = playUrl
  song.vip = Number(detail?.vip_flag ?? 0) === 1
  return song
}
