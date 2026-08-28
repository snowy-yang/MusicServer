// 网易云音乐 URL 获取（直连）
// 接口: https://interface3.music.163.com/eapi/song/enhance/player/url/v1（eapi 加密请求，响应为明文 JSON）
// 音质: 128k → standard, 320k → exhigh, flac → lossless
// 统一接口约定：apis('wy').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }

import { httpFetch } from '../common/request.js'
import { eapi } from '../../musicSdk/wy/utils/crypto.ts'

const levelMap = {
  '128k': 'standard',
  '320k': 'exhigh',
  flac: 'lossless',
  flac24bit: 'hires',
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null }
  const data = {
    ids: `[${songInfo.songmid}]`,
    level: levelMap[type] || 'standard',
    encodeType: 'flac',
  }
  const request = httpFetch('https://interface3.music.163.com/eapi/song/enhance/player/url/v1', {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      origin: 'https://music.163.com',
    },
    form: eapi('/api/song/enhance/player/url/v1', data),
    timeout: 15000,
  })
  requestObj.promise = request.promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.code != 200) {
      return Promise.reject(new Error('获取失败'))
    }
    const item = body.data?.[0]
    if (!item?.url) return Promise.reject(new Error('获取失败'))
    return { type, url: item.url }
  })
  return requestObj
}

export default { getMusicUrl }
