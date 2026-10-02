// 喜马拉雅（有声书/播客）平台模块
// 匿名可用面（2026-10-02 实测）：搜索 / 专辑曲目 / 免费曲目取流（PC baseInfo 通道 + 解密直链）/ 封面。
// 付费与 VIP 内容：绑定登录 Cookie（POST /login/xm，须含 1&_token）后 baseInfo 授权放行；
// 超清（XimiUhq）需会员。有声内容不参与聚合搜索与跨平台匹配（sdk/index.ts 标记 noAggregate），
// 仅按 source=xm 直查。
import xmApi from '../apis/xm.ts'
import musicSearch from './musicSearch.ts'
import { getTrackInfo, coverUrl } from './musicInfo.ts'
import { getAlbumDetail } from './album.ts'
import { getCredentials } from '../auth/store.ts'

const xm = {
  musicSearch,
  getMusicUrl(songInfo, type) {
    return xmApi.getMusicUrl(songInfo, type)
  },
  getPic(songInfo) {
    return getTrackInfo(songInfo.songmid).then(coverUrl)
  },
  album: { getAlbumDetail },
  getMusicDetailPageUrl(songInfo) {
    return `https://www.ximalaya.com/sound/${songInfo.songmid}`
  },
}

/** 登录状态（凭据存在性判断，无在线校验接口） */
export const status = () => {
  const cred = getCredentials('xm') as { cookie?: string, updatedAt?: string } | null
  return cred?.cookie
    ? { logged: true, updatedAt: cred.updatedAt }
    : { logged: false }
}

export default xm
