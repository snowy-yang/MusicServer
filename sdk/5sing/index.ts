// 5sing（5sing.kugou.com，酷狗旗下原创/翻唱音乐平台）平台模块
// 上游 music-lib/fivesing 移植（平台 id 统一为 '5sing'，上游 model.Source 为 "fivesing"）。
// 能力：搜索（原创 yc / 翻唱 fc / 伴奏 bz，统一种类字段 songType）/ 取流（明文直链，档位 sq→hq→lq）/
//       歌词（newget.dynamicWords）/ 歌单（搜索、详情、链接解析）/ 单曲链接解析。
// 不实现：专辑、封面（上游无 GetPic）、分类歌单/个人歌单（上游显式 not supported，保留抛错语义）、
//         榜单/热搜/歌手/评论（上游均无）。
// 取流入口在 sdk/apis/5sing.ts；songmid 约定 "<songId>|<songType>"（如 "932557|yc"，与上游 ID 一致）。
// 登录：上游 New(cookie) 的 cookie 会随请求发送（付费/受限内容可能受益）；
//       本移植从 sdk/auth/store.ts 的 getCredentials('5sing') 读取 cookie（无则匿名，匿名实测可搜索/取流/歌词/歌单）。

import musicSearch from './musicSearch.ts'
import lyric from './lyric.ts'
import playlist from './playlist.ts'
import parse from './parse.ts'
import fivesingApi from '../apis/5sing.ts'
import { buildSongLink, extractSongId, getStatus } from './util.ts'

const fivesing = {
  musicSearch,

  getMusicUrl(songInfo, type) {
    return fivesingApi.getMusicUrl(songInfo, type)
  },

  getLyric(songInfo, ...rest) {
    return lyric.getLyric(songInfo, ...rest)
  },

  playlist,
  parse,

  getMusicDetailPageUrl(songInfo) {
    if (songInfo?.link) return String(songInfo.link)
    const { songID, songType } = extractSongId(songInfo?.songmid ?? songInfo?.id, songInfo?.songType)
    if (!songID || !songType) return 'http://5sing.kugou.com/'
    return buildSongLink(songType, songID)
  },

  // 上游 GetUserPlaylists 显式返回 not supported，这里保留同样语义
  userPlaylist: {
    async getList(_page?: number, _limit?: number): Promise<any> {
      throw new Error('user playlists not supported')
    },
  },
}

/** 登录状态（凭据存在性判断；5sing 上游无扫码/账密登录，凭据只能手工写入 data/auth.json） */
export const status = getStatus

export default fivesing
