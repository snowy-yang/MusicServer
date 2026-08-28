// SDK 根模块 —— musicSdk 内 `import xxx from '../../index.js'` 的解析目标
// 聚合导出通用工具函数（对齐原 lx-music src/renderer/utils/index.ts 的导出）

export {
  sizeFormate,
  formatPlayTime,
  dateFormat,
  dateFormat2,
  formatPlayCount,
  decodeName,
} from './common/utils.js'
