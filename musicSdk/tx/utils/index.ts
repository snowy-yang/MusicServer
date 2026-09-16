import type { HttpRequestObject } from '../../types.ts'

import { httpFetch } from '../../request.ts'
import { zzcSign } from './crypto.ts'

export const signRequest = async(data) => {
  // console.log(data)
  const sign = await zzcSign(JSON.stringify(data))
  // console.log('sign', sign)
  return httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: 'post',
    headers: {
      'User-Agent': 'QQMusic 14090508(android 12)',
    },
    body: data,
  }).promise
}

/**
 * musicu.fcg 通用请求（comm 参数对齐榜单模块的可用配置；
 * musichallSinger/musichallAlbum 的部分详情接口在该通道已停用，见各模块说明）
 */
export const createMusicuFetch = async(data, retryNum = 0) => {
  if (retryNum > 2) throw new Error('try max num')

  let result
  try {
    result = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
      },
      body: {
        comm: { uin: 0, format: 'json', ct: 20, cv: 1859 },
        ...data,
      },
    }).promise
  } catch (err) {
    console.log(err)
    return createMusicuFetch(data, ++retryNum)
  }
  if (result.statusCode !== 200 || result.body.code != 0) return createMusicuFetch(data, ++retryNum)

  return result.body
}
