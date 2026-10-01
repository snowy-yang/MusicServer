import leaderboard from './leaderboard.ts'
import lyric from './lyric.ts'
import songList from './songList.ts'
import musicSearch from './musicSearch.ts'
import txApi from '../apis/tx.ts'
import hotSearch from './hotSearch.ts'
import comment from './comment.ts'
import singer from './singer.ts'
import album from './album.ts'

const tx = {
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  comment,
  singer,
  album,

  getMusicUrl(songInfo, type) {
    return txApi.getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    // let singer = songInfo.singer.indexOf('、') > -1 ? songInfo.singer.split('、')[0] : songInfo.singer
    return lyric.getLyric(songInfo)
  },
  async getPic(songInfo) {
    return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${songInfo.albumId}.jpg`
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://y.qq.com/n/yqq/song/${songInfo.songmid}.html`
  },
}

export default tx
