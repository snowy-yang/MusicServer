// Apple Music 平台模块（上游 music-lib/apple/apple.go 的 Node/TS 移植，平台 id: apple）
// 能力：搜索 / 歌词（TTML，匿名 developer token 通常拿不到，见 lyric.ts）/ 封面 /
//       专辑（搜索+详情+链接解析）/ 歌单（搜索+详情+分类+分类歌单+链接解析）/
//       链接解析（song/album/playlist）/ 取流（**仅 preview 试听片段**，见 sdk/apis/apple.ts）。
// 凭据：上游 New(cookie) → getCredentials('apple')，cookie 形如
//   "media-user-token=xxx;storefront=cn;token=xxx"，也支持 storefront/mediaUserToken/token 直填字段。
// 未实现（上游也没有）：userPlaylist、榜单、热搜、歌手、评论、扫码登录。
import appleApi from '../apis/apple.ts'
import musicSearch from './musicSearch.ts'
import lyric from './lyric.ts'
import album from './album.ts'
import playlist from './playlist.ts'
import parse from './parse.ts'
import {
  appleArtworkURL,
  appleSongFromCatalog,
  appleWebURL,
  extractAppleID,
  fetchAppleSongResource,
  getAppleConfig,
  getAppleToken,
} from './util.ts'
import { getCredentials } from '../auth/store.ts'

const songIdOf = (songInfo: any): string => (
  extractAppleID(String(songInfo?.songmid ?? songInfo?.id ?? ''), 'song')
)

const apple = {
  /** 预热 developer token（失败不阻塞启动，路由调用时会重试） */
  init() {
    return getAppleToken().then(() => true).catch(() => false)
  },

  musicSearch,

  getMusicUrl(songInfo, type) {
    return appleApi.getMusicUrl(songInfo, type)
  },

  getLyric(songInfo, ...rest) {
    return lyric.getLyric(songInfo, ...rest)
  },

  /** 封面：搜索结果自带 img；缺失时回源歌曲详情（best-effort） */
  async getPic(songInfo) {
    if (songInfo?.img) return String(songInfo.img)
    const id = songIdOf(songInfo)
    if (!id) return null
    try {
      const res = await fetchAppleSongResource(id)
      return res ? (appleArtworkURL(res.attributes?.artwork, 600) || null) : null
    } catch {
      return null
    }
  },

  /** 歌曲详情（best-effort；等价上游 Parse(id)） */
  async getMusicInfo(songInfo) {
    const id = songIdOf(songInfo)
    if (!id) return null
    const res = await fetchAppleSongResource(id, 'lyrics,albums')
    return res ? appleSongFromCatalog(res) : null
  },

  album: {
    getAlbumDetail: album.getAlbumDetail,
    getAlbumSongs: album.getAlbumSongs,
    searchAlbum: album.searchAlbum,
    parseAlbumLink: album.parseAlbumLink,
  },

  playlist,

  // 契约别名：Apple 的歌单分类即 genre curators，挂到 songList 键供 /song-list/apple 复用
  songList: {
    sortList: [{ name: '热门', id: '1526756058' }],
    getTags() {
      return playlist.getCategories()
    },
    getList(sortId: string, tagId: string, page = 1, limit = 20) {
      const cate = String(tagId || sortId || '').trim()
      return playlist.getCategoryPlaylists(cate, page, limit)
    },
  },

  parse,

  getMusicDetailPageUrl(songInfo) {
    if (songInfo?.link) return String(songInfo.link)
    const id = songIdOf(songInfo)
    if (!id) return 'https://music.apple.com/'
    return appleWebURL('song', id, getAppleConfig().storefront)
  },
}

/** 登录状态（media-user-token 存在性判断；无在线校验接口） */
export const status = () => {
  const cred = getCredentials('apple') as any
  const cfg = getAppleConfig()
  return (cfg.mediaUserToken || cred?.cookie)
    ? { logged: true, updatedAt: cred?.updatedAt }
    : { logged: false }
}

export default apple
