// 咪咕音乐（migu）公共层 —— 常量、请求、条目 → 歌曲的统一转换、档位与解密工具
// 上游对应：music-lib/migu/migu.go（convertItemToSong*、collectMiguFormats、pickMiguImage 等）
// 说明：匿名态 listen-url 仅放行 PQ(128k mp3)；HQ/SQ/ZQ 各档需携带登录 Cookie（对话框「登录后免费试听」）。
import crypto from 'node:crypto'
import { httpFetch } from '../request.ts'
import { getCredentials } from '../auth/store.ts'
import type { SongType } from '../types.ts'

/** 咪咕 toneFlag → 平台音质标签（types 展示与取流返回共用） */
export const TONE_QUALITY: Record<string, string> = {
  LQ: '64k',
  PQ: '128k',
  HQ: '320k',
  SQ: 'flac',
  ZQ: 'flac24bit',
  ZQ24: 'flac24bit',
  ZQ32: 'wav',
  Z3D: 'wav',
  I3D: 'flac24bit',
  '3D60': 'wav',
}

export const UserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1'
export const Referer = 'http://music.migu.cn/'

/** listen-url 走 Android 客户端 UA/头，与网页通道不同 UA */
export const AndroidUA = 'Android_migu/7.41.13 okhttp/3.12.13'
export const AndroidChannel = '0146832'
export const AndroidVersion = '7.41.13'

/** Z3D 加密流的 app code 密文（AES-128-CBC，key 为 AppKey 前 16 字符） */
const ANDROID_APP_KEY = '308202333082019c'
const ENCRYPTED_APP_CODE = Buffer.from([
  0xAE, 0xEA, 0xC7, 0x17, 0x05, 0xA6, 0x89, 0x55,
  0xA9, 0x31, 0xA6, 0xFE, 0x01, 0xE7, 0x28, 0xFF,
  0xF6, 0x49, 0x71, 0xE6, 0x1C, 0xEA, 0xF0, 0x0A,
  0xE3, 0xEA, 0x43, 0xC3, 0xE0, 0x58, 0x33, 0x83,
])

export const getMiguCookie = (): string => {
  const cred = getCredentials('migu') as { cookie?: string } | null
  return String(cred?.cookie ?? '').trim()
}

/** 带 Referer/UA/Cookie 的 GET，返回解析后的 body（JSON 已解析） */
export const miguGet = async(url: string, extraHeaders: Record<string, string> = {}): Promise<any> => {
  const cookie = getMiguCookie()
  const headers: Record<string, string> = { 'User-Agent': UserAgent, Referer, ...extraHeaders }
  if (cookie) headers.Cookie = cookie
  const { statusCode, body } = await httpFetch(url, { headers, timeout: 20000 }).promise
  if (statusCode !== 200) throw new Error(`migu http ${statusCode}`)
  return body
}

export const buildUrl = (base: string, params: Record<string, string | number>): string => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  return `${base}?${qs.toString()}`
}

// ---------------- 数据形状（对齐上游 MiguSongItem 结构体） ----------------

export interface MiguImageItem { imgSizeType?: string, img?: string }
interface MiguArtistItem { id?: string, name?: string }
interface MiguAlbumItem { id?: string, name?: string }
export interface MiguRateFormat {
  formatType?: string
  resourceType?: string
  size?: string
  androidSize?: string
  isize?: string
  asize?: string
  fileType?: string
  androidFileType?: string
  iformat?: string
  aformat?: string
  price?: string
  showTag?: string[]
  showTags?: string[]
}
export interface MiguZ3DCode {
  formatType?: string
  resourceType?: string
  size?: string
  androidSize?: string
  isize?: string
  asize?: string
  fileType?: string
  androidFileType?: string
  iformat?: string
  aformat?: string
  price?: string
  z3dKey?: string
  z3dIv?: string
  androidFileKey?: string
  iosFileKey?: string
  iosSize?: string
  iosFileType?: string
  url?: string
  iosUrl?: string
  androidUrl?: string
  h5Url?: string
}
export interface MiguSongItem {
  id?: string
  name?: string
  songName?: string
  songId?: string
  singers?: MiguArtistItem[]
  artists?: MiguArtistItem[]
  singerList?: MiguArtistItem[]
  albums?: MiguAlbumItem[]
  albumId?: string
  album?: string
  singer?: string
  contentId?: string
  copyrightId?: string
  chargeAuditions?: string
  downloadTags?: string[]
  imgItems?: MiguImageItem[]
  albumImgs?: MiguImageItem[]
  newRateFormats?: MiguRateFormat[]
  rateFormats?: MiguRateFormat[]
  audioFormats?: MiguRateFormat[]
  z3dCode?: MiguZ3DCode | null
  img1?: string
  img2?: string
  img3?: string
  duration?: number
  vipType?: string
}

