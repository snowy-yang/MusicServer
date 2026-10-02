// 酷我链接解析
// 歌曲：https://www.kuwo.cn/play_detail/<rid>（含 ?/# 尾串）、m.kuwo.cn 的 musicId=<rid>、裸 rid
// 上游对应：music-lib/kuwo/song.go Parse / kuwo.go fetchFullSongInfo（元数据 m.kuwo.cn + 尽力附直链）
// 专辑 / 歌单分别复用 album.parseAlbumLink、playlist.parsePlaylistLink。
import { httpFetch } from '../request.ts'
import { formatPlayTime } from '../index.ts'
import kwApi from '../apis/kw.ts'
import album from './album.ts'
import playlist from './playlist.ts'
import { formatSinger } from './util.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

const SONG_PATTERNS = [
  /play_detail\/(\d+)/, // http://www.kuwo.cn/play_detail/228908
  /h5app\/song\/(\d+)/, // https://m.kuwo.cn/h5app/song/228908
  /musicId=(\d+)/, // http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=228908
  /^\d{4,}$/, // 裸 rid
]

const extractSongId = (link: any): string => {
  const raw = String(link ?? '').trim()
  for (const pattern of SONG_PATTERNS) {
    const match = raw.match(pattern)
    if (match) return match[1] ?? raw
  }
  return ''
}

interface KuwoSongMeta {
  songName?: string
  artist?: string
  pic?: string
  album?: string
  albumId?: string | number | null
  duration?: string | number
}

/** 拉取歌曲元数据（上游 fetchFullSongInfo 的 songinfoandlrc 部分；接口偶发 status 301，重试 3 次） */
const fetchSongMeta = async(rid: string, retryNum = 0): Promise<KuwoSongMeta> => {
  const { body } = await httpFetch(`http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${rid}&httpsStatus=1`, {
    method: 'get',
    headers: { 'User-Agent': UA, Cookie: 'wd=1;vip=0' },
    timeout: 15000,
  }).promise

  let data: any = body
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      data = null
    }
  }
  const songinfo = data?.data?.songinfo
  if (!songinfo) {
    // 风控/抖动时上游返回 status 301「音乐查询失败」，退避重试（最多 5 次，约 9s）
    if (retryNum < 5) {
      await new Promise(resolve => setTimeout(resolve, 600 * (retryNum + 1)))
      return fetchSongMeta(rid, ++retryNum)
    }
    throw new Error(data?.msg || '酷我歌曲不存在或已下架')
  }
  return songinfo
}

/** 上游 Parse：歌曲链接 → Song（尽力附带直链 url/type，失败不影响返回） */
export const parseSong = async(link: string) => {
  const rid = extractSongId(link)
  if (!rid) throw new Error('无效的酷我歌曲链接')

  const meta = await fetchSongMeta(rid)
  const duration = parseInt(String(meta.duration ?? ''), 10) || 0
  const song: any = {
    songmid: rid,
    name: meta.songName || `Kuwo_Song_${rid}`,
    singer: formatSinger(String(meta.artist ?? '').trim()),
    albumName: String(meta.album ?? '').trim(),
    albumId: meta.albumId != null ? String(meta.albumId) : '',
    interval: duration > 0 ? formatPlayTime(duration) : '--/--',
    img: meta.pic || null,
    lrc: null,
    otherSource: null,
    types: [],
    _types: {},
    typeUrl: {},
    source: 'kw' as const,
    extra: { rid, link: `http://www.kuwo.cn/play_detail/${rid}` },
  }

  try {
    const hit = await kwApi.getMusicUrl({ songmid: rid } as any, '128k').promise
    if (hit?.url) {
      song.url = hit.url
      song.type = hit.type
    }
  } catch {
    // 与上游 fetchAudioURL 降级一致：直链获取失败（版权/风控）仍返回元数据
  }

  return song
}

export const parseAlbum = async(link: string) => album.parseAlbumLink(link)
export const parsePlaylist = async(link: string) => playlist.parsePlaylistLink(link)

export default { parseSong, parseAlbum, parsePlaylist }
