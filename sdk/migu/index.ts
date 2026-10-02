// 咪咕音乐平台模块 —— 搜索 / 取流（多档候选 + Z3D 解密标注）/ 歌词 / 封面 / 专辑 / 歌单 / 链接解析
// 上游对应：music-lib/migu/（migu.go、song.go、lyric.go、album.go、playlist.go、download.go）
// 匿名面（2026-10-02 实测）：搜索、PQ(128k mp3) 取流、歌词、封面、专辑曲目、歌单曲目均可用；
// HQ/SQ/ZQ 各档需登录 Cookie（接口返回「登录后免费试听」）。
import miguApi from '../apis/migu.ts'
import musicSearch from './musicSearch.ts'
import lyric, { contentIdOf } from './lyric.ts'
import album from './album.ts'
import playlist from './playlist.ts'
import { fetchSongDetail, miguSongLink } from './util.ts'

const migu = {
  musicSearch,
  getMusicUrl(songInfo: any, type: string) {
    return miguApi.getMusicUrl(songInfo, type)
  },
  getLyric(songInfo: any) {
    return lyric.getLyric(songInfo)
  },
  getPic(songInfo: any) {
    return (async() => {
      if (songInfo?.img) return songInfo.img
      const contentID = contentIdOf(songInfo)
      if (!contentID) return null
      const item = await fetchSongDetail(contentID)
      const { pickMiguImage, normalizeMiguImageURL, firstNonEmpty } = await import('./util.ts')
      return normalizeMiguImageURL(firstNonEmpty(
        pickMiguImage(item.imgItems), pickMiguImage(item.albumImgs), item.img1, item.img2, item.img3,
      )) || null
    })()
  },
  getMusicInfo(songInfo: any) {
    const contentID = contentIdOf(songInfo)
    if (!contentID) return Promise.reject(new Error('migu 歌曲 id 无效'))
    return fetchSongDetail(contentID)
  },
  album,
  playlist,
  parse: {
    parseSong: async(link: string) => parseSong(link),
    parseAlbum: album.parseAlbumLink,
    parsePlaylist: playlist.parsePlaylistLink,
  },
  getMusicDetailPageUrl(songInfo: any) {
    const extra = songInfo?.extra ?? {}
    return String(extra.link ?? '') || miguSongLink(contentIdOf(songInfo))
  },
}

/** 歌曲链接解析：https://music.migu.cn/v3/music/song/<contentId>（含裸 contentId） */
export const parseSong = async(link: string) => {
  const raw = String(link ?? '')
  const m = raw.match(/music\.migu\.cn\/v3\/music\/song\/(\d+)/) || raw.match(/^(\d{6,})$/)
  if (!m) throw new Error('无效的咪咕歌曲链接')
  const contentID = m[1]!
  const item = await fetchSongDetail(contentID)
  const { convertItemToSong } = await import('./util.ts')
  const song = convertItemToSong(item, true)
  if (!song) throw new Error('该歌曲没有可用格式')
  return song
}

export default migu
