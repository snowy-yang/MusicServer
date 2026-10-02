import leaderboard from './leaderboard.ts'
import wyApi from '../apis/wy.ts'
import getLyric from './lyric.ts'
import getMusicInfo from './musicInfo.ts'
import musicSearch from './musicSearch.ts'
import songList from './songList.ts'
import hotSearch from './hotSearch.ts'
import comment from './comment.ts'
import singer from './singer.ts'
import album from './album.ts'
import playlist from './playlist.ts'
import parse from './parse.ts'
import userPlaylist from './userPlaylist.ts'

const wy = {
  leaderboard,
  musicSearch,
  songList,
  hotSearch,
  comment,
  singer,
  album,
  playlist,
  parse,
  userPlaylist,
  getMusicUrl(songInfo, type) {
    return wyApi.getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    return getLyric(songInfo.songmid)
  },
  getPic(songInfo) {
    const requestObj = getMusicInfo(songInfo.songmid)
    return requestObj.promise.then(info => info.al.picUrl)
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://music.163.com/#/song?id=${songInfo.songmid}`
  },
}

export default wy
