// 咪咕取流 —— listen-url 多档位候选链 + 逐档探测（Range 0-63 验音频魔数/解密验证），
// 命中可访问的最高档位；匿名仅 PQ(128k) 可用，HQ/SQ/ZQ 各档需登录 Cookie。
// 上游对应：music-lib/migu/download.go（GetDownloadInfo / buildMiguDownloadCandidates /
//   selectHighestValidDownload / rewriteMiguToneURL / embeddedDownloadInfoFromResponse）
import { httpFetch } from '../common/request.ts'
import {
  AndroidChannel, AndroidUA, AndroidVersion, decryptZ3D, firstNonEmpty,
  getMiguCookie, isMiguAudioMagic, miguFormatExt, TONE_QUALITY, type MiguSongItem,
} from '../migu/util.ts'

export const supportQualitys = ['64k', '128k', '320k', 'flac', 'flac24bit']

/** 平台档位 → 咪咕 toneFlag（取流请求用） */
const QUALITY_TONE: Record<string, string> = {
  '64k': 'LQ',
  '128k': 'PQ',
  '320k': 'HQ',
  flac: 'SQ',
  flac24bit: 'ZQ24',
  wav: 'ZQ32',
}

const TONE_EXT: Record<string, string> = {
  LQ: 'mp3', PQ: 'mp3', HQ: 'mp3', SQ: 'flac', ZQ: 'flac', ZQ24: 'flac',
  ZQ32: 'wav', Z3D: 'wav', I3D: 'm4a', '3D60': 'wav',
}

/** 可重写的 tone 路径（上游 miguTonePaths） */
const TONE_PATHS: Record<string, string> = {
  LQ: '全曲试听/Mp3_64_22_16',
  PQ: '标清高清/MP3_128_16_Stero',
  HQ: '标清高清/MP3_320_16_Stero',
  SQ: '歌曲下载/flac',
  ZQ: '歌曲下载/flac_24bit',
  ZQ24: '歌曲下载/flac_24bit',
  ZQ32: '歌曲下载/wav_32bit',
}

const TONE_PREFERENCE = ['ZQ32', 'ZQ24', 'ZQ', 'SQ', 'HQ', 'Z3D', 'I3D', '3D60', 'PQ', 'LQ']

const normalizeTone = (value?: string): string => {
  const v = String(value ?? '').trim().replace(/^\./, '').toUpperCase()
  return TONE_EXT[v] ? v : ''
}

/** songinfo → (contentId, resourceType, formatType)：extra 优先，否则拆 songmid 的 `a|b|c` */
export const miguSongParts = (songInfo: any): { contentId: string, resourceType: string, formatType: string } => {
  const extra = songInfo?.extra ?? {}
  let contentId = String(extra.content_id ?? '').trim()
  let resourceType = String(extra.resource_type ?? '').trim()
  let formatType = String(extra.format_type ?? '').trim()
  if (contentId && resourceType && formatType) return { contentId, resourceType, formatType }
  const parts = String(songInfo?.songmid ?? songInfo?.id ?? '').split('|')
  if (parts.length === 3) {
    return { contentId: parts[0]!.trim(), resourceType: parts[1]!.trim(), formatType: parts[2]!.trim() }
  }
  if (!contentId) contentId = String(songInfo?.songmid ?? songInfo?.id ?? '').trim()
  return { contentId, resourceType, formatType }
}

interface ListenResponse {
  code?: string
  info?: string
  data?: {
    url?: string
    formatType?: string
    dialogInfo?: { text?: string }
    songItem?: MiguSongItem
  }
}

/** listen-url 请求（Android 客户端头）；失败时抛出带 api 文案的错误 */
const fetchListenInfo = async(
  contentId: string, copyrightId: string, songId: string, albumId: string, resourceType: string, toneFlag: string,
): Promise<ListenResponse> => {
  const params: Record<string, string> = {
    netType: '01',
    resourceType: firstNonEmpty(resourceType, '2'),
    contentId: contentId.trim(),
    toneFlag: firstNonEmpty(toneFlag, 'PQ'),
  }
  if (copyrightId.trim()) params.copyrightId = copyrightId.trim()
  if (songId.trim()) params.songId = songId.trim()
  if (albumId.trim()) params.albumId = albumId.trim()

  const cookie = getMiguCookie()
  const headers: Record<string, string> = {
    'User-Agent': AndroidUA,
    channel: AndroidChannel,
    version: AndroidVersion,
    Referer: 'https://music.migu.cn/',
  }
  if (cookie) headers.Cookie = cookie

  const { statusCode, body } = await httpFetch(`https://c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url?${new URLSearchParams(params)}`, {
    headers,
    timeout: 30000,
  }).promise
  if (statusCode < 200 || statusCode >= 300) throw new Error(`migu listen endpoint returned status ${statusCode}`)
  const result = body as ListenResponse
  if (result?.code && result.code !== '000000') throw new Error(`migu api error: ${result.info} (code ${result.code})`)
  return result
}

