// 各平台 URL 直连接口汇总
// 服务器环境固定使用内置直连接口（apiSource.value === 'internal'）
// 外部聚合音源（sources/ 目录脚本）不走这里，由 musicSdk/api-source.ts 直接接入 source.js

import kw from './kw.js'
import kg from './kg.js'
import tx from './tx.js'
import wy from './wy.js'
import mg from './mg.js'
import bd from './bd.js'

interface SongInfo {
  songmid?: string
  hash?: string
  copyrightId?: string
  [key: string]: any
}

interface MusicUrlResult {
  type: string
  url: string
}

interface ApiModule {
  getMusicUrl?(songInfo: SongInfo, type: string): { promise: Promise<MusicUrlResult>; cancelHttp: () => void }
  [key: string]: any
}

export default {
  kw: kw as ApiModule,
  kg: kg as ApiModule,
  tx: tx as ApiModule,
  wy: wy as ApiModule,
  mg: mg as ApiModule,
  bd: bd as ApiModule,
}
