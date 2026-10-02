// SDK 共享类型定义
// 所有平台模块与根模块的类型锚点。类型只描述实际返回的数据形状，不改变运行时行为。

/** 音乐平台标识 */
export type Source =
  | 'kw' | 'kg' | 'tx' | 'wy' | 'qs'
  | 'migu' | 'qian' | 'joox' | 'bili' | '5sing' | 'apple'
  | 'xm' | 'me' | 'qt' | 'lr'

/** 音质标识（wav 仅部分接口声明使用） */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | 'wav'

/** 单音质资源描述（搜索结果 types 数组项） */
export interface SongType {
  type: Quality
  size: string
}

/** 单音质详情（搜索结果 _types 映射项） */
export interface QualityInfo {
  size: string
}

/** 歌曲信息（搜索结果项 / 取流入参） */
export interface SongInfo {
  songmid?: string
  hash?: string
  copyrightId?: string
  songStringId?: string
  albumId?: string
  name?: string | null
  singer?: string
  source?: Source
  interval?: string | number
  albumName?: string
  img?: string | null
  lrc?: string | null
  otherSource?: string | null
  types?: SongType[]
  _types?: Partial<Record<Quality, QualityInfo>>
  typeUrl?: Partial<Record<Quality, string>>
  [key: string]: unknown
}

/** httpFetch 响应（与 common/request.ts 契约一致） */
export interface HttpResponse {
  statusCode: number
  statusMessage?: string
  headers: Record<string, string | string[]>
  body: any
  raw?: Buffer
}

/** httpFetch 返回的可取消请求对象 */
export interface HttpRequestObject {
  promise: Promise<HttpResponse>
  cancelHttp(): void
}

/** httpFetch 选项（common/request.ts 子集） */
export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | object
  form?: Record<string, unknown>
  timeout?: number
  lookup?: unknown
  family?: number
}

/** 带取消句柄的异步结果（getMusicUrl/getLyric 等的统一返回形态） */
export interface RequestObj<T> {
  promise: Promise<T>
  cancelHttp(): void
}

/** 请求句柄的宽松形态：SDK 内 promise 会在 .then() 中改写为对应结果类型 */
export interface AnyRequestObj {
  promise: Promise<any>
  cancelHttp(): void
}

/** 取流结果 */
export interface MusicUrlResult {
  type: string
  url: string
}

/** 歌词结果 */
export interface LyricInfo {
  lyric: string
  tlyric: string
  rlyric?: string
  yrc?: string
}

/** 搜索结果 */
export interface SearchResult {
  list: SongInfo[]
  allPage: number
  total: number
  limit: number
  source: Source
}

/** 搜索模块（平台 musicSearch 子模块） */
export interface MusicSearchModule {
  search(str: string, page?: number, limit?: number, retryNum?: number): Promise<SearchResult>
  [key: string]: unknown
}

/** 歌词模块 */
export interface LyricModule {
  getLyric(songInfo: SongInfo, ...rest: unknown[]): Promise<LyricInfo> | RequestObj<LyricInfo>
  [key: string]: unknown
}

/** 封面模块 */
export interface PicModule {
  getPic(songInfo: SongInfo, ...rest: unknown[]): Promise<string> | RequestObj<string>
  [key: string]: unknown
}

/** 热搜模块 */
export interface HotSearchModule {
  getList(): Promise<any>
  [key: string]: unknown
}

/** 评论模块 */
export interface CommentModule {
  getComment(songInfo: any, page?: number, limit?: number): Promise<any>
  getHotComment(songInfo: any, page?: number, limit?: number): Promise<any>
  [key: string]: unknown
}

/** 平台模块（各平台默认导出需满足的最小形状）
 * 注：SDK 内部实现大量返回 httpFetch 原生的 HttpRequestObject，
 *     实际 promise 会在 .then() 中被改写为对应结果类型；此处只约束调用侧可见形态。
 */
export interface PlatformModule {
  init?(): Promise<unknown> | void
  musicSearch?: MusicSearchModule
  leaderboard?: any
  songList?: any
  hotSearch?: HotSearchModule
  comment?: CommentModule
  getMusicUrl?(songInfo: SongInfo, type: Quality): AnyRequestObj | Promise<any>
  getLyric?(songInfo: SongInfo, ...rest: unknown[]): AnyRequestObj
  getPic?(songInfo: SongInfo, ...rest: unknown[]): AnyRequestObj | Promise<any>
  getMusicInfo?(songInfo: SongInfo): AnyRequestObj | Promise<any>
  getMusicDetailPageUrl?(songInfo: SongInfo): string
  [key: string]: any
}
