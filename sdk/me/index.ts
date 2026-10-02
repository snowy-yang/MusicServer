// 猫耳FM（MissEvan，ACG 广播剧/音声平台）平台模块
// 匿名可用面（2026-10-02 实测）：搜索 / 剧集列表 / 免费声音明文直链 / 封面。
// 取流走 App API 签名通道（app.missevan.com，HMAC-SHA256(appsecret)），
// 返回 maoercdn 免签名直链——网页版 hls.m3u8 是 Widevine 加密流，勿用 web soundurl。
// 付费声音需 POST /login/me 绑定含 token 的 cookie。
// 有声内容不参与聚合搜索与跨平台匹配（noAggregate），仅按 source=me 直查。
import meApi from '../apis/me.ts'
import musicSearch from './musicSearch.ts'
import { getSoundInfo } from './musicInfo.ts'
import { getAlbumDetail } from './album.ts'
import { getCredentials } from '../auth/store.ts'

const me = {
  musicSearch,
  getMusicUrl(songInfo, type) {
    return meApi.getMusicUrl(songInfo, type)
  },
  getPic(songInfo) {
    return getSoundInfo(songInfo.songmid).then((info: any) => info?.front_cover || null)
  },
  album: { getAlbumDetail },
  getMusicDetailPageUrl(songInfo) {
    return `https://www.missevan.com/sound/${songInfo.songmid}`
  },
}

/** 登录状态（凭据存在性判断） */
export const status = () => {
  const cred = getCredentials('me') as { cookie?: string, updatedAt?: string } | null
  return cred?.cookie
    ? { logged: true, updatedAt: cred.updatedAt }
    : { logged: false }
}

export default me
