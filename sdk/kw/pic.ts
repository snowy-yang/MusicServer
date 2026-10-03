import { httpFetch } from '../common/request.ts'
import type { SongInfo } from '../types.ts'

export default {
  getPic({ songmid }: SongInfo) {
    const requestObj = httpFetch(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${songmid}`)
    requestObj.promise = requestObj.promise.then(({ body }) => /^http/.test(body) ? body : null)
    return requestObj.promise
  },
}
