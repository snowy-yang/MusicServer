// QQ音乐链接解析（上游 music-lib/qq/song.go 的 Parse 移植）
// 歌曲链接形态：
//   https://y.qq.com/n/ryqq/songDetail/<songmid>
//   https://y.qq.com/n/yqq/song/<songmid>.html
//   https://i.y.qq.com/v8/playsong.html?songid=<数字 id>（先反查 songmid）
//   ...?songmid=<songmid>
// 返回 Song（含 songmid）；直链 url/type 为尽力附带，失败不影响元数据返回（与上游一致）。
import { httpFetch } from '../common/request.ts'
import { formatPlayTime, sizeFormate } from '../index.ts'
import { formatSingerName } from '../utils.ts'
import txApi from '../apis/tx.ts'
import { parseAlbumLink } from './album.ts'
import { parsePlaylistLink } from './playlist.ts'

const SONG_DETAIL_RE = /songDetail\/([A-Za-z0-9]+)/
const SONG_PATH_RE = /\/song\/([A-Za-z0-9]+)/
const SONG_MID_QUERY_RE = /[?&]songmid=([A-Za-z0-9]+)/
const SONG_ID_QUERY_RE = /[?&]songid=(\d+)/

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1'

/** 上游 fetchSongDetailByID：数值 songid → mid */
const fetchMidBySongId = async(songid: string) => {
  const { statusCode, body } = await httpFetch(
    `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songid=${encodeURIComponent(songid)}&format=json`,
    { headers: { 'User-Agent': UA, Referer: 'http://m.y.qq.com' }, timeout: 15000 },
  ).promise
  const mid = statusCode === 200 ? body?.data?.[0]?.mid : ''
  if (!mid) throw new Error('QQ音乐歌曲不存在')
  return String(mid)
}

/** 上游 fetchSongDetail：songmid → 原始条目（顺带拿 file 体积信息） */
const fetchSongDetailRaw = async(songmid: string) => {
  const { statusCode, body } = await httpFetch(
    `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(songmid)}&format=json`,
    { headers: { 'User-Agent': UA, Referer: 'http://m.y.qq.com' }, timeout: 15000 },
  ).promise
  const item = statusCode === 200 ? body?.data?.[0] : null
  if (!item?.mid) throw new Error('QQ音乐歌曲不存在')
  return item
}

/** 原始条目 → MusicServer Song 形状 */
const convertSong = (item: any) => {
  const file = item?.file ?? {}
  const types: any[] = []
  const _types: Record<string, { size: string }> = {}
  const push = (type: string, size: any) => {
    if (typeof size === 'number' && size > 0) {
      const formatted = sizeFormate(size)
      types.push({ type, size: formatted })
      _types[type] = { size: formatted }
    }
  }
  push('128k', file.size_128mp3)
  push('320k', file.size_320mp3)
  push('flac', file.size_flac)
  push('flac24bit', file.size_hires)

  const albumMid = item?.album?.mid ?? ''
  const singer = formatSingerName(item?.singer, 'name')
  return {
    source: 'tx' as const,
    songmid: String(item.mid),
    songId: item.id,
    name: item.title ?? item.name ?? '',
    singer,
    albumId: albumMid,
    albumMid,
    albumName: item?.album?.name ?? '',
    interval: formatPlayTime(item?.interval ?? 0),
    img: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
    lrc: null,
    strMediaMid: file.media_mid ?? item.mid,
    types,
    _types,
    typeUrl: {},
  }
}

/** 上游 Parse：歌曲链接 → Song（尽力附带直链 url/type） */
export const parseSong = async(link: string) => {
  const raw = String(link ?? '')
  let songmid = SONG_DETAIL_RE.exec(raw)?.[1] ?? SONG_PATH_RE.exec(raw)?.[1] ?? ''
  let songid = ''
  if (!songmid) {
    songid = SONG_ID_QUERY_RE.exec(raw)?.[1] ?? ''
    songmid = SONG_MID_QUERY_RE.exec(raw)?.[1] ?? ''
    if (!songmid && songid) songmid = await fetchMidBySongId(songid)
  }
  if (!songmid) throw new Error('无效的QQ音乐歌曲链接')

  const item = await fetchSongDetailRaw(songmid)
  const song: any = convertSong(item)
  if (songid) song.songId = Number(songid)
  try {
    const hit = await txApi.getMusicUrl(song, '320k').promise
    song.url = hit.url
    song.type = hit.type
  } catch {
    // 与上游一致：直链获取失败忽略（VIP/下架曲目仍返回元数据）
  }
  return song
}

export const parseAlbum = async(link: string) => parseAlbumLink(link)
export const parsePlaylist = async(link: string) => parsePlaylistLink(link)

export default { parseSong, parseAlbum, parsePlaylist }
