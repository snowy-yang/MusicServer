import leaderboard from './leaderboard.ts'
import { apis } from '../api-source.ts'
import getLyric from './lyric.ts'
import getMusicInfo from './musicInfo.ts'
import musicSearch from './musicSearch.ts'
import songList from './songList.ts'
import hotSearch from './hotSearch.ts'
import comment from './comment.ts'
import singer from './singer.ts'
// import tipSearch from './tipSearch.ts'

const wy = {
  // tipSearch,
  leaderboard,
  musicSearch,
  songList,
  hotSearch,
  comment,
  singer,
  getMusicUrl(songInfo, type) {
    return apis('wy').getMusicUrl!(songInfo, type)
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
