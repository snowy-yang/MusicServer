// 喜马拉雅搜索（web 通道）
// 接口: https://www.ximalaya.com/revision/search?core=track&kw=&page=&rows=&spellchecker=true&condition=relation&device=web
// 实测（2026-10-02）匿名可用（注意：同参数的 /revision/search/main 与 /search/main 会命中
// risk invalid 风控，本端点 + condition=relation&device=web 不受影响）
// 返回 data.result.response.docs[]，字段 id/title/duration(秒)/nickname/album_id/album_title/
// album_cover_path/is_paid/is_trailer
import { httpFetch } from '../request.ts'
import { formatPlayTime } from '../index.ts'
import { XM_UA } from './sign.ts'

const SEARCH_URL = 'https://www.ximalaya.com/revision/search'

const normalizeCover = (path: unknown): string | null => {
  if (!path) return null
  const s = String(path)
  return s.startsWith('http') ? s : `https://imagev2.xmcdn.com/${s}`
}

export const search = (keyword: string, page = 1, limit = 20) => {
  const params = new URLSearchParams({
    core: 'track', kw: keyword, page: String(page), rows: String(limit),
    spellchecker: 'true', condition: 'relation', device: 'web',
  })
  return httpFetch(`${SEARCH_URL}?${params.toString()}`, {
    headers: { 'User-Agent': XM_UA, Accept: 'application/json, text/plain, */*', Referer: 'https://www.ximalaya.com/' },
    timeout: 15000,
  }).promise.then(({ statusCode, body }: any) => {
    if (statusCode != 200 || body?.ret != 200) throw new Error(body?.msg || '搜索失败')
    const docs = body?.data?.result?.response?.docs ?? []
    const total = Number(body?.data?.result?.response?.numFound ?? docs.length)
    const allPage = Math.ceil(total / limit) || page
    return {
      allPage,
      total,
      limit,
      source: 'xm' as const,
      list: docs.map((item: any) => ({
        songmid: String(item.id),
        name: item.title || '',
        singer: item.nickname || '',
        albumId: item.album_id ? String(item.album_id) : '',
        albumName: item.album_title || '',
        interval: item.duration ? formatPlayTime(Number(item.duration)) : 0,
        payPlay: Boolean(item.is_paid),
        img: normalizeCover(item.album_cover_path),
        lrc: '',
        lrcx: '',
        types: [],
        _types: {},
        disabled: false,
      })),
    }
  })
}

export default { search }
