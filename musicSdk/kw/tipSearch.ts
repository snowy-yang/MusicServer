// import { decodeName } from '../index.ts'
// import { tokenRequest } from './util.ts'
import { httpFetch } from '../request.ts'
import type { HttpRequestObject } from '../types.ts'

export default {
  regExps: {
    relWord: /RELWORD=(.+)/,
  },
  requestObj: null as HttpRequestObject | null,
  async tipSearchBySong(str: string) {
    // 报错403，加了referer还是有问题（直接换一个
    // this.requestObj = await tokenRequest(`http://www.kuwo.cn/api/www/search/searchKey?key=${encodeURIComponent(str)}`)

    this.cancelTipSearch()
    this.requestObj = httpFetch(`https://tips.kuwo.cn/t.s?corp=kuwo&newver=3&p2p=1&notrace=0&c=mbox&w=${encodeURIComponent(str)}&encoding=utf8&rformat=json`, {
      headers: {
        Referer: 'http://www.kuwo.cn/',
      },
    })
    return this.requestObj!.promise.then(({ body, statusCode }) => {
      if (statusCode != 200 || !body.WORDITEMS) return Promise.reject(new Error('请求失败'))
      return body.WORDITEMS
    })
  },
  handleResult(rawData: any) {
    return rawData.map(item => item.RELWORD)
  },
  cancelTipSearch() {
    if (this.requestObj && this.requestObj.cancelHttp) this.requestObj.cancelHttp()
  },
  async search(str: string) {
    return this.tipSearchBySong(str).then(result => this.handleResult(result))
  },
}
