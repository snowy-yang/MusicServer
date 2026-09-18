// 酷狗音乐 URL 获取（直连）
// 接口: https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash={hash}&album_id={albumId}&mid={mid}
// 统一接口约定：apis('kg').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }

import { httpFetch } from '../common/request.js'
import { getKgAuth } from '../auth/store.js'

let mid = ''

const getMid = () => {
  if (mid) return Promise.resolve(mid)
  // 随机生成 26 位小写字母数字混合的 mid
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  mid = Array.from({ length: 26 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return Promise.resolve(mid)
}

const getPlayUrl = (hash, albumId) => getMid().then(m => {
  const auth = getKgAuth()
  const url = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${hash}${albumId ? `&album_id=${albumId}` : ''}&mid=${m}${auth ? `&token=${encodeURIComponent(auth.token)}&userid=${auth.userid}` : ''}`
  return httpFetch(url, {
    method: 'get',
    headers: {
      Referer: 'https://www.kugou.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.err_code != 0 || !body.data) {
      return Promise.reject(new Error('获取失败'))
    }
    return body.data
  })
})

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null }
  const hash = songInfo._types?.[type]?.hash || songInfo.hash
  if (!hash) {
    requestObj.promise = Promise.reject(new Error('缺少 hash'))
    return requestObj
  }
  requestObj.promise = getPlayUrl(hash, songInfo.albumId).then(data => {
    const url = data.play_url || data.play_backup_url
    if (!url) return Promise.reject(new Error('获取失败'))
    return { type, url }
  })
  return requestObj
}

export default { getMusicUrl }
