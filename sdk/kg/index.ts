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
import playlist from './playlist.ts'
import parse from './parse.ts'
import { registerDfid } from '../auth/kg.ts'

const kg = {
  // 启动时注册正式 dfid（幂等；随机 dfid 匿名取流易撞 20028 验证，注册后显著降低）
  async init() {
    await registerDfid().catch((err: any) => console.log(`[kg/init] dfid 注册跳过: ${err.message}`))
  },
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  comment,
  singer,
  album,
  playlist,
  parse,
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
