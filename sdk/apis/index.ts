// 各平台 URL 直连接口汇总
// 服务器环境固定使用内置直连接口（apiSource.value === 'internal'）
// 外部聚合音源（sources/ 目录脚本）不走这里，由 sdk/api-source.ts 直接接入 source.ts
// 注意：index.js 为 tsc 就地发射产物（不入库）；改逻辑只改本文件，然后 pnpm build

import kw from './kw.ts'
import kg from './kg.ts'
import tx from './tx.ts'
import wy from './wy.ts'

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
}
