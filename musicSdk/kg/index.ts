import leaderboard from './leaderboard.ts'
import { apis } from '../api-source.ts'
import songList from './songList.ts'
import musicSearch from './musicSearch.ts'
import pic from './pic.ts'
import lyric from './lyric.ts'
import hotSearch from './hotSearch.ts'
import comment from './comment.ts'
import singer from './singer.ts'
import album from './album.ts'
// import tipSearch from './tipSearch.js'

const kg = {
  // tipSearch,
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  comment,
  singer,
  album,
  getMusicUrl(songInfo, type) {
    return apis('kg').getMusicUrl!(songInfo, type)
  },
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  // getLyric(songInfo) {
  //   return apis('kg').getLyric(songInfo)
  // },
  getPic(songInfo) {
    return pic.getPic(songInfo)
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://www.kugou.com/song/#hash=${songInfo.hash}&album_id=${songInfo.albumId}`
  },
  // getPic(songInfo) {
  //   return apis('kg').getPic(songInfo)
  // },
}

export default kg
