import { httpFetch } from '../request.ts'
import musicSearch from './musicSearch.ts'
import { formatSinger } from './util.ts'
import leaderboard from './leaderboard.ts'
import lyric from './lyric.ts'
import pic from './pic.ts'
import kwApi from '../apis/kw.ts'
import songList from './songList.ts'
import hotSearch from './hotSearch.ts'
import comment from './comment.ts'
import album from './album.ts'
import type { HttpRequestObject } from '../types.ts'

const kw = {
  _musicInfoRequestObj: null as HttpRequestObject | null,
  _musicInfoPromiseCancelFn: null,
  _musicPicRequestObj: null as HttpRequestObject | null,
  _musicPicPromiseCancelFn: null,
  album,
  // context: null,


  // init(context) {
  //   if (this.isInited) return
  //   this.isInited = true
  //   this.context = context

  //   // this.musicSearch.search('我又想你了').then(res => {
  //   //   console.log(res)
  //   // })

  //   // this.getMusicUrl('62355680', '320k').then(url => {
  //   //   console.log(url)
  //   // })
  // },

  musicSearch,
  leaderboard,
  songList,
  hotSearch,
  comment,
  getLyric(songInfo, isGetLyricx) {
    // let singer = songInfo.singer.indexOf('、') > -1 ? songInfo.singer.split('、')[0] : songInfo.singer
    return lyric.getLyric(songInfo, isGetLyricx)
  },
  handleMusicInfo(songInfo) {
    return this.getMusicInfo(songInfo).then(info => {
      // console.log(JSON.stringify(info))
      songInfo.name = info.name
      songInfo.singer = formatSinger(info.artist)
      songInfo.img = info.pic
      songInfo.albumName = info.album
      return songInfo
      // return Object.assign({}, songInfo, {
      //   name: info.name,
      //   singer: formatSinger(info.artist),
      //   img: info.pic,
      //   albumName: info.album,
      // })
    })
  },

  getMusicUrl(songInfo, type) {
    return kwApi.getMusicUrl(songInfo, type)
  },

  getMusicInfo(songInfo) {
    if (this._musicInfoRequestObj) this._musicInfoRequestObj.cancelHttp()
    this._musicInfoRequestObj = httpFetch(`http://www.kuwo.cn/api/www/music/musicInfo?mid=${songInfo.songmid}`)
    return this._musicInfoRequestObj!.promise.then(({ body }) => {
      return body.code === 200 ? body.data : Promise.reject(new Error(body.msg))
    })
  },

  getMusicUrls(musicInfo, cb) {
    let tasks: Array<Promise<any>> = []
    let songId = musicInfo.songmid
    musicInfo.types.forEach(type => {
      tasks.push(kw.getMusicUrl(songId, type.type).promise)
    })
    Promise.all(tasks).then(urlInfo => {
      let typeUrl = {}
      urlInfo.forEach(info => {
        typeUrl[info.type] = info.url
      })
      cb(typeUrl)
    })
  },

  getPic(songInfo) {
    return pic.getPic(songInfo)
  },

  getMusicDetailPageUrl(songInfo) {
    return `http://www.kuwo.cn/play_detail/${songInfo.songmid}`
  },

  // init() {
  //   return getToken()
  // },
}

export default kw