const normalizeDownloadURL = (rawURL?: string | null): string => {
  let url = String(rawURL ?? '').trim()
  if (!url) return ''
  if (url.startsWith('//')) url = `https:${url}`
  if (url.startsWith('ftp://218.200.160.122:21/')) {
    url = `https://freetyst.nf.migu.cn/${url.slice('ftp://218.200.160.122:21/'.length)}`
  }
  return url
}

interface DownloadInfo {
  url: string
  format: string
  ext: string
  encrypted: boolean
  fileKey: string
  size: number
}

const directDownloadInfo = (rawURL: string, format: string, expectedSize: number): DownloadInfo | null => {
  const url = normalizeDownloadURL(rawURL)
  if (!url) return null
  let ext = ''
  try {
    const path = new URL(url).pathname
    ext = (path.split('.').pop() ?? '').toLowerCase()
    if (!ext || ext.includes('/')) ext = ''
  } catch { ext = '' }
  let tone = normalizeTone(format)
  if (!ext) ext = TONE_EXT[tone] ?? ''
  if (!ext) ext = 'mp3'
  if (!tone) {
    // 按扩展名回填档位（上游 formatFromMiguExt）
    switch (ext) {
      case 'flac': tone = 'SQ'; break
      case 'wav': tone = 'ZQ32'; break
      case 'm4a': tone = 'I3D'; break
      default: tone = 'PQ'
    }
  }
  return { url, format: tone, ext, encrypted: false, fileKey: '', size: expectedSize }
}

