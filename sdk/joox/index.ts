// JOOX（腾讯海外音乐，东南亚）平台模块
// 匿名可用面（2026-10-02 实测，需 X-Forwarded-For 东南亚 IP 绕过 www 地区重定向）：
//   搜索 / 专辑（搜索+详情+链接解析）/ 歌单（搜索+详情+分类+链接解析）/ 歌词 / 链接解析（歌曲）/
//   取流（游客 128k MP3，VIP 曲目为 preview/refrain 片段）。
// 通道：
//   - 搜索/专辑搜索/歌单搜索：cache.api.joox.com/openjoox/v3/search（无签名）
//   - 取流/歌曲详情/专辑曲目/歌单曲目：cache.api.joox.com/openjoox2/v1（需 md5 签名，见 util.jooxSign）
//   - 歌词：api.joox.com/web-fcgi-bin/web_lyric（旧接口仍可用；失败回退 openjoox2 lrc_content）
//   - 分类/歌单/专辑 SSR 兜底：www.joox.com __NEXT_DATA__
// 上游 New(cookie)：默认游客 Cookie 来自 joox.go 常量；/login/jx 绑定后从 sdk/auth/store.ts 读取，
//   登录 cookie 的 wmid/session_key 会作为 uid/usk 参与 openjoox2 签名（VIP 完整曲目依赖它）。
// userPlaylist：上游 joox/user_playlist.go 返回 ErrUserPlaylistsUnsupported，未实现（不造）。
import jooxApi from '../apis/joox.ts'
import musicSearch from './musicSearch.ts'
import album from './album.ts'
import playlist from './playlist.ts'
import parse from './parse.ts'
import lyric from './lyric.ts'
import { getTrackDetail } from './musicInfo.ts'
import { pickJooxImage, normalizeJooxID, jooxSongLink } from './util.ts'
import { getCredentials } from '../auth/store.ts'

const joox = {
  musicSearch,
  getMusicUrl(songInfo, type) {
    return jooxApi.getMusicUrl(songInfo, type)
  },
  getLyric(songInfo, ...rest) {
    return lyric.getLyric(songInfo, ...rest)
  },
  getPic(songInfo) {
    const songId = normalizeJooxID(songInfo?.songmid ?? songInfo?.id ?? '')
    return getTrackDetail(songId).then(detail => pickJooxImage(detail?.images) || null)
  },
  album,
  playlist,
  // 契约别名：JOOX 的「分类/列表」能力即 playlist.go 的歌单分类，没有独立的 songList 接口，
  // 这里把同一套分类/分类歌单挂到 songList 键，便于 /song-list/jx 路由复用。
  songList: {
    sortList: [{ name: '全部', id: '' }],
    getTags() {
      return playlist.getCategories()
    },
    getList(sortId: string, tagId: string, page = 1, limit = 30) {
      return playlist.getCategoryPlaylists(tagId ?? sortId ?? '', page, limit)
    },
  },
  parse,
  getMusicDetailPageUrl(songInfo) {
    return jooxSongLink(songInfo?.songmid ?? songInfo?.id ?? '')
  },
}

/** 登录状态（凭据存在性判断；无在线校验接口） */
export const status = () => {
  const cred = getCredentials('jx') as { cookie?: string, updatedAt?: string } | null
  return cred?.cookie
    ? { logged: true, updatedAt: cred.updatedAt }
    : { logged: false }
}

export default joox
