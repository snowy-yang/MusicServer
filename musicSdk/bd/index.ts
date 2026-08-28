import leaderboard from './leaderboard.ts'
import { apis } from '../api-source.ts'
import musicInfo from './musicInfo.ts'
import songList from './songList.ts'
import { httpFetch } from '../request.ts'
import musicSearch from './musicSearch.ts'
import hotSearch from './hotSearch.ts'

const bd = {
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  getMusicUrl(songInfo, type) {
    return apis('bd').getMusicUrl!(songInfo, type)
  },
  getPic(songInfo) {
    const requestObj = this.getMusicInfo(songInfo)
    return requestObj.promise.then(info => info.pic_premium)
  },
  getLyric(songInfo) {
    const requestObj = this.getMusicInfo(songInfo)
    requestObj.promise = requestObj.promise.then(info => httpFetch(info.lrclink).promise.then(resp => ({ lyric: resp.body, tlyric: '' })))
    return requestObj
  },
  // getLyric(songInfo) {
  //   return apis('bd').getLyric(songInfo)
  // },
  // getPic(songInfo) {
  //   return apis('bd').getPic(songInfo)
  // },
  getMusicInfo(songInfo) {
    return musicInfo.getMusicInfo(songInfo.songmid)
  },
  getMusicDetailPageUrl(songInfo) {
    return `http://music.taihe.com/song/${songInfo.songmid}`
  },
}

export default bd
