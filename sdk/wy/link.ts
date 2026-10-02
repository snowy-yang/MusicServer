// 网易云链接解析（上游 music-lib/netease/netease.go 的 parseNeteaseLink 1:1 移植）
// 支持：
//   歌曲     https://music.163.com/#/song?id=29732995   /song?id= / /song/29732995
//   专辑     https://music.163.com/#/album?id=32311     /album?id= / /album/32311
//   歌单     https://music.163.com/#/playlist?id=7507256008 /playlist?id= / /playlist/<id>/<n>/... 
// 裸数字 id 由各模块自行兜底（上游 Parse 不接受裸 id）

export type NeteaseLinkKind = 'song' | 'album' | 'playlist'

const isDigits = (value: string): boolean => value !== '' && /^\d+$/.test(value)

const BASE = 'https://music.163.com'

/** 上游 parseNeteaseLinkCandidate（JS 需给相对候选补 base；Go 的 url.Parse 直接接受相对路径） */
const parseCandidate = (candidate: string): { kind: NeteaseLinkKind | '', id: string } => {
  let parsed: URL
  try {
    parsed = new URL(candidate, BASE)
  } catch {
    return { kind: '', id: '' }
  }

  let kind: NeteaseLinkKind | '' = ''
  const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === 'song' || segment === 'album' || segment === 'playlist') kind = segment
  }

  let id = parsed.searchParams.get('id') ?? ''
  if (!isDigits(id)) id = ''

  if (!kind && segments.length >= 2) {
    const last = segments[segments.length - 1]!
    const prev = segments[segments.length - 2]!
    if (isDigits(last) && (prev === 'song' || prev === 'album' || prev === 'playlist')) {
      kind = prev as NeteaseLinkKind
      id = last
    }
  }

  if (!kind || !id) return { kind: '', id: '' }
  return { kind, id }
}

/** 上游 parseNeteaseLink：依次尝试原链接、path?query、hash 片段 */
export const parseNeteaseLink = (link: string): { kind: NeteaseLinkKind, id: string } => {
  const raw = String(link ?? '').trim()
  const candidates: string[] = [raw]

  const parsed = (() => {
    try {
      return new URL(raw, BASE)
    } catch {
      return null
    }
  })()
  if (parsed) {
    if (parsed.pathname && parsed.pathname !== '/') {
      candidates.push(parsed.pathname + parsed.search)
    }
    const fragment = parsed.hash.replace(/^#!?/, '').trim()
    if (fragment) candidates.push(fragment)
  }

  for (const candidate of candidates) {
    const { kind, id } = parseCandidate(candidate)
    if (kind && id) return { kind, id }
  }
  throw new Error('无效的网易云链接')
}

/** 裸 id 兜底：非 URL 且全数字时视为对应类型的 id */
export const bareId = (link: string): string => {
  const raw = String(link ?? '').trim()
  return /^\d+$/.test(raw) ? raw : ''
}

export default { parseNeteaseLink, bareId }
