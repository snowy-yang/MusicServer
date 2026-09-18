// 为项目中尚未迁移到 TypeScript 的 JavaScript 模块提供最小类型声明，
// 让 source-loader / apis 等 TypeScript 文件可以正常导入。

declare module '../common/request.js' {
  export interface HttpFetchResponse {
    statusCode: number
    statusMessage?: string
    headers: Record<string, string | string[]>
    body: any
  }

  export interface HttpRequestObject {
    promise: Promise<HttpFetchResponse>
    cancelHttp(): void
  }

  export function httpFetch(url: string, options?: Record<string, any>): HttpRequestObject
}

declare module '../../src/auth/store.js' {
  export function getCredentials(platform: string): any
  export function setCredentials(platform: string, credentials: object): void
  export function clearCredentials(platform: string): void
  export function getWyCookie(): string
  export function getKgAuth(): { token: string; userid: number | string } | null
}

declare module './kw.js' {
  const mod: { getMusicUrl(songInfo: any, type: string): any; default: any }
  export = mod
}

declare module './kg.js' {
  const mod: { getMusicUrl(songInfo: any, type: string): any; default: any }
  export = mod
}

declare module './tx.js' {
  const mod: { getMusicUrl(songInfo: any, type: string): any; default: any }
  export = mod
}

declare module './wy.js' {
  const mod: { getMusicUrl(songInfo: any, type: string): any; default: any }
  export = mod
}

declare module './mg.js' {
  const mod: { getMusicUrl(songInfo: any, type: string): any; default: any }
  export = mod
}

declare module './bd.js' {
  const mod: { getMusicUrl(songInfo: any, type: string): any; default: any }
  export = mod
}
