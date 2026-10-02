// 5sing 链接解析（上游 fivesing/song.go 的 Parse + playlist.go 的 ParsePlaylist 移植）
// 歌曲: 5sing.kugou.com/(yc|fc|bz)/<数字id>.html → fetchSongInfo（直链 + newget 元数据，与上游一致：无直链即报错）
// 歌单: /{userId}/dj/<id>.html → getPlaylistDetail 全量曲目（支持个性域名 userId，见 util.extractPlaylistLink）
// 专辑: 上游无专辑概念（不实现）

import { extractSongLink } from './util.ts'
import { fetchSongInfo } from './musicInfo.ts'
import { parsePlaylistLink } from './playlist.ts'

export const parseSong = async(link: string) => {
  const parsed = extractSongLink(link)
  if (!parsed) throw new Error('invalid 5sing link')
  return fetchSongInfo(parsed.songID, parsed.songType)
}

export const parsePlaylist = async(link: string) => parsePlaylistLink(link)

export default { parseSong, parsePlaylist }