// ---------------- 工具函数（1:1 对应上游） ----------------

export const firstNonEmpty = (...values: Array<string | undefined | null>): string => {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return String(value)
  }
  return ''
}

export const firstNonZeroString = (...values: Array<string | undefined | null>): string => {
  for (const value of values) {
    const s = String(value ?? '').trim()
    if (s !== '' && s !== '0') return s
  }
  return ''
}

export const pickMiguImage = (items?: MiguImageItem[] | null): string => {
  if (!Array.isArray(items)) return ''
  for (const preferred of ['02', '01', '03']) {
    for (const item of items) {
      if (item?.imgSizeType === preferred && String(item?.img ?? '').trim() !== '') return String(item.img)
    }
  }
  for (const item of items) {
    if (String(item?.img ?? '').trim() !== '') return String(item.img)
  }
  return ''
}

export const normalizeMiguImageURL = (image?: string | null): string => {
  const url = String(image ?? '').trim()
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/')) return `https://d.musicapp.migu.cn${url}`
  return url
}

export const collectMiguArtistNames = (item: MiguSongItem): string[] => {
  const names: string[] = []
  const seen = new Set<string>()
  const append = (name?: string) => {
    const n = String(name ?? '').trim()
    if (!n || seen.has(n)) return
    seen.add(n)
    names.push(n)
  }
  for (const s of item.singers ?? []) append(s?.name)
  for (const s of item.singerList ?? []) append(s?.name)
  for (const a of item.artists ?? []) append(a?.name)
  if (!names.length) for (const n of String(item.singer ?? '').split('|')) append(n)
  return names
}

/** 汇总三组 rateFormats + z3dCode，按 formatType|resourceType 去重（上游 collectMiguFormats） */
export const collectMiguFormats = (item: MiguSongItem): MiguRateFormat[] => {
  const groups: MiguRateFormat[][] = [
    item.newRateFormats ?? [],
    item.rateFormats ?? [],
    item.audioFormats ?? [],
  ]
  const code = item.z3dCode
  if (code && code.formatType) {
    groups.push([{
      formatType: code.formatType,
      resourceType: code.resourceType,
      size: code.size,
      androidSize: code.androidSize,
      isize: code.isize,
      asize: code.asize,
      fileType: code.fileType,
      androidFileType: code.androidFileType,
      iformat: code.iformat,
      aformat: code.aformat,
      price: code.price,
    }])
  }
  const formats: MiguRateFormat[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const format of group) {
      const key = `${String(format.formatType ?? '').trim().toUpperCase()}|${String(format.resourceType ?? '').trim()}`
      if (key === '|') continue
      if (seen.has(key)) continue
      seen.add(key)
      formats.push(format)
    }
  }
  return formats
}

export const miguFormatRank = (formatType?: string): number => {
  switch (String(formatType ?? '').trim().toUpperCase()) {
    case 'ZQ32': return 80
    case 'ZQ': case 'ZQ24': return 75
    case 'SQ': return 70
    case 'HQ': return 60
    case 'I3D': case 'Z3D': return 50
    case '3D60': return 40
    case 'PQ': return 30
    case 'LQ': return 20
    default: return 10
  }
}

export const miguFormatExt = (formatType?: string, formatCode?: string): string => {
  const type = String(formatType ?? '').trim().toUpperCase()
  const code = String(formatCode ?? '').trim()
  switch (type) {
    case 'SQ': case 'ZQ': case 'ZQ24': return 'flac'
    case 'ZQ32': case 'Z3D': case '3D60': return 'wav'
    case 'I3D': return 'm4a'
    case 'PQ': case 'HQ': case 'LQ': return 'mp3'
  }
  if (code.startsWith('011')) return 'flac'
  return 'mp3'
}