/** z3dCode 内嵌的加密候选（Z3D/I3D/3D60），上游 embeddedDownloadInfoFromResponse */
const embeddedDownloadInfo = (resp: ListenResponse, targetTone: string, expectedSize: number): DownloadInfo | null => {
  const code = resp?.data?.songItem?.z3dCode
  if (!code) return null
  const parseSize = (v?: string) => {
    const n = parseInt(String(v ?? '').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  switch (targetTone) {
    case 'Z3D': {
      const url = normalizeDownloadURL(firstNonEmpty(code.androidUrl, code.url))
      const fileKey = String(code.androidFileKey ?? '').trim()
      if (!url || !fileKey) return null
      return {
        url, format: 'Z3D',
        ext: firstNonEmpty(String(code.androidFileType ?? '').replace(/^\./, ''), 'wav'),
        encrypted: true, fileKey,
        size: parseSize(code.androidSize) || expectedSize,
      }
    }
    case 'I3D': {
      const url = normalizeDownloadURL(firstNonEmpty(code.iosUrl, code.url))
      const fileKey = String(code.iosFileKey ?? '').trim()
      if (!url || !fileKey) return null
      return {
        url, format: 'I3D',
        ext: firstNonEmpty(String(code.iosFileType ?? '').replace(/^\./, ''), 'm4a'),
        encrypted: true, fileKey,
        size: parseSize(code.iosSize) || expectedSize,
      }
    }
    case '3D60': {
      const url = normalizeDownloadURL(firstNonEmpty(code.url, code.h5Url))
      if (!url) return null
      return {
        url, format: '3D60',
        ext: firstNonEmpty(String(code.fileType ?? '').replace(/^\./, ''), 'wav'),
        encrypted: false, fileKey: '',
        size: parseSize(code.size) || expectedSize,
      }
    }
    default:
      return null
  }
}

const detectTonePath = (decodedPath: string): string => {
  for (const tone of ['ZQ24', 'ZQ', 'ZQ32', 'SQ', 'HQ', 'LQ', 'PQ']) {
    const tonePath = TONE_PATHS[tone]!
    if (tonePath && decodedPath.includes(tonePath)) return tonePath
  }
  return ''
}

/** 把直链路径里的档位段替换为目标档位（上游 rewriteMiguToneURL） */
const rewriteToneURL = (rawURL: string, targetTone: string): string | null => {
  const tone = normalizeTone(targetTone)
  const targetPath = TONE_PATHS[tone]
  const targetExt = TONE_EXT[tone]
  if (!targetPath || !targetExt || tone === 'Z3D' || tone === 'I3D' || tone === '3D60') return null
  let parsed: URL
  try { parsed = new URL(normalizeDownloadURL(rawURL)) } catch { return null }
  const decodedPath = decodeURIComponent(parsed.pathname)
  const sourcePath = detectTonePath(decodedPath)
  if (!sourcePath) return null
  let newPath = decodedPath.replace(sourcePath, targetPath)
  if (newPath === decodedPath) return null
  const dotIdx = newPath.lastIndexOf('.')
  if (dotIdx > newPath.lastIndexOf('/')) newPath = newPath.slice(0, dotIdx)
  newPath += `.${targetExt}`
  parsed.pathname = newPath
  return parsed.toString()
}

/** 候选链：按档位优先级（high→low）产出直接/内嵌/重写三类候选（上游 buildMiguDownloadCandidates） */
const buildCandidates = (responses: ListenResponse[], expectedSize: number): DownloadInfo[] => {
  const sources: Array<{ url: string, format: string }> = []
  const seenSources = new Set<string>()
  for (const resp of responses) {
    const candidateURL = normalizeDownloadURL(resp?.data?.url)
    if (!candidateURL) continue
    const actualFormat = normalizeTone(resp?.data?.formatType) || 'PQ'
    const key = `${actualFormat}\u0000${candidateURL}`
    if (seenSources.has(key)) continue
    seenSources.add(key)
    sources.push({ url: candidateURL, format: actualFormat })
  }

  const candidates: DownloadInfo[] = []
  const seen = new Set<string>()
  const add = (info: DownloadInfo | null) => {
    if (!info || !info.url) return
    const key = `${info.format}\u0000${info.url}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(info)
  }

  for (const tone of TONE_PREFERENCE) {
    for (const resp of responses) add(embeddedDownloadInfo(resp, tone, expectedSize))
    for (const source of sources) {
      if (tone === source.format) {
        add(directDownloadInfo(source.url, source.format, expectedSize))
        continue
      }
      const rewritten = rewriteToneURL(source.url, tone)
      if (rewritten) add(directDownloadInfo(rewritten, tone, 0))
    }
  }
  return candidates
}

/** 探测候选可用性：Range 0-63 校验音频魔数（加密流先解密再校验），并回填真实体积 */
const downloadInfoValid = async(info: DownloadInfo): Promise<boolean> => {
  try {
    const cookie = getMiguCookie()
    const headers: Record<string, string> = { 'User-Agent': AndroidUA, Referer: 'https://music.migu.cn/', Range: 'bytes=0-63' }
    if (cookie) headers.Cookie = cookie
    const { statusCode, headers: resHeaders, raw } = await httpFetch(info.url, { headers, timeout: 10000 }).promise
    if (statusCode < 200 || statusCode >= 300) return false
    const prefix = Buffer.isBuffer(raw) ? raw.subarray(0, 64) : Buffer.alloc(0)
    if (!prefix.length) return false
    if (info.encrypted) {
      try { decryptZ3D(prefix, info.fileKey) } catch { return false }
    } else if (!isMiguAudioMagic(prefix)) {
      return false
    }
    const contentRange = String((resHeaders as any)['content-range'] ?? '')
    const slash = contentRange.lastIndexOf('/')
    if (slash >= 0) {
      const size = parseInt(contentRange.slice(slash + 1).trim(), 10)
      if (Number.isFinite(size) && size > 0) info.size = size
    }
    return true
  } catch {
    return false
  }
}

const MAX_PROBES = 10

export interface MiguUrlResult {
  type: string
  url: string
  /** Z3D/I3D 加密流：URL 需解密后才能播放（本服务提供 /stream/mg 代理） */
  encrypted?: boolean
  fileKey?: string
  ext?: string
  size?: number
}

/** 取流入口：候选链 + 逐档探测；返回实际命中的最高档位 */
export const getMusicUrl = (songInfo: any, type: string) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  requestObj.promise = (async(): Promise<MiguUrlResult> => {
    const { contentId, resourceType, formatType } = miguSongParts(songInfo)
    if (!contentId) throw new Error('migu 歌曲 id 无效（需 contentId 或 contentId|resourceType|formatType）')
    const rt = resourceType || '2'
    const targetTone = normalizeTone(QUALITY_TONE[type] ?? '')
      || normalizeTone(formatType)
      || normalizeTone(songInfo?.ext)
      || 'PQ'

    const copyrightId = String(songInfo?.extra?.copyright_id ?? '')
    const songId = String(songInfo?.extra?.song_id ?? '')
    const albumId = String(songInfo?.extra?.album_id ?? songInfo?.albumId ?? '')

    const requestTones: string[] = []
    for (const tone of ['ZQ32', targetTone, 'PQ']) {
      if (!requestTones.includes(tone)) requestTones.push(tone)
    }

    const responses: ListenResponse[] = []
    let fetchErr: Error | null = null
    for (const tone of requestTones) {
      try {
        responses.push(await fetchListenInfo(contentId, copyrightId, songId, albumId, rt, tone))
      } catch (err: any) {
        if (!fetchErr) fetchErr = err
      }
    }
    if (!responses.length) throw fetchErr ?? new Error('migu listen-url 全部失败')

    const expectedSize = Number(songInfo?.size ?? 0) || 0
    const candidates = buildCandidates(responses, expectedSize)
    let probed = 0
    for (const candidate of candidates) {
      if (probed++ >= MAX_PROBES) break
      if (await downloadInfoValid(candidate)) {
        const quality = TONE_QUALITY[candidate.format] ?? type
        return {
          type: quality,
          url: candidate.url,
          ...(candidate.encrypted ? { encrypted: true, fileKey: candidate.fileKey } : {}),
          ext: candidate.ext || miguFormatExt(candidate.format),
          size: candidate.size,
        }
      }
    }

    // 全部候选不可用：优先回传接口文案（如「登录后免费试听」）
    const dialog = responses.map(r => String(r?.data?.dialogInfo?.text ?? '').trim()).find(Boolean)
    if (dialog) throw new Error(`migu 无可用音频：${dialog}（登录后可解锁更高档位）`)
    if (fetchErr) throw fetchErr
    throw new Error('migu 未返回可访问的音频档位')
  })()
  return requestObj
}

export default { getMusicUrl, supportQualitys }
