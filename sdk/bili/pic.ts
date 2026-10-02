// Bilibili 封面：搜索结果/合集条目已带封面；仅有 id 时回源 x/web-interface/view 取 pic
import { fetchView, normalizeCover, parseSongId } from './util.ts'

export const getPic = async(songInfo: any): Promise<string> => {
  const direct = String(songInfo?.img || '')
  if (/^https?:/i.test(direct)) return direct
  const bvid = String(songInfo?.bvid || '') || parseSongId(songInfo?.songmid).bvid
  if (!bvid) return ''
  try {
    const view = await fetchView(bvid)
    return normalizeCover(view?.pic || '')
  } catch {
    return ''
  }
}

export default { getPic }
