// 蜻蜓FM URL 获取（点播 audiostream 签名直链）
// 链路（官网 main.js 逆向，2026-10-02 实测）：
//   GET https://audio.qtfm.cn/audiostream/redirect/<channel>/<program>?access_token=&device_id=MOBILESITE&qingting_id=&t=<ms>&sign=<hex>
//   sign = HMAC-MD5("7l8CZ)SgZgM_bkrw", path+query) —— 签名内容含完整 path 与 query（sign 自身除外）
//   匿名空 token 即可取免费节目；响应 302 到华为云签名 CDN（vohwod-sign.qtfm.cn，m4a/mp3）
//   直播电台另有 /live/<cid>/64k.mp3 + HMAC-MD5("Lwrpu$K5oP") 签名（lhttp-hw.qtfm.cn）
// songmid 为复合 id "<channelId>:<programId>"（/album/qt 列表产出）
import crypto from 'node:crypto'

const SIGN_KEY = '7l8CZ)SgZgM_bkrw'
const AUDIO_HOST = 'https://audio.qtfm.cn'

export const supportQualitys = ['64k', '128k']

export const buildProgramUrl = (channelId: string, programId: string) => {
  const s = `/audiostream/redirect/${channelId}/${programId}?access_token=&device_id=MOBILESITE&qingting_id=&t=${Date.now()}`
  const sign = crypto.createHmac('md5', SIGN_KEY).update(s).digest('hex')
  return `${AUDIO_HOST}${s}&sign=${sign}`
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const songmid = String(songInfo.songmid ?? '')
  const [channelId, programId] = songmid.split(':')
  requestObj.promise = (async() => {
    if (!channelId || !programId) {
      throw new Error('蜻蜓 id 需为 <channelId>:<programId>（见 /album/qt 节目列表）')
    }
    return { type: type === '128k' ? '128k' : '64k', url: buildProgramUrl(channelId, programId) }
  })()
  return requestObj
}

export default { getMusicUrl, buildProgramUrl }
