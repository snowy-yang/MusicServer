// 虾米音乐 —— 服务已关停，全部接口返回失败（保留桩实现）
import type { PlatformModule, SongInfo, Quality } from './types.ts'

const xm: PlatformModule = {
  comment: {
    getComment(_songInfo: SongInfo) {
      return Promise.reject(new Error('fail'))
    },
    getHotComment(_songInfo: SongInfo) {
      return Promise.reject(new Error('fail'))
    },
  },
  getMusicUrl(_songInfo: SongInfo, _type: Quality) {
    return {
      promise: Promise.reject(new Error('fail')),
      cancelHttp() {},
    }
  },
  getLyric(_songInfo: SongInfo) {
    return {
      promise: Promise.reject(new Error('fail')),
      cancelHttp() {},
    }
  },
  getPic(_songInfo: SongInfo) {
    return Promise.reject(new Error('fail'))
  },
}

export default xm
