// 百度音乐 URL 获取（直连）
// 接口: https://musicapi.qianqian.com/v1/restserver/ting?method=baidu.ting.song.getSongLink
// 返回: result.songinfo.song_link
// 统一接口约定：apis('bd').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }

import { httpFetch } from '../common/request.js'

const getSongLink = (songmid, retryNum = 0) => {
  const url = `https://musicapi.qianqian.com/v1/restserver/ting?method=baidu.ting.song.getSongLink&format=json&from=bmpc&version=1.0.0&version_d=11.1.6.0&songid=${songmid}&type=1&res=1&s_protocol=1&aac=2&project=tpass`
  return httpFetch(url, {
    method: 'get',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.error_code != 22000 || !body.result?.songinfo) {
      if (retryNum < 2) return getSongLink(songmid, ++retryNum)
      return Promise.reject(new Error('获取失败'))
    }
    return body.result.songinfo
  })
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null }
  requestObj.promise = getSongLink(songInfo.songmid).then(info => {
    // song_link 为试听地址（128k），按音质选择字段
    const url = info.song_link || info.file_link
    if (!url) return Promise.reject(new Error('获取失败'))
    return { type, url }
  })
  return requestObj
}

export default { getMusicUrl }
