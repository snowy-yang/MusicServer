// 千千音乐（music.91q.com）平台模块
// 上游 music-lib/qianqian 的 Node/TS 移植。匿名可用面（2026-10-02 实测）：
//   搜索（type=1）/ 专辑搜索+详情（type=3、album/info）/ 歌单详情+分类+分类歌单 /
//   歌词（song/info 返回 txt URL）/ 免费曲目 128k/320k/flac 明文直链（tracklink 签名通道）。
// 限制：
//   - VIP/版权曲目 tracklink 无 path（需登录态会员 cookie），搜索保留但标记 payPlay；
//   - 歌单关键词搜索（/v1/search?type=6）服务端已下线（errno 23001），searchPlaylist 返回空列表；
//   - 上游 GetUserPlaylists 明确 Unsupported，本移植不提供 userPlaylist。
// 凭据：上游 New(cookie) 的 cookie 从 sdk/auth/store.ts 的 getCredentials('qian') 读取（可选）。
import qianApi from '../apis/qian.ts'
import musicSearch from './musicSearch.ts'
import lyric from './lyric.ts'
import { getSongInfo } from './musicInfo.ts'
import album from './album.ts'
import playlist from './playlist.ts'
import parse from './parse.ts'
import { getQianCookie } from './util.ts'

const qian = {
  musicSearch,

  getMusicUrl(songInfo, type) {
    return qianApi.getMusicUrl(songInfo, type)
  },

  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },

  // 千千无独立封面接口；搜索结果/专辑/歌单均自带 pic，缺失时回退 song/info
  async getPic(songInfo) {
    if (songInfo?.img) return songInfo.img
    try {
      const info = await getSongInfo(String(songInfo?.songmid ?? ''))
      return info?.img || null
    } catch {
      return null
    }
  },

  getMusicInfo(songInfo) {
    return getSongInfo(String(songInfo?.songmid ?? ''))
  },

  getMusicDetailPageUrl(songInfo) {
    const tsid = String(songInfo?.songmid ?? '').trim()
    return tsid ? `https://music.91q.com/song/${tsid}` : 'https://music.91q.com/'
  },

  album: {
    getAlbumDetail: album.getAlbumDetail,
    searchAlbum: album.searchAlbum,
    parseAlbumLink: album.parseAlbumLink,
  },

  // MusicServer 的 songList 契约：getList(sortId, tagId, page) / getTags()
  // 千千无“榜单”概念，这里以歌单分类作为标签体系（tagId 为 /v1/tracklist/category 的 subCate id）
  songList: {
    getList(sortId, tagId, page = 1) {
      const cate = String(tagId || sortId || '').trim()
      return playlist.getCategoryPlaylists(/^\d+$/.test(cate) ? cate : '', page, 30)
    },
    getTags() {
      return playlist.getCategories()
    },
  },

  playlist: {
    searchPlaylist: playlist.searchPlaylist,
    getPlaylistDetail: playlist.getPlaylistDetail,
    getPlaylistSongs: playlist.getPlaylistSongs,
    getCategories: playlist.getCategories,
    getCategoryPlaylists: playlist.getCategoryPlaylists,
    parsePlaylistLink: playlist.parsePlaylistLink,
  },

  parse,
}

/** 凭据存在性（cookie 仅用于 VIP/登录态资源，匿名不影响搜索与免费取流） */
export const status = () => {
  const cookie = getQianCookie()
  return cookie ? { logged: true } : { logged: false }
}

export default qian
