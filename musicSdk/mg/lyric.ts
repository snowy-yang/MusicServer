import { httpFetch } from '../request.ts'
import { getMusicInfo } from './musicInfo.ts'
import { decrypt } from './utils/mrc.ts'

const mrcTools = {
  rxps: {
    lineTime: /^\s*\[(\d+),\d+\]/,
    wordTime: /\(\d+,\d+\)/,
    wordTimeAll: /(\(\d+,\d+\))/g,
  },
  parseLyric(str) {
    str = str.replace(/\r/g, '')
    const lines = str.split('\n')
    const yrcLines: string[] = []
    const lrcLines: string[] = []

    for (const line of lines) {
      if (line.length < 6) continue
      let result = this.rxps.lineTime.exec(line)
      if (!result) continue

      const startTime = parseInt(result[1])
      let time: any = startTime
      let ms = time % 1000
      time /= 1000
      let m = parseInt((time / 60) as unknown as string).toString().padStart(2, '0')
      time %= 60
      let s = parseInt(time as unknown as string).toString().padStart(2, '0')
      time = `${m}:${s}.${ms}`

      let words = line.replace(this.rxps.lineTime, '')

      lrcLines.push(`[${time}]${words.replace(this.rxps.wordTimeAll, '')}`)

      let times = words.match(this.rxps.wordTimeAll)
      if (!times) continue
      times = times.map(time => {
        const result = /\((\d+),(\d+)\)/.exec(time)
        return `<${parseInt(result![1]) - startTime},${result![2]}>`
      })
      const wordArr = words.split(this.rxps.wordTime)
      const newWords = times.map((time, index) => `${time}${wordArr[index]}`).join('')
      yrcLines.push(`[${time}]${newWords}`)
    }
    return {
      lyric: lrcLines.join('\n'),
      yrc: yrcLines.join('\n'),
    }
  },
  getText(url, tryNum = 0) {
    const requestObj = httpFetch(url, {
      headers: {
        Referer: 'https://app.c.nf.migu.cn/',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
        channel: '0146921',
      },
    })
    return requestObj.promise.then(({ statusCode, body }) => {
      if (statusCode == 200) return body
      if (tryNum > 5 || statusCode == 404) return Promise.reject(new Error('歌词获取失败'))
      return this.getText(url, ++tryNum)
    })
  },
  getMrc(url) {
    return this.getText(url).then(text => {
      return this.parseLyric(decrypt(text))
    })
  },
  getLrc(url) {
    return this.getText(url).then(text => ({ yrc: '', lyric: text }))
  },
  getTrc(url) {
    if (!url) return Promise.resolve('')
    return this.getText(url)
  },
  async getMusicInfo(songInfo) {
    return songInfo.mrcUrl == null
      ? getMusicInfo(songInfo.songmid || songInfo.copyrightId)
      : songInfo
  },
  getLyric(songInfo) {
    return {
      promise: this.getMusicInfo(songInfo).then(info => {
        let p
        if (info.mrcUrl) p = this.getMrc(info.mrcUrl)
        else if (info.lrcUrl) p = this.getLrc(info.lrcUrl)
        else if (info.lyricUrl) p = this.getLrc(info.lyricUrl)
        if (p == null) return Promise.reject(new Error('获取歌词失败'))
        return Promise.all([p, this.getTrc(info.trcUrl)]).then(([lrcInfo, tlyric]) => {
          lrcInfo.tlyric = tlyric
          return lrcInfo
        })
      }),
      cancelHttp() {},
    }
  },
}

export default {
  getLyric(songInfo) {
    let requestObj = mrcTools.getLyric(songInfo)
    return requestObj
  },
}