export const miguAlbumLink = (id: string): string => `https://music.migu.cn/v3/music/album/${id}`
export const miguPlaylistLink = (id: string): string => `https://music.migu.cn/v5/#/playlist?playlistId=${id}&playlistType=ordinary`
export const miguSongLink = (id: string): string => `https://music.migu.cn/v3/music/song/${id}`

// ---------------- 条目 → 歌曲（上游 convertItemToSongWithOption） ----------------

export interface MiguSong {
  songmid: string
  name: string
  singer: string
  albumId: string
  albumName: string
  interval: string | number
  img: string | null
  lrc: string | null
  types: SongType[]
  _types: Record<string, { size: string }>
  payPlay?: boolean
  /** 源特有元数据（取流/歌词需要）：contentId/resourceType/formatType/copyrightId/songId/albumId */
  extra: Record<string, string>
  source: 'migu'
  [key: string]: unknown
}

/** 把 "mm:ss"/秒数统一成上游 interval 形态（秒数）——路由层按原样透传 */
const SECONDS_FROM_SIZE = (size: number, bitrate: number): number => (bitrate > 0 ? Math.floor(size * 8 / bitrate) : 0)

export const convertItemToSong = (item: MiguSongItem, allowPaid = true): MiguSong | null => {
  const artistNames = collectMiguArtistNames(item)
  const songName = firstNonEmpty(item.name, item.songName)
  let albumName = String(item.album ?? '').trim()
  if (item.albums?.length && String(item.albums[0]?.name ?? '').trim() !== '') {
    albumName = String(item.albums[0]!.name).trim()
  }

  const rateFormats = collectMiguFormats(item)
  if (!rateFormats.length) return null

  let duration = Number(item.duration ?? 0) || 0
  const candidates: Array<{ index: number, size: number, ext: string, rank: number, vip: boolean, tone: string }> = []

  rateFormats.forEach((fmtItem, i) => {
    const sizeStr = firstNonZeroString(fmtItem.androidSize, fmtItem.asize, fmtItem.size, fmtItem.isize)
    const sizeVal = parseInt(sizeStr, 10) || 0
    let ext = firstNonEmpty(fmtItem.androidFileType, fmtItem.fileType)
    if (!ext) ext = miguFormatExt(fmtItem.formatType, firstNonEmpty(fmtItem.aformat, fmtItem.iformat))

    if (!duration && sizeVal > 0) {
      let bitrate = 0
      switch (fmtItem.formatType) {
        case 'PQ': bitrate = 128000; break
        case 'HQ': bitrate = 320000; break
        case 'LQ': bitrate = 64000; break
      }
      if (bitrate > 0) duration = SECONDS_FROM_SIZE(sizeVal, bitrate)
    }

    const priceVal = parseInt(String(fmtItem.price ?? ''), 10) || 0
    const tags = fmtItem.showTag?.length ? fmtItem.showTag : (fmtItem.showTags ?? [])
    let isVipTag = tags.some(tag => String(tag ?? '').trim().toLowerCase() === 'vip')
    if (!isVipTag) {
      isVipTag = (item.downloadTags ?? []).some(tag => String(tag ?? '').trim().toLowerCase() === 'vip')
    }
    const isHiddenPaid = item.chargeAuditions === '1' && priceVal >= 200

    if (allowPaid || (!isVipTag && !isHiddenPaid)) {
      candidates.push({
        index: i, size: sizeVal, ext, rank: miguFormatRank(fmtItem.formatType),
        vip: isVipTag || isHiddenPaid, tone: String(fmtItem.formatType ?? ''),
      })
    }
  })

  if (!candidates.length) return null

  candidates.sort((a, b) => (a.rank !== b.rank ? b.rank - a.rank : b.size - a.size))
  const best = candidates[0]!
  const bestFormat = rateFormats[best.index]!

  const bitrate = duration > 0 && best.size > 0 ? Math.floor(best.size * 8 / 1000 / duration) : 0
  const coverURL = normalizeMiguImageURL(firstNonEmpty(
    pickMiguImage(item.imgItems), pickMiguImage(item.albumImgs), item.img1, item.img2, item.img3,
  ))
  // albums 数组是搜索响应的专辑来源（顶层 albumId 常为空），与上游 Extra 的 album_id 同义
  const albumId = firstNonEmpty(item.albumId, item.albums?.[0]?.id)
  const linkID = firstNonEmpty(item.contentId, item.copyrightId)

  const extra: Record<string, string> = {
    content_id: String(item.contentId ?? ''),
    resource_type: String(bestFormat.resourceType ?? ''),
    format_type: String(bestFormat.formatType ?? ''),
  }
  if (item.copyrightId) extra.copyright_id = item.copyrightId
  if (item.songId) extra.song_id = item.songId
  if (albumId) extra.album_id = albumId

  const isVIP = item.chargeAuditions === '1' || best.vip
  const resourceType = String(bestFormat.resourceType ?? '2')
  const id = `${item.contentId ?? ''}|${resourceType}|${String(bestFormat.formatType ?? '')}`

  // 各档位可用性（供前端展示）；实际可取档位由取流接口的探测结果决定
  const types: SongType[] = candidates.map(c => ({
    type: (TONE_QUALITY[c.tone] ?? '128k') as SongType['type'],
    size: String(c.size),
  }))

  return {
    songmid: id,
    name: songName,
    singer: artistNames.join(' / '),
    albumId,
    albumName,
    interval: duration ? formatSeconds(duration) : '0',
    img: coverURL || null,
    lrc: null,
    types,
    _types: {},
    payPlay: isVIP,
    // 路由/取流需要 content_id|resource_type|format_type 三元组与版权号，放在 extra 里
    extra: { ...extra, link: miguSongLink(linkID) },
    source: 'migu',
  }
}

