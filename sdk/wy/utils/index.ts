import { httpFetch } from '../../request.ts'
import { eapi } from './crypto.ts'
import { getWyCookie } from '../../auth/store.ts'
import type { HttpRequestObject } from '../../types.ts'

export const eapiRequest = (url: string, data: object): HttpRequestObject => {
  // 登录后携带 MUSIC_U（见 /login/wy），未登录时不附加
  const cookie = getWyCookie()
  return httpFetch('http://interface.music.163.com/eapi/batch', {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      origin: 'https://music.163.com',
      ...(cookie ? { cookie } : {}),
    },
    form: eapi(url, data),
  })
  // requestObj.promise = requestObj.promise.then(({ body }) => {
  //   // console.log(raw)
  //   console.log(body)
  //   // console.log(eapiDecrypt(raw))
  //   // return eapiDecrypt(raw)
  //   return body
  // })
  // return requestObj
}
