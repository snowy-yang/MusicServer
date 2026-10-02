// 蜻蜓FM 频道节目列表（官网 SSR 页解析）
// 接口: https://www.qingting.fm/channels/<id>（302 → www.qtfm.cn，见 http.ts）
// 实测（2026-10-02）SSR 输出含节目表格：a.pTitle href=/channels/<cid>/programs/<pid> + p[title] + span.col2 时长
// 节目条目的 songmid 采用复合 id "<channelId>:<programId>"（取流签名需要两者）
import { ssrGet } from './http.ts'

const decodeEntities = (s: string) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")

const fetchChannelHtml = async(channelId: string) => {
  const { statusCode, html } = await ssrGet(`https://www.qingting.fm/channels/${channelId}`)
  if (statusCode != 200) throw new Error(`获取频道失败（HTTP ${statusCode}）`)
  return html
}

export const getChannelPrograms = async(channelId: string) => {
  const html = await fetchChannelHtml(channelId)

  const name = decodeEntities(html.match(/<title>([^<]*)</)?.[1]?.split('-')[0]?.trim() || channelId)
  const rows = [...html.matchAll(/href="\/channels\/(\d+)\/programs\/(\d+)"[^>]*>\s*<p[^>]*title="([^"]*)"/g)]
  // 标题可能为空（p[title] 空串），用行内文本兜底；时长在后续 col2
  const list = rows.map(m => ({
    songmid: `${m[1]}:${m[2]}`,
    name: decodeEntities(m[3]) || `节目 ${m[2]}`,
    singer: name,
    albumId: String(channelId),
    albumName: name,
    interval: 0,
    payPlay: false,
    img: null,
    lrc: '',
    lrcx: '',
    types: [],
    _types: {},
    disabled: false,
  }))
  return { name, list }
}

/** 频道封面（SSR 页 og:image） */
export const getChannelOgImage = async(channelId: string): Promise<string | null> => {
  const html = await fetchChannelHtml(channelId)
  const og = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] || html.match(/content="([^"]+)"\s+property="og:image"/)?.[1]
  return og ? og.replace('http://', 'https://') : null
}

export default { getChannelPrograms }
