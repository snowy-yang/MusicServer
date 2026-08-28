// 各平台 URL 直连接口汇总
// 服务器环境固定使用内置直连接口（apiSource.value === 'internal'）
// lx 为 lx-music 聚合源：isolated-vm 硬隔离执行原始脚本（签名方案已放弃，见 docs/lx-source-ivm.md）

import kw from './kw.js'
import kg from './kg.js'
import tx from './tx.js'
import wy from './wy.js'
import mg from './mg.js'
import bd from './bd.js'
import lx from './lx-source.js'

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
  lx: lx as unknown as Record<string, ApiModule>,
}
