// 网络请求模块（替代原 lx-music 渲染器 src/renderer/utils/request.js）
// 接口与原版保持一致：
//   httpFetch(url, { method, headers, body, form, timeout, lookup, family })
//     → { promise, cancelHttp }
//   promise resolve → { statusCode, body, headers, raw }
//     - body：JSON 已解析对象，或原始字符串（HTML/文本）
//     - raw：响应体 Buffer
//   promise reject → 错误（timeout 请求超时 / canceled 主动取消）
// 注意：promise 与 cancelHttp 均为普通可赋值属性（SDK 多处会重写 promise）

import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { URL } from 'node:url'

const MAX_BUFFER_SIZE = 64 * 1024 * 1024 // 64MB

const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
}

const parseBody = (raw) => {
  if (!raw || !raw.length) return null
  const text = raw.toString('utf8')
  // 与原版一致：无论 content-type 都尝试 JSON 解析，失败则返回原始文本
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * 发起请求（返回带 promise 与 cancelHttp 的对象）
 */
const buildHttpPromise = (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase()
  const obj = {
    isCancelled: false,
    cancelHttp: () => {
      if (!obj.requestObj) {
        obj.isCancelled = true
        return
      }
      obj.requestObj.destroy(new Error('Canceled'))
      obj.requestObj = null
      obj.promise = obj.cancelHttp = null
      obj.cancelFn?.(new Error('Canceled'))
      obj.cancelFn = null
    },
  }
  obj.promise = new Promise((resolve, reject) => {
    obj.cancelFn = reject

    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (err) {
      reject(err)
      return
    }

    const isHttps = parsedUrl.protocol === 'https:'
    const client = isHttps ? https : http

    // 数据体构造：body（对象/字符串/Buffer）与 form（对象 → urlencoded）
    let body = null
    let isForm = false
    if (options.form) {
      const formBody = new URLSearchParams()
      for (const key of Object.keys(options.form)) {
        const value = options.form[key]
        if (value == null) continue
        formBody.append(key, typeof value === 'object' ? JSON.stringify(value) : value)
      }
      body = formBody.toString()
      isForm = true
    } else if (options.body) {
      body = typeof options.body === 'object' && !Buffer.isBuffer(options.body) ? JSON.stringify(options.body) : options.body
    }

    const headers = { ...defaultHeaders, ...(options.headers || {}) }
    if (body && !headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = isForm ? 'application/x-www-form-urlencoded' : 'application/json'
    }
    if (body) headers['content-length'] = Buffer.byteLength(body)

    const requestOptions = {
      method,
      headers,
      family: options.family || undefined,
    }
    if (options.lookup) requestOptions.lookup = options.lookup

    const req = client.request(parsedUrl, requestOptions, res => {
      obj.requestObj = null
      obj.cancelFn = null
      const statusCode = res.statusCode

      let stream = res
      switch (res.headers['content-encoding']) {
        case 'gzip': stream = res.pipe(zlib.createGunzip()); break
        case 'deflate': stream = res.pipe(zlib.createInflate()); break
        case 'br': stream = res.pipe(zlib.createBrotliDecompress()); break
      }

      const chunks = []
      let size = 0
      stream.on('data', chunk => {
        size += chunk.length
        if (size > MAX_BUFFER_SIZE) {
          stream.destroy(new Error('Response too large'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', err => reject(err))
      stream.on('end', () => {
        const raw = Buffer.concat(chunks)
        resolve({
          statusCode,
          headers: res.headers,
          body: parseBody(raw),
          raw,
        })
      })
    })

    obj.requestObj = req

    req.on('error', err => {
      if (obj.isCancelled || err.canceled) err.canceled = true
      reject(err)
    })

    if (options.timeout) {
      req.setTimeout(options.timeout, () => {
        const err = new Error('Request timeout')
        err.timeout = true
        req.destroy(err)
      })
    }

    if (body) req.write(body)
    req.end()
  })
  return obj
}

/**
 * 请求超时/断网错误统一处理（与原版行为一致）
 */
export const httpFetch = (url, options = { method: 'get' }) => {
  const requestObj = buildHttpPromise(url, options)
  requestObj.promise = requestObj.promise.catch(err => {
    if (err.canceled) return Promise.reject(err)
    switch (err.code) {
      case 'ETIMEDOUT':
      case 'ESOCKETTIMEDOUT':
        return Promise.reject(new Error(requestMsg.timeout))
      case 'ENOTFOUND':
        return Promise.reject(new Error(requestMsg.notConnectNetwork))
      case 'ECONNRESET':
        return Promise.reject(new Error(requestMsg.fail))
      default:
        return Promise.reject(err)
    }
  })
  return requestObj
}

import { requestMsg } from './message.js'

export default { httpFetch }
