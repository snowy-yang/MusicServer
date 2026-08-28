import crypto from 'crypto'
import dns from 'dns'
import { decodeName } from '../src/common/utils.js'

export const toMD5 = (str: string): string => crypto.createHash('md5').update(str).digest('hex')

interface CachedIp {
  address: string
  family: number
}

const ipMap = new Map<string, CachedIp | true>()

export const getHostIp = (hostname: string): CachedIp | undefined => {
  const result = ipMap.get(hostname)
  if (typeof result === 'object') return result
  if (result === true) return
  ipMap.set(hostname, true)
  dns.lookup(hostname, {
    // family: 4,
    all: false,
  }, (err, address, family) => {
    if (err) return console.log(err)
    ipMap.set(hostname, { address, family })
  })
}

export const dnsLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void => {
  const result = getHostIp(hostname)
  if (result) return callback(null, result.address, result.family)

  dns.lookup(hostname, options, callback as any)
}

/**
 * 格式化歌手
 * @param singers 歌手数组或字符串
 * @param nameKey 歌手名键值
 * @param join 歌手分割字符
 */
export const formatSingerName = (
  singers: Array<Record<string, unknown>> | string | null | undefined,
  nameKey = 'name',
  join = '、',
): string => {
  if (Array.isArray(singers)) {
    const singer: string[] = []
    singers.forEach(item => {
      const name = item[nameKey]
      if (!name) return
      singer.push(String(name))
    })
    return decodeName(singer.join(join))
  }
  return decodeName(String(singers ?? ''))
}
