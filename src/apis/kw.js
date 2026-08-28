// 酷我音乐 URL 获取（直连）
// 统一接口约定：apis('kw').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }
//
// 取流方案：
//   首选 antiserver.kuwo.cn/anti.s（convert_url3 老接口，无需 token，128k/320k 有效）
//   flac 及以上音质该接口返回 refuse，回退 www.kuwo.cn/api/v1/www/music/playUrl
//   （需要 csrf token，token 失效时自动重新获取重试一次）

import { httpFetch } from '../common/request.js'

// 音质映射：128k → 128kmp3, 320k → 320kmp3, flac → flac（antiserver 用 mp3/flac 格式）
const qualityMap = {
  '128k': { br: '128kmp3', format: 'mp3' },
  '320k': { br: '320kmp3', format: 'mp3' },
  flac: { br: 'flac', format: 'flac' },
  flac24bit: { br: 'flac', format: 'flac' },
}

let token = ''
let tokenPromise = null

/**
 * 获取 kw csrf token（访问首页拿 cookie）
 */
const getToken = (retryNum = 0) => {
  if (token) return Promise.resolve(token)
  if (tokenPromise) return tokenPromise
  tokenPromise = httpFetch('http://www.kuwo.cn/', {
    method: 'get',
    timeout: 15000,
  }).promise.then(({ headers }) => {
    tokenPromise = null
    const match = (headers['set-cookie'] || []).join(';').match(/kw_token=(\w+)/)
    if (!match) throw new Error('获取token失败')
    token = match[1]
    return token
  }).catch(err => {
    tokenPromise = null
    if (retryNum > 2) throw err
    return getToken(++retryNum)
  })
  return tokenPromise
}

/**
 * 通过 antiserver 老接口获取（无需 token）
 * @param {string} rid MUSIC_xxx
 * @param {string} br 128kmp3 / 320kmp3 / flac
 * @param {string} format mp3 / flac
 */
const getUrlByAntiServer = (rid, br, format) => {
  return httpFetch(`http://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=${rid}&format=${format}&response=url&br=${br}`, {
    method: 'get',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || typeof body != 'object' || body.code != 200 || !body.url) {
      return Promise.reject(new Error(body?.msg || '获取失败'))
    }
    return body.url
  })
}

/**
 * 通过官方 playUrl 接口获取（需要 csrf token）
 */
const getUrlByPlayUrl = (songmid, br, retryNum = 0) => {
  const requestObj = httpFetch(`http://www.kuwo.cn/api/v1/www/music/playUrl?mid=${songmid}&type=music&br=${br}`, {
    method: 'get',
    headers: {
      csrf: token,
      cookie: `kw_token=${token}`,
      Referer: 'http://www.kuwo.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 15000,
  })
  requestObj.promise = requestObj.promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.code != 200) {
      // token 失效时重新获取再试一次
      if (token && /token|403|401/.test(body?.msg || '') && retryNum == 0) {
        token = ''
        return getUrlByPlayUrl(songmid, br, ++retryNum).promise
      }
      return Promise.reject(new Error(body?.msg || '获取失败'))
    }
    if (!body.data?.url) return Promise.reject(new Error('获取失败'))
    return body.data.url
  })
  return requestObj
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null }
  const { br, format } = qualityMap[type] || qualityMap['128k']
  const rid = `MUSIC_${songInfo.songmid}`

  requestObj.promise = getUrlByAntiServer(rid, br, format).catch(() => {
    // antiserver 无此音质（flac 常被拒）时回退官方接口
    return getToken().then(() => getUrlByPlayUrl(songInfo.songmid, br).promise)
  }).then(url => ({ type, url }))
  return requestObj
}

export default { getMusicUrl }
