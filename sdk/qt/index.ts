// 蜻蜓FM 平台模块
// 匿名可用面（2026-10-02 实测）：搜索（官网 SSR 解析）/ 频道节目列表（SSR）/
// 免费节目点播直链（audiostream 签名 302 到华为云 CDN）。
// 搜索结果为频道（专辑）级条目，songmid=channelId；节目条目 songmid="<channelId>:<programId>"。
// 付费节目与直播电台签名（Lwrpu$K5oP）暂未接登录。有声内容不参与聚合（noAggregate）。
import qtApi from '../apis/qt.ts'
import musicSearch from './musicSearch.ts'
import { getChannelPrograms } from './album.ts'

const qt = {
  musicSearch,
  getMusicUrl(songInfo, type) {
    return qtApi.getMusicUrl(songInfo, type)
  },
  async getPic(songInfo) {
    // 搜索结果已带封面；频道详情页无独立封面接口，降级用 SSR 页 og:image
    const { getChannelOgImage } = await import('./album.ts')
    return getChannelOgImage(songInfo.songmid.split(':')[0])
  },
  album: {
    async getAlbumDetail(channelId: string) {
      const { name, list } = await getChannelPrograms(channelId)
      return {
        info: { name, total: list.length },
        list,
        total: list.length,
        limit: list.length,
        allPage: 1,
        source: 'qt' as const,
      }
    },
  },
  getMusicDetailPageUrl(songInfo) {
    const [cid, pid] = String(songInfo.songmid).split(':')
    return pid ? `https://www.qingting.fm/channels/${cid}/programs/${pid}` : `https://www.qingting.fm/channels/${cid}`
  },
}

export default qt
