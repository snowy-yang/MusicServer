// 网易云链接解析（上游 music-lib/netease/song.go 的 Parse 移植）
// 歌曲链接形态：
//   https://music.163.com/#/song?id=29732995
//   https://music.163.com/song?id=29732995
//   https://music.163.com/song/29732995
// 裸数字 id 也接受（补充便利；上游仅接受链接）
// 直链 url/type 为尽力附带，失败不影响元数据返回（与上游一致）；
// 歌单/专辑链接抛清晰错误，提示使用对应 parsePlaylist/parseAlbum。
import { httpFetch } from '../common/request.ts'
import { weapi } from './utils/crypto.ts'
import { getWyCookie } from '../auth/store.ts'
import wyApi from '../apis/wy.ts'
import { convertSong, parseAlbumLink } from './album.ts'
import { parsePlaylistLink } from './playlist.ts'
import { parseNeteaseLink } from './link.ts'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36'

/** 上游 fetchSongsBatch 的单曲版本（weapi/v3/song/detail） */
const fetchSongById = async(songId: string) => {
  const cookie = getWyCookie()
  const { statusCode, body } = await httpFetch('https://music.163.com/weapi/v3/song/detail', {
    method: 'post',
    headers: {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      origin: 'https://music.163.com',
      ...(cookie ? { cookie } : {}),
    },
    form: weapi({
      c: `[{"id":${songId}}]`,
      ids: `[${songId}]`,
    }),
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || body?.code != 200) {
    throw new Error(`wy 歌曲详情获取失败 (code ${body?.code ?? statusCode})`)
  }
  const item = body?.songs?.[0]
  if (!item?.id) throw new Error('netease song not found')
  return convertSong(item)
}

/** 上游 Parse：歌曲链接 → Song（尽力附带直链 url/type） */
export const parseSong = async(link: string) => {
  const raw = String(link ?? '').trim()
  if (!raw) throw new Error('无效的网易云歌曲链接')

  let songId = ''
  if (/^\d+$/.test(raw)) {
    songId = raw
  } else {
    const parsed = (() => {
      try {
        return parseNeteaseLink(raw)
      } catch {
        throw new Error('无效的网易云歌曲链接')
      }
    })()
    if (parsed.kind === 'playlist') throw new Error('检测到网易云歌单链接，请使用 parsePlaylist')
    if (parsed.kind === 'album') throw new Error('检测到网易云专辑链接，请使用 parseAlbum')
    if (parsed.kind !== 'song') throw new Error('无效的网易云歌曲链接')
    songId = parsed.id
  }

  const song: any = await fetchSongById(songId)
  try {
    const hit = await wyApi.getMusicUrl(song, '320k').promise
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
