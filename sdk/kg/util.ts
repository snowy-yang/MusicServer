import { toMD5 } from '../utils.ts'
import { httpFetch } from '../common/request.ts'
import type { HttpOptions } from '../types.ts'

// s.content[0].lyricContent.forEach(([str]) => {
// })

/**
 * 签名
 * @param {*} params
 * @param {*} apiver
 */
export const signatureParams = (params: string, platform = 'android', body = ''): string => {
  let keyparam = 'OIlwieks28dk2k092lksi2UIkp'
  if (platform === 'web') keyparam = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
  let param_list = params.split('&')
  param_list.sort()
  let sign_params = `${keyparam}${param_list.join('')}${body}${keyparam}`
  return toMD5(sign_params)
}

/**
 * 创建一个适用于KG的Http请求
 * @param {*} url
 * @param {*} options
 * @param {*} retryNum
 */
export const createHttpFetch = async(url: string, options?: HttpOptions, retryNum = 0): Promise<any> => {
  if (retryNum > 2) throw new Error('try max num')
  let result
  try {
    result = await httpFetch(url, options).promise
  } catch (err) {
    console.warn(`[kg] 请求失败将重试(${retryNum + 1}/3) ${url}: ${(err as Error).message}`)
    return createHttpFetch(url, options, ++retryNum)
  }
  if (result.statusCode !== 200 ||
    (
      result.body.error_code ??
      result.body.errcode ??
      result.body.err_code) != 0
  ) return createHttpFetch(url, options, ++retryNum)
  if (result.body.data) return result.body.data
  if (Array.isArray(result.body.info)) return result.body
  return result.body.info
}
