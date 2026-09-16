import { filterMusicInfoItem } from './singer.ts'
import { createMusicuFetch } from './utils/index.ts'

export default {
  /**
   * 通过专辑 mid 获取专辑详情与曲目列表
   * @param {*} id 专辑 mid（搜索结果中的 albumId）
   * @param {*} page
   * @param {*} limit
   */
  async getAlbumDetail(id, page = 1, limit = 100) {
    const body = await createMusicuFetch({
      req: {
        module: 'music.musichallAlbum.AlbumSongList',
        method: 'GetAlbumSongList',
        // 注意：参数名是驼峰 albumMid，下划线形态会被上游以 104400 拒绝
        param: { albumMid: id, begin: (page - 1) * limit, num: limit },
      },
    })
    if (body.req.code != 0) throw new Error('get album song list faild.')

    const data = body.req.data
    const songList = data.songList ?? []
    // GetAlbumInfo 详情接口已停用：专辑名取自曲目自带的 album 信息，
    // 作者由曲目歌手去重合成，封面用平台固定图片 URL 规则
    const first = songList[0]?.songInfo
    const authors = [...new Set(songList.flatMap(item => item.songInfo?.singer?.map(s => s.name) ?? []))]
    return {
      source: 'tx',
      info: {
        name: first?.album?.name ?? null,
        img: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${id}.jpg`,
        desc: null,
        author: authors.join('、') || null,
      },
      list: this.filterSongList(songList),
      page,
      limit,
      total: data.totalNum,
    }
  },
  filterSongList(raw) {
    return (raw ?? []).map(item => filterMusicInfoItem(item.songInfo))
  },
}
