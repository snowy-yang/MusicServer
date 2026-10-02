// 懒人听书章节列表（web 通道，匿名免签）
// 接口: https://m.lrts.me/ajax/getBookMenu?bookId=&pageNum=&pageSize=&sortType=0
// 实测（2026-10-02）匿名可用；章节条目 {section, name, listenPrice, state}
// 注意：专辑类内容用 getAlbumAudios（entityType=2），本实现仅收书（entityType=3）
import { httpFetch } from '../request.ts'

const UA_MI = 'Mozilla/5.0 (Linux; U; Android 4.1.1; zh-cn; MI2 Build/JRO03L) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 XiaoMi/MiuiBrowser/1.0'
const MENU_URL = 'https://m.lrts.me/ajax/getBookMenu'

export const getBookMenu = async(bookId: string, page = 1, limit = 30) => {
  const { statusCode, body } = await httpFetch(`${MENU_URL}?bookId=${bookId}&pageNum=${page}&pageSize=${Math.max(30, limit)}&sortType=0`, {
    headers: { 'User-Agent': UA_MI, Referer: 'https://m.lrts.me/' },
    timeout: 15000,
  }).promise as any
  if (statusCode != 200) throw new Error(`获取章节失败（HTTP ${statusCode}）`)
  const b = body ?? {}
  if (b.status === 1 || !b.list) throw new Error(b.msg || '获取章节失败')
  return { total: Number(b.sections ?? 0), list: b.list }
}

export default { getBookMenu }
