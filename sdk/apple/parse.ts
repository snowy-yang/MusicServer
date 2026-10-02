// Apple Music 链接解析（上游 apple.go Parse / ParseAlbum / ParsePlaylist）
//   song:     https://music.apple.com/us/album/<slug>/<albumId>?i=<songId>（?i= 优先）或裸数字 song id
//   album:    https://music.apple.com/us/album/<slug>/<id> 或裸数字 album id
//   playlist: https://music.apple.com/us/playlist/<slug>/pl.xxxx 或裸 pl.* id
// 上游 Parse 会请求歌曲详情（include=lyrics,albums）并填入 preview URL。
import { appleSongFromCatalog, extractAppleID, fetchAppleSongResource } from './util.ts'
import { parseAlbumLink } from './album.ts'
import { parsePlaylistLink } from './playlist.ts'

/** 上游 Parse：单曲链接/裸 id → Song（含 previewUrl 试听直链） */
export const parseSong = async(link: string) => {
  const songId = extractAppleID(String(link ?? ''), 'song')
  if (!songId) throw new Error(`invalid apple music song link: ${link}`)
  const res = await fetchAppleSongResource(songId, 'lyrics,albums')
  if (!res) throw new Error(`apple song not found: ${songId}`)
  return appleSongFromCatalog(res)
}

export const parseAlbum = async(link: string) => parseAlbumLink(link)
export const parsePlaylist = async(link: string) => parsePlaylistLink(link)

export default { parseSong, parseAlbum, parsePlaylist }
