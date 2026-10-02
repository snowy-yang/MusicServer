// 网易云个人歌单（上游 music-lib/netease/user_playlist.go 移植）
// 需登录 cookie MUSIC_U（sdk/auth/store.ts 的 getCredentials('wy').cookie / musicU）：
//   未登录抛出清晰错误，不返回空列表
//   1) weapi/nuser/account/get → 当前用户 userId
//   2) weapi/user/playlist    → 用户歌单列表（分页 limit/offset）
import { httpFetch } from '../request.ts'
import { weapi } from './utils/crypto.ts'
import { formatPlayCount } from '../index.ts'
import { getCredentials, getWyCookie } from '../auth/store.ts'
import type { WyCredentials } from '../auth/store.ts'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36'

const playlistLink = (id: string) => `https://music.163.com/#/playlist?id=${id}`

const readCookie = (): string => {
  const cred = getCredentials('wy') as WyCredentials | null
  const musicU = String(cred?.musicU ?? '').trim()
  if (musicU) return `MUSIC_U=${musicU}`
  return String(cred?.cookie ?? getWyCookie()).trim()
}

const weapiPost = async(url: string, data: object, cookie: string) => {
  const { statusCode, body } = await httpFetch(url, {
    method: 'post',
    headers: {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      origin: 'https://music.163.com',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    form: weapi(data),
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || !body || typeof body !== 'object') throw new Error('wy 个人歌单接口请求失败')
  return body
}

/**
 * 个人歌单列表（上游 GetUserPlaylists）
 * 未登录（无 cookie/MUSIC_U）时抛出清晰错误，不返回空列表
 */
export const getList = async(page = 1, limit = 30) => {
  const cookie = readCookie()
  if (!cookie) throw new Error('wy 个人歌单需要登录 cookie（MUSIC_U），请先登录网易云')

  const safePage = Math.max(1, Number(page) || 1)
  let safeLimit = Number(limit) || 30
  if (safeLimit <= 0) safeLimit = 30
  if (safeLimit > 100) safeLimit = 100

  const account = await weapiPost('https://music.163.com/weapi/nuser/account/get', { csrf_token: '' }, cookie)
  if (account.code !== 200 || !account?.profile?.userId) {
    throw new Error(`wy 登录态无效或已过期 (code ${account?.code ?? 'unknown'})`)
  }
  const uid = account.profile.userId
  const nickname = account.profile.nickname ?? ''

  const body = await weapiPost('https://music.163.com/weapi/user/playlist', {
    uid,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    includeVideo: true,
    csrf_token: '',
  }, cookie)
  if (body.code !== 200) throw new Error(`wy 个人歌单获取失败 (code ${body.code})`)

  const list = (body.playlist ?? []).map(item => {
    const id = String(item?.id ?? '').trim()
    if (!id) return null
    const trackCount = Number(item?.trackCount ?? 0) || 0
    const playCount = Number(item?.playCount ?? 0) || 0
    const creator = String(item?.creator?.nickname ?? '').trim() || nickname
    return {
      id,
      name: item?.name ?? '',
      cover: item?.coverImgUrl ?? '',
      trackCount,
      playCount,
      play_count: formatPlayCount(playCount),
      creator,
      description: item?.description ?? '',
      subscribed: Boolean(item?.subscribed),
      link: playlistLink(id),
      source: 'wy' as const,
    }
  }).filter(Boolean)

  return { list, page: safePage, limit: safeLimit, total: list.length, source: 'wy' as const }
}

export const getUserPlaylists = getList

export default { getList, getUserPlaylists }
