import leaderboard from './leaderboard.ts'
import kgApi from '../apis/kg.ts'
import songList from './songList.ts'
import musicSearch from './musicSearch.ts'
import pic from './pic.ts'
import lyric from './lyric.ts'
import hotSearch from './hotSearch.ts'
import comment from './comment.ts'
import singer from './singer.ts'
import album from './album.ts'

const kg = {
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  comment,
  singer,
  album,
  getMusicUrl(songInfo, type) {
    return kgApi.getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  getPic(songInfo) {
    return pic.getPic(songInfo)
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://www.kugou.com/song/#hash=${songInfo.hash}&album_id=${songInfo.albumId}`
  },
}

export default kg
