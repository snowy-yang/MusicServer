// SDK 根请求模块（转接至 src/common/request.js）
// musicSdk 内 `import { ... } from '../request.js'` 的解析目标

import { httpFetch as rawHttpFetch } from '../src/common/request.js'
import type { HttpRequestObject, HttpOptions } from './types.ts'

export const httpFetch: (url: string, options?: HttpOptions) => HttpRequestObject =
  rawHttpFetch as (url: string, options?: HttpOptions) => HttpRequestObject
