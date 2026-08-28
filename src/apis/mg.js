// 咪咕音乐 URL 获取（直连）
// 流程: resourceinfo.do（拿 contentId，需签名）→ listenSong.do（302 跳转到 CDN 音频地址）
// 统一接口约定：apis('mg').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }

import { httpFetch } from '../common/request.js'
import { toMD5 } from '../common/utils.js'

const rateMap = {
  '128k': 'PQ',
  '320k': 'HQ',
  flac: 'SQ',
  flac24bit: 'ZQ24',
}

const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73'

const createSignature = (time, str) => {
  const sign = toMD5(`${str}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`)
  return { sign, deviceId }
}

/**
 * 通过 songId 获取歌曲内容信息（contentId）
 */
const getResourceInfo = songmid => {
  const time = Date.now().toString()
  const signData = createSignature(time, songmid)
  return httpFetch(`http://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceId=${songmid}&resourceType=2`, {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
      timestamp: time,
      sign: signData.sign,
      deviceId: signData.deviceId,
      appId: 'yyapp2',
      channel: '0146921',
    },
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.code != '000000' || !body.resource?.length) {
      return Promise.reject(new Error('获取失败'))
    }
    return body.resource[0]
  })
}

/**
 * 获取播放地址（302 跳转）
 * @param {string} contentId
 * @param {string} copyrightId
 * @param {string} rateType PQ / HQ / SQ
 */
const getSongUrl = (contentId, copyrightId, rateType, retryNum = 0) => {
  if (retryNum > 2) return Promise.reject(new Error('获取失败'))
  const url = `https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do?contentId=${contentId}&copyrightId=${copyrightId}&resourceType=2&rateType=${rateType}&channel=0146921&toneFlag=${rateType}&netType=00&version=5.0.1`
  return httpFetch(url, {
    method: 'get',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
      Referer: 'http://music.migu.cn/',
    },
    timeout: 15000,
  }).promise.then(({ statusCode, headers }) => {
    if (statusCode == 302 && headers.location) return headers.location
    if (statusCode == 302 && !headers.location) {
      // 手动跟随
      return Promise.reject(new Error('获取失败'))
    }
    return getSongUrl(contentId, copyrightId, rateType, ++retryNum)
  })
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null }
  const rateType = rateMap[type] || 'PQ'
  requestObj.promise = getResourceInfo(songInfo.songmid || songInfo.copyrightId)
    .then(resource => getSongUrl(resource.contentId, resource.copyrightId, rateType))
    .then(url => ({ type, url }))
  return requestObj
}

export default { getMusicUrl }
