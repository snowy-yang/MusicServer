// Bilibili 链接解析（上游 bilibili/song.go 的 `Parse`）
// 支持 https://www.bilibili.com/video/BVxxx?p=2 与 av 号（上游只认 BV，任务要求兼容 av）；
// 与上游一致：合集（ugc_season）或多分P链接会被判定为歌单并抛错，请改用 playlist.parsePlaylistLink。
// 上游 Parse 会顺带填入下载地址，这里同样 best-effort 填充 url（失败不影响元数据返回）。
import { extractAid, extractBvid, extractPage, fetchPageList, fetchView, makeSong, normalizeCover } from './util.ts'
import { getAudioUrl } from '../apis/bili.ts'
import { parsePlaylistLink } from './playlist.ts'

export const parseSong = async(link: string) => {
  const raw = String(link || '').trim()
  const bvid = extractBvid(raw)
  const aid = extractAid(raw)
  if (!bvid && !aid) throw new Error('无效的B站链接：未找到 BV/av 号')

  const view = await fetchView(bvid || aid)
  const pages: any[] = view?.pages ?? []

  // 上游：合集或多分P视为歌单链接（Parse 只处理单P）
  if (view?.ugc_season || pages.length > 1) {
    throw new Error('该链接是合集/多分P视频，请使用歌单解析（parsePlaylistLink）')
  }
  if (pages.length <= 1) {
    try {
      const pageList = await fetchPageList(view.bvid || bvid)
      if (pageList.length > 1) throw new Error('该链接是合集/多分P视频，请使用歌单解析（parsePlaylistLink）')
    } catch (err: any) {
      if (String(err?.message || '').includes('歌单解析')) throw err
      // 分P列表接口失败时按上游语义忽略
    }
  }
  if (!pages.length) throw new Error('未找到视频分P')

  let page = extractPage(raw)
  if (page > pages.length) page = 1
  const target = pages[page - 1]

  const rootTitle = view.title || ''
  let displayTitle = target?.part || ''
  if (pages.length === 1 && !displayTitle) displayTitle = rootTitle
  else if (displayTitle !== rootTitle) displayTitle = `${rootTitle} - ${displayTitle}`

  const cid = String(target?.cid ?? '')
  const song: any = makeSong({
    bvid: view.bvid || bvid,
    cid,
    name: displayTitle,
    artist: view?.owner?.name || '',
    album: view.bvid || bvid,
    duration: target?.duration,
    cover: normalizeCover(view?.pic || ''),
    page,
  })

  // 上游 Parse 会立即填充音频地址（失败忽略）
  if (cid) {
    try {
      const audio = await getAudioUrl(song.bvid, cid)
      if (audio?.url) {
        song.url = audio.url
        song.type = audio.type
      }
    } catch {
      // 忽略：元数据仍可返回
    }
  }
  return song
}

/** 歌单/合集链接解析（上游 bilibili/playlist.go 的 `ParsePlaylist`） */
export const parsePlaylist = async(link: string) => parsePlaylistLink(link)

export default { parseSong, parsePlaylist }
