// 千千音乐链接解析
// 歌曲：music.91q.com/song/<TSID>（上游 Parse：取 song/info 后顺带取直链，失败不影响返回）
// 专辑：music.91q.com/album/<P码> / ?albumAssetCode= / ?albumid=
// 歌单：music.91q.com/songlist|tracklist|playlist/<id> / ?*id= / 裸歌单 id
import { getDownloadUrl } from '../apis/qian.ts'
import { getSongInfo } from './musicInfo.ts'
import { parseAlbumLink } from './album.ts'
import { parsePlaylistLink } from './playlist.ts'
import { firstNonEmpty } from './util.ts'

const TSID_RE = /music\.91q\.com\/song\/(\w+)/

/** 上游 Parse：歌曲链接 → Song（尽力附带直链 url/type） */
export const parseSong = async(link: string) => {
  const match = TSID_RE.exec(String(link ?? ''))
  if (!match) throw new Error('无效的千千歌曲链接')
  const tsid = match[1]

  const song: any = await getSongInfo(tsid)
  try {
    const hit = await getDownloadUrl(tsid)
    song.url = hit.url
    song.type = hit.type
  } catch {
    // 与上游一致：直链获取失败忽略（VIP/下架曲目仍返回元数据）
  }
  delete song.lyricUrl
  delete song.raw
  return { ...song, songmid: firstNonEmpty(song.songmid, tsid), source: 'bd' as const }
}

export const parseAlbum = async(link: string) => parseAlbumLink(link)
export const parsePlaylist = async(link: string) => parsePlaylistLink(link)

export default { parseSong, parseAlbum, parsePlaylist }
