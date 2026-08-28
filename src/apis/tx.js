// QQ音乐 URL 获取（直连）
// 接口: https://u.y.qq.com/cgi-bin/musicu.fcg
// 方法: vkey.GetVkeyServer.CgiGetVkey
// 统一接口约定：apis('tx').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }

import { httpFetch } from '../common/request.js'

const buildData = songmid => ({
  comm: {
    ct: '19',
    cv: '1859',
    uin: '0',
  },
  req: {
    module: 'vkey.GetVkeyServer',
    method: 'CgiGetVkey',
    param: {
      guid: '7342827269',
      songmid: [songmid],
      songtype: [0],
      uin: '0',
      loginflag: 1,
      platform: '20',
      needNewCode: 1,
    },
  },
})

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null }
  requestObj.promise = httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
      Referer: 'https://y.qq.com/',
    },
    body: buildData(songInfo.songmid),
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.code != 0 || body.req?.code != 0) {
      return Promise.reject(new Error('获取失败'))
    }
    const data = body.req.data
    const sip = data.sip?.[0] || 'http://aqqmusic.tc.qq.com/'
    // 格式: C400{media_mid}.m4a?guid=&vkey=&uin=&fromtag=
    const params = data.testfile2g?.split('?')[1] || ''
    const url = `${sip}C400${songInfo.songmid}.m4a?${params}`
    if (!params) return Promise.reject(new Error('获取失败'))
    return { type, url }
  })
  return requestObj
}

export default { getMusicUrl }
