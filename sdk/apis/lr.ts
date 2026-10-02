// 懒人听书 URL 获取（web 通道 getPlayPath，需登录）
// 接口: https://m.lrts.me/ajax/getPlayPath?entityId=<bookId>&entityType=3&opType=1&sections=[<section>]&type=0
// 实测（2026-10-02）：免费章节匿名也返回 status=2 "收费章节未购买"——必须携带 /login/lr 登录会话；
// 成功响应 list[0].path 为音频直链。
// songmid 为复合 id "<bookId>:<section>"（/album/lr 章节列表产出）；纯 bookId 视为第一章
import { httpFetch } from '../request.ts'
import { getLrCookie } from '../lr/auth.ts'

const UA_MI = 'Mozilla/5.0 (Linux; U; Android 4.1.1; zh-cn; MI2 Build/JRO03L) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 XiaoMi/MiuiBrowser/1.0'
const PLAY_URL = 'https://m.lrts.me/ajax/getPlayPath'

export const supportQualitys = ['64k', '128k']

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const songmid = String(songInfo.songmid ?? '')
  const [bookId, section = '1'] = songmid.split(':')

  requestObj.promise = (async() => {
    if (!bookId || !/^\d+$/.test(bookId)) throw new Error('懒人 id 需为 <bookId>[:<section>]（见 /album/lr 章节列表）')
    const cookie = getLrCookie()
    if (!cookie) throw new Error('懒人听书取流需要登录（POST /login/lr 绑定账号密码）')

    const { statusCode, body } = await httpFetch(
      `${PLAY_URL}?entityId=${bookId}&entityType=3&opType=1&sections=[${section}]&type=0`,
      { headers: { 'User-Agent': UA_MI, Referer: 'https://m.lrts.me/', Cookie: cookie }, timeout: 15000 },
    ).promise as any
    const b = body ?? {}
    if (statusCode != 200) throw new Error(`取流失败（HTTP ${statusCode}）`)
    const path = b?.list?.[0]?.path
    if (!path) {
      if (b.status === 2) throw new Error(b.msg || '收费章节未购买（需账号已购/会员）')
      if (String(b.msg || '').includes('登录')) throw new Error('登录态已失效，请重新 POST /login/lr')
      throw new Error(b.msg || '取流失败')
    }
    return { type: type === '128k' ? '128k' : '64k', url: String(path) }
  })()
  return requestObj
}

export default { getMusicUrl }
