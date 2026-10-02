// 懒人听书搜索（App 通道，游客匿名）
// 接口: /yyting/search/searchBatch.action?keyWord=&searchOption=1&pageSize=&type=0&q=2150
// 实测（2026-10-02）匿名可用；结果分 data.bookResult/albumResult/folderResult/...
// 书籍条目字段：id(baseEntityId 同值)/name/announcer/cover
import { appApiGet } from './appApi.ts'

export const search = async(keyword: string, page = 1, limit = 20) => {
  const body = await appApiGet('/yyting/search/searchBatch.action', {
    keyWord: keyword,
    searchOption: '1',
    pageSize: String(limit),
    type: String(page - 1),
    q: '2150',
  })
  if (body.apiStatus != null && body.apiStatus !== 0) throw new Error(body.msg || `搜索失败（code ${body.apiStatus}）`)
  const books = body?.data?.bookResult?.list ?? []
  const total = Number(body?.data?.bookResult?.count ?? books.length)
  return {
    allPage: Math.ceil(total / limit) || page,
    total,
    limit,
    source: 'lr' as const,
    list: books.map((item: any) => ({
      songmid: String(item.id ?? item.baseEntityId),
      name: item.name || '',
      singer: item.announcer || item.author || '',
      albumId: '',
      albumName: '',
      interval: 0,
      payPlay: false,
      img: item.cover || null,
      lrc: '',
      lrcx: '',
      types: [],
      _types: {},
      disabled: false,
    })),
  }
}

export default { search }
