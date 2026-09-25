import type { SongType, Quality, QualityInfo } from '../types.ts'

import { formatPlayTime, sizeFormate } from '../index.ts'
import { formatSingerName } from '../utils.ts'
import { createMusicuFetch } from './utils/index.ts'

export const filterMusicInfoItem = item => {
  const types: SongType[] = []
  const _types: Partial<Record<Quality, QualityInfo>> = {}
  if (item.file.size_128mp3 != 0) {
    let size = sizeFormate(item.file.size_128mp3)
    types.push({ type: '128k', size })
    _types['128k'] = {
      size,
    }
  }
  if (item.file.size_320mp3 !== 0) {
    let size = sizeFormate(item.file.size_320mp3)
    types.push({ type: '320k', size })
    _types['320k'] = {
      size,
    }
  }
  if (item.file.size_flac !== 0) {
    let size = sizeFormate(item.file.size_flac)
    types.push({ type: 'flac', size })
    _types.flac = {
      size,
    }
  }
  if (item.file.size_hires !== 0) {
    let size = sizeFormate(item.file.size_hires)
    types.push({ type: 'flac24bit', size })
    _types.flac24bit = {
      size,
    }
  }

  const albumId = item.album.id ?? ''
  const albumMid = item.album.mid ?? ''
  const albumName = item.album.name ?? ''
  return {
    source: 'tx',
    singer: formatSingerName(item.singer, 'name'),
    name: item.title,
    albumName,
    albumId,
    albumMid,
    interval: formatPlayTime(item.interval),
    songId: item.id,
    songmid: item.mid,
    strMediaMid: item.file.media_mid,
    img: (albumId === '' || albumId === '空')
      ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : ''
      : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`,
    types,
    _types,
    typeUrl: {},
  }
}


// 歌手详情接口（musichallSinger.GetSingerDetail 等）已停用（104403）：
// 歌手名/统计由 GetSingerSongList 与 GetAlbumList 合成，头像走固定图片 URL 规则
export default {
  /**
   * 获取歌手信息
   * @param {*} id
   */
  getInfo(id) {
    return Promise.all([
      createMusicuFetch({ req: { module: 'musichall.song_list_server', method: 'GetSingerSongList', param: { singerMid: id, order: 1, begin: 0, num: 1 } } }),
      createMusicuFetch({ req: { module: 'music.musichallAlbum.AlbumListServer', method: 'GetAlbumList', param: { singerMid: id, order: 0, begin: 0, num: 1, songNumTag: 0, singerID: 0 } } }),
    ]).then(([songBody, albumBody]) => {
      if (songBody.req.code != 0 || albumBody.req.code != 0) throw new Error('get singer info faild.')
      const songData = songBody.req.data
      const albumData = albumBody.req.data
      // 详情接口停用：歌手名从歌曲条目反查，头像用平台的固定图片 URL 规则
      const singers = songData.songList?.[0]?.songInfo?.singer ?? []
      const self = singers.find(s => s.mid === id) ?? singers[0]
      return {
        source: 'tx',
        id,
        info: {
          name: self?.name ?? '',
          desc: null,
          avatar: `https://y.gtimg.cn/music/photo_new/T001R500x500M000${id}.jpg`,
          gender: null,
        },
        count: {
          music: songData.totalNum,
          album: albumData.total,
        },
      }
    })
  },
  /**
   * 获取歌手专辑列表
   * @param {*} id
   * @param {*} page
   * @param {*} limit
   */
  getAlbumList(id, page = 1, limit = 10) {
    return createMusicuFetch({
      req: {
        module: 'music.musichallAlbum.AlbumListServer',
        method: 'GetAlbumList',
        param: {
          singerMid: id,
          order: 0,
          begin: (page - 1) * limit,
          num: limit,
          songNumTag: 0,
          singerID: 0,
        },
      },
    }).then(body => {
      if (body.req.code != 0) throw new Error('get singer album faild.')

      const list = this.filterAlbumList(body.req.data.albumList)
      return {
        source: 'tx',
        list,
        limit,
        page,
        total: body.req.data.total,
      }
    })
  },
  /**
   * 获取歌手歌曲列表
   * @param {*} id
   * @param {*} page
   * @param {*} limit
   */
  async getSongList(id, page = 1, limit = 100) {
    const body = await createMusicuFetch({
      req: {
        module: 'musichall.song_list_server',
        method: 'GetSingerSongList',
        param: {
          singerMid: id,
          order: 1,
          begin: (page - 1) * limit,
          num: limit,
        },
      },
    })
    if (body.req.code != 0) throw new Error('get singer song list faild.')

    const list = this.filterSongList(body.req.data.songList)
    return {
      source: 'tx',
      list,
      limit,
      page,
      total: body.req.data.totalNum,
    }
  },
  filterAlbumList(raw) {
    return raw.map(item => {
      return {
        id: item.albumID,
        mid: item.albumMid,
        count: item.totalNum,
        info: {
          name: item.albumName,
          author: item.singerName,
          img: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.albumMid}.jpg`,
          desc: null,
        },
      }
    })
  },
  filterSongList(raw) {
    return raw.map(item => {
      return filterMusicInfoItem(item.songInfo)
    })
  },
}

