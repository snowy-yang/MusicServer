// JOOX 链接解析（上游 joox/song.go Parse + album.go ParseAlbum + playlist.go ParsePlaylist）
// 歌曲：joox.com/<region>/single/<id> 或裸 ID（>10 字符且不含 '/'）→ openjoox2 详情 → Song（含直链）
// 专辑：joox.com/.../album/<id>、h_activity_id=、albumid= → album.getAlbumDetail
// 歌单：joox.com/.../playlist/<id>、playlistid|playlist_id|id= → playlist.getPlaylistDetail

import { normalizeJooxID } from './util.ts'
import { getTrackDetail, pickTrackUrl } from './musicInfo.ts'
import { jooxSongFromDetail } from './song.ts'
import { parseAlbum } from './album.ts'
import { parsePlaylist } from './playlist.ts'

/** 歌曲链接 → Song（上游 Parse 的正则与裸 ID 规则） */
export const parseSong = async(link: string) => {
  const raw = String(link ?? '').trim()
  const m = /joox\.com\/.*\/single\/([^/?#]+)/.exec(raw)
  let songId = ''
  if (m) {
    songId = normalizeJooxID(m[1])
  } else if (raw.length > 10 && !raw.includes('/')) {
    songId = normalizeJooxID(raw)
  } else {
    throw new Error('invalid joox link')
  }
  const detail = await getTrackDetail(songId)
  return jooxSongFromDetail(detail, pickTrackUrl(detail))
}

export default { parseSong, parseAlbum, parsePlaylist }
