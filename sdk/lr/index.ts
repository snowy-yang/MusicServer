// 懒人听书（lrts.me）平台模块
// 匿名可用面（2026-10-02 实测）：搜索（App 通道游客态）/ 章节列表（web 免签）。
// 取流需登录（web getPlayPath，免费章节也要会话）：POST /login/lr 账号密码登录。
// 章节 songmid 为复合 id "<bookId>:<section>"；有声内容不参与聚合（noAggregate）。
import lrApi from '../apis/lr.ts'
import musicSearch from './musicSearch.ts'
import { getBookMenu } from './menu.ts'
import { getLrCookie } from './auth.ts'

const lr = {
  musicSearch,
  getMusicUrl(songInfo, type) {
    return lrApi.getMusicUrl(songInfo, type)
  },
  getPic(songInfo) {
    const bookId = String(songInfo.songmid ?? '').split(':')[0]
    // 书籍封面无独立免签接口；搜索结果的 img 字段已带封面（这里返回空由调用方回退）
    return Promise.resolve(null)
  },
  album: {
    async getAlbumDetail(bookId: string, page = 1, limit = 30) {
      const { total, list } = await getBookMenu(bookId, page, limit)
      return {
        info: { name: `书籍 ${bookId}`, total },
        list: list.slice(0, limit).map((item: any) => ({
          songmid: `${bookId}:${item.section}`,
          name: item.name || `第${item.section}节`,
          singer: '',
          albumId: String(bookId),
          albumName: '',
          interval: 0,
          payPlay: String(item.listenPrice) !== '0',
          img: null,
          lrc: '',
          lrcx: '',
          types: [],
          _types: {},
          disabled: false,
        })),
        total,
        limit,
        allPage: Math.ceil(total / 30) || page,
        source: 'lr' as const,
      }
    },
  },
  getMusicDetailPageUrl(songInfo) {
    const bookId = String(songInfo.songmid ?? '').split(':')[0]
    return `https://m.lrts.me/book/${bookId}`
  },
}

// login 一并导出：/login/lr 路由直接引用 sdk/lr/auth.ts，SDK 使用者也需要能拿到登录能力
export { login, status } from './auth.ts'
export default lr
