// JOOX URL 获取（新版 web 播放器通道 openjoox2，含 md5(secretAPIKey) 签名）
// 链路：GET cache.api.joox.com/openjoox2/v1/track/<songid>?...&secret=<md5>
//   → play_url_list[0]（无则 refrain_url）→ 带 vkey/hdnts 的 CDN 直链（ak-hk.stream.music.joox.com 等）
// 上游 Go 的 api.joox.com/web-fcgi-bin/web_get_songinfo 已 404（2026-10-02 实测），
// 故取流改用官网当前使用的 openjoox2 通道（签名细节见 sdk/joox/musicInfo.ts）。
// 地区/签名参数：country=hk & lang=zh_TW & fs=1（请求完整曲目）& im=0，登录 cookie 的
//   wmid/session_key 会作为 uid/usk 参与签名（/login/joox 绑定后 VIP 曲目可取完整流）。
// 实测：游客态返回 128k MP3（免费完整曲目）或 VIP 曲目的 preview/refrain 片段；
//   未登录请求 VIP 曲目时 play_url_list 为试听片段——与上游行为一致（上游同样只能拿游客流）。
// 统一接口约定：apis('jx').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际命中档位，可能低于请求值）

import { httpFetch } from '../request.ts'
import { jooxHeaders, normalizeJooxID } from '../joox/util.ts'
import { buildTrackUrl } from '../joox/musicInfo.ts'

/** 游客通道实测仅 128k MP3；VIP 账号理论上更高，但需登录后验证，故不虚报 */
export const supportQualitys = ['128k']

export const getMusicUrl = (songInfo: any, _type?: string) => {
  const requestObj: { promise: any, cancelHttp: () => void } = { promise: null, cancelHttp() {} }
  let current: any = null
  requestObj.cancelHttp = () => {
    if (current?.cancelHttp) current.cancelHttp()
  }

  requestObj.promise = (async() => {
    const songId = normalizeJooxID(songInfo?.songmid ?? songInfo?.id ?? songInfo?.songid ?? '')
    if (!songId) throw new Error('joox 歌曲 id 无效')

    current = httpFetch(buildTrackUrl(songId, { fullSong: true }), { headers: jooxHeaders(), timeout: 20000 })
    const { statusCode, body } = await current.promise as any
    if (statusCode != 200 || !body || typeof body !== 'object' || body.code) {
      throw new Error(`joox 取流失败：${body?.msg || body?.message || `HTTP ${statusCode}`}`)
    }

    const urls: any[] = Array.isArray(body.play_url_list) ? body.play_url_list : []
    const clean = (value: any) => String(value ?? '').replace(/&amp;/g, '&')
    let url = urls.map(clean).find(item => item.startsWith('http')) || ''
    if (!url && clean(body.refrain_url).startsWith('http')) url = clean(body.refrain_url)
    if (!url) throw new Error('无可用播放地址（VIP/版权限制或地区不可用）')

    return { type: '128k', url }
  })()

  return requestObj
}

export default { getMusicUrl }