export const formatSeconds = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------------- 歌曲详情 / 歌词 ----------------

export const fetchSongDetail = async(contentID: string): Promise<MiguSongItem> => {
  const url = buildUrl('http://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do', {
    resourceType: '2',
    resourceId: contentID,
  })
  const body = await miguGet(url)
  const resource: MiguSongItem[] = body?.resource ?? []
  if (!resource.length) throw new Error('migu 歌曲详情为空')
  return resource[0]!
}

// ---------------- Z3D 解密（上游 DecryptAudio / miguZ3DStreamKey） ----------------

export const isMiguAudioMagic = (data: Buffer): boolean => {
  if (!data || data.length < 4) return false
  const h = data.subarray(0, 4)
  return h.toString('latin1') === 'fLaC'
    || (h.toString('latin1') === 'RIFF' && data.length >= 12 && data.subarray(8, 12).toString('latin1') === 'WAVE')
    || h.toString('latin1') === 'OggS'
    || data.subarray(0, 3).toString('latin1') === 'ID3'
    || (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp')
    || (data[0] === 0xFF && (data[1]! & 0xE0) === 0xE0)
}

/** streamKey = MD5(解密后的 appCode + fileKey) 的大写十六进制 */
export const miguZ3DStreamKey = (fileKey: string): Buffer => {
  const key = String(fileKey ?? '').trim()
  if (!key) throw new Error('empty z3d file key')
  const iv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(ANDROID_APP_KEY), iv)
  // Go 的 CryptBlocks 按块解密不做 PKCS#7 去填充，Node 默认会去填充导致 bad decrypt
  decipher.setAutoPadding(false)
  const appCode = Buffer.concat([decipher.update(ENCRYPTED_APP_CODE), decipher.final()])
  const hash = crypto.createHash('md5').update(appCode).update(key).digest('hex').toUpperCase()
  return Buffer.from(hash, 'latin1')
}

/** Z3D 流解密：逐字节 cipher[i] - streamKey[i % 32]；已是明文则原样返回 */
export const decryptZ3D = (fileData: Buffer, fileKey: string): Buffer => {
  if (!fileData?.length) throw new Error('empty z3d data')
  if (isMiguAudioMagic(fileData)) return fileData
  let payload = fileData
  if (payload.subarray(0, 3).toString('latin1') === 'Z3D') payload = payload.subarray(3)
  if (!payload.length) throw new Error('empty z3d payload')
  const streamKey = miguZ3DStreamKey(fileKey)
  const plain = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) plain[i] = payload[i]! - streamKey[i & 31]!
  if (!isMiguAudioMagic(plain)) throw new Error('z3d 解密后不是有效音频')
  return plain
}
