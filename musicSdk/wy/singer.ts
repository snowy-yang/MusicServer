import { eapiRequest } from './utils/index.ts'
import { formatPlayTime, sizeFormate } from '../index.ts'
import { formatSingerName } from '../utils.ts'

export default {
  /**
   * 获取歌手信息
   * @param {*} id
   */
  getInfo(id) {
    return eapiRequest('/api/artist/head/info/get', { id }).promise.then(({ body }) => {
      if (!body || body.code != 200) throw new Error('get singer info faild.')
      // 响应结构为 { code, data: { artist: { ... } } }，无 body.user
      const artist = body.data?.artist
      if (!artist) throw new Error('get singer info faild.')
      return {
        source: 'wy',
        id: artist.id,
        info: {
          name: artist.name,
          desc: artist.briefDesc,
          avatar: artist.avatar ?? artist.cover ?? null,
          gender: null,
        },
        count: {
          music: artist.musicSize,
          album: artist.albumSize,
        },
      }
    })
  },
  /**
   * 获取歌手歌曲列表
   * @param {*} id
   * @param {*} page
   * @param {*} limit
   */
  getSongList(id, page = 1, limit = 100) {
    return eapiRequest('/api/v2/artist/songs', {
      id,
      limit,
      offset: (page - 1) * limit,
    }).promise.then(({ body }) => {
      if (!body.songs || body.code != 200) throw new Error('get singer song list faild.')

      const list = this.filterSongList(body.songs)
      return {
        list,
        limit,
        page,
        total: body.total,
        source: 'wy',
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
    return eapiRequest(`/api/artist/albums/${id}`, {
      limit,
      offset: (page - 1) * limit,
    }).promise.then(({ body }) => {
      if (!body.hotAlbums || body.code != 200) throw new Error('get singer album list faild.')

      const list = this.filterAlbumList(body.hotAlbums)
      return {
        source: 'wy',
        list,
        limit,
        page,
        total: body.artist.albumSize,
      }
    })
  },
  filterAlbumList(raw) {
    const list: any[] = []
    raw.forEach(item => {
      if (!item.id) return
      list.push({
        id: item.id,
        count: item.size,
        info: {
          name: item.name,
          author: formatSingerName(item.artists),
          img: item.picUrl,
          desc: null,
        },
      })
    })
    return list
  },
  filterSongList(raw) {
    const list: any[] = []
    raw.forEach(item => {
      if (!item.id) return

      const types: Array<{ type: string, size: string | null }> = []
      const _types: Record<string, { size: string | null }> = {}
      let size
      item.privilege.chargeInfoList.forEach(i => {
        switch (i.rate) {
          case 128000:
            size = item.lMusic ? sizeFormate(item.lMusic.size) : null
            types.push({ type: '128k', size })
            _types['128k'] = {
              size,
            }
            break
          case 320000:
            size = item.hMusic ? sizeFormate(item.hMusic.size) : null
            types.push({ type: '320k', size })
            _types['320k'] = {
              size,
            }
            break
          case 999000:
            size = item.sqMusic ? sizeFormate(item.sqMusic.size) : null
            types.push({ type: 'flac', size })
            _types.flac = {
              size,
            }
            break
          case 1999000:
            size = item.hrMusic ? sizeFormate(item.hrMusic.size) : null
            types.push({ type: 'flac24bit', size })
            _types.flac24bit = {
              size,
            }
            break
        }
      })

      list.push({
        singer: formatSingerName(item.artists),
        name: item.name,
        albumName: item.album.name,
        albumId: item.album.id,
        songmid: item.id,
        source: 'wy',
        interval: formatPlayTime((item.dt ?? item.duration) / 1000),
        img: item.album?.picUrl ?? null,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {},
      })
    })
    return list
  },
}
