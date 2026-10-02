// 酷狗链接解析
// 歌曲：https://www.kugou.com/song/#hash=<32位hash>（含 &album_id=... 等尾串）、裸 hash
// 上游对应：music-lib/kugou/song.go Parse / kugou.go fetchSongInfo
//   元数据 m.kugou.com/app/i/getSongInfo.php（songName/author_name/timeLength/album_img/bitRate）
//   另尽力合并 musicInfo.getMusicInfo 的专辑/多档 hash，直链取流失败不影响返回（上游为必得 URL）。
import { httpFetch } from '../request.ts'
import { formatPlayTime, decodeName } from '../index.ts'
import kgApi from '../apis/kg.ts'
import { getMusicInfo } from './musicInfo.ts'
import album from './album.ts'
import playlist from './playlist.ts'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1'

const HASH_RE = /hash=([a-fA-F0-9]{32})/i
const RAW_HASH_RE = /^[a-fA-F0-9]{32}$/

/** 链接/裸 hash → 32 位小写 hash（上游 Parse 的 `(?i)hash=([a-f0-9]{32})`，另接受裸 hash） */
export const extractHash = (link: any): string => {
  const raw = String(link ?? '').trim()
  const match = raw.match(HASH_RE)
  if (match) return match[1]!.toLowerCase()
  return RAW_HASH_RE.test(raw) ? raw.toLowerCase() : ''
}

/** 上游 fetchSongInfo：m.kugou.com playInfo（返回元数据 + 直链，付费曲无 url） */
const fetchSongInfoPhp = async(hash: string) => {
  const { statusCode, body } = await httpFetch(`http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`, {
    method: 'get',
    headers: { 'User-Agent': UA, Referer: 'http://m.kugou.com' },
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || typeof body !== 'object' || body == null) return null
  if (Number(body.errcode ?? 0) !== 0 || !body.hash) return null
  return body
}

/** 上游 Parse：酷狗歌曲链接（或裸 hash）→ Song，尽力附带直链 */
export const parseSong = async(link: string) => {
  const hash = extractHash(link)
  if (!hash) throw new Error('无效的酷狗歌曲链接（未找到 32 位 hash）')

  let [raw, info] = await Promise.all([
    fetchSongInfoPhp(hash).catch(() => null),
    getMusicInfo(hash).catch(() => undefined),
  ])
  if (!raw && !info) throw new Error('酷狗歌曲不存在或已下架')

  const fileName = String(raw?.fileName ?? '')
  const name = decodeName(String(raw?.songName ?? '').trim() || fileName.split(' - ').slice(1).join(' - ') || info?.name || '')
  const singer = decodeName(String(raw?.author_name ?? '').trim() || info?.singer || '')
  const duration = Number(raw?.timeLength ?? 0) || 0

  const song: any = {
    songmid: String(info?.songmid ?? raw?.audio_id ?? '').trim(),
    hash: String(raw?.hash ?? hash).toLowerCase(),
    name,
    singer,
    albumName: decodeName(String(info?.albumName ?? '').trim()),
    albumId: String(info?.albumId ?? raw?.albumid ?? raw?.req_albumid ?? '').trim(),
    interval: duration > 0 ? formatPlayTime(duration) : (info?.interval ?? '--/--'),
    img: String(raw?.album_img ?? '').replace('{size}', '240') || info?.img || null,
    lrc: null,
    otherSource: null,
    types: info?.types ?? [],
    _types: info?._types ?? {},
    typeUrl: {},
    source: 'kg' as const,
    extra: {
      hash: String(raw?.hash ?? hash).toLowerCase(),
      url: String(raw?.url ?? ''),
      backup_url: raw?.backup_url ?? [],
      bitrate: Number(raw?.bitRate ?? 0) || 0,
      link: `https://www.kugou.com/song/#hash=${hash}`,
    },
  }

  // 上游 fetchSongInfo 必得 URL：playInfo 的 url/backup_url 优先（官方直链，付费曲为空）
  if (!song.url) {
    const rawUrl = String(raw?.url ?? '') || String(raw?.backup_url?.[0] ?? '')
    if (rawUrl) {
      song.url = rawUrl
      song.type = Number(raw?.bitRate ?? 0) >= 320000 ? '320k' : '128k'
    }
  }
  // 仍无直链时（风控/付费）用 apis/kg 的签名通道尽力补一次；失败仅返回元数据
  if (!song.url) {
    try {
      const hit = await kgApi.getMusicUrl({
        hash: song.hash,
        albumId: song.albumId,
        songmid: song.songmid,
        _types: song._types,
      } as any, '128k').promise
      if (hit?.url) {
        song.url = hit.url
        song.type = hit.type
      }
    } catch {
      // 忽略：与上游付费曲无直链的失败语义一致（元数据仍返回）
    }
  }

  return song
}

export const parseAlbum = async(link: string) => album.parseAlbumLink(link)

export const parsePlaylist = async(link: string) => playlist.parsePlaylistLink(link)

export default { parseSong, parseAlbum, parsePlaylist }
