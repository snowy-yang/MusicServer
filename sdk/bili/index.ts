// Bilibili（B站）平台模块 —— 上游 music-lib/bilibili 的移植（平台 id: bl）
// 能力：搜索 / 取流（DASH，VIP 可出 FLAC/Hi-Res）/ 歌单（合集 ugc_season + 多分P稿件）/
//       链接解析（BV/av、分P）/ 封面 / 扫码登录（sdk/bili/login.ts，凭据落 sdk/auth/store.ts）
// 不实现：专辑、歌词（上游即空实现）、榜单、热搜、歌手、评论、个人歌单、歌单分类（上游均未实现）。
// 取流入口在 sdk/apis/bili.ts（getMusicUrl），songmid 约定 `<bvid>|<cid>`。
import musicSearch from './musicSearch.ts'
import lyric from './lyric.ts'
import pic from './pic.ts'
import playlist from './playlist.ts'
import parse from './parse.ts'
import biliApi from '../apis/bili.ts'
import { parseSongId } from './util.ts'

const bili = {
  musicSearch,
  getMusicUrl(songInfo, type) {
    return biliApi.getMusicUrl(songInfo, type)
  },
  getLyric(songInfo, ...rest) {
    return lyric.getLyric(songInfo, ...rest)
  },
  getPic(songInfo) {
    return pic.getPic(songInfo)
  },
  playlist,
  parse,
  getMusicDetailPageUrl(songInfo) {
    if (songInfo?.link) return String(songInfo.link)
    const bvid = String(songInfo?.bvid || '') || parseSongId(songInfo?.songmid).bvid
    if (!bvid) return 'https://www.bilibili.com/'
    const page = Number(songInfo?.page) || 0
    return `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`
  },
}

// 登录态（sdk/auth/store.ts 的 bili 凭据，扫码登录写入）
export { status } from './login.ts'

export default bili
