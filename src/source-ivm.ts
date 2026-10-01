// 外部聚合音源加载器（isolated-vm 硬隔离执行第三方脚本）
//
// 这是外部音源的唯一接入方式：在 isolated-vm 硬隔离沙箱中运行原始混淆脚本，
// 脚本的所有能力都经由本模块显式桥接的通道：
//   - http：默认只放行脚本头部 SERVER_SCRIPT_CONFIG.apiUrl 同源请求，其余一律阻止
//   - crypto / zlib / buffer：Node 侧实现，日志只记操作与长度，不记录密钥内容
//   - 定时器 / console：桥接到 Node，随 isolate 销毁回收
// 对外接口：getMusicUrl(songInfo, type) → { promise, cancelHttp }，与其它平台适配器一致。
// 脚本升版时只需替换 sources/ 目录下的脚本文件，无需改代码。
//
// 安全模型：
//   - isolate 内存上限（memoryLimit），无 process/require/fs/网络直连能力
//   - HTTP 出站默认拒绝（deny-all），白名单来自脚本自身声明的 apiUrl，可被 options 收紧或放宽
//   - 每个音源 API 调用（on/send/request/utils/dispatch）都有日志，请求含耗时与状态
//
// 依赖：isolated-vm（未安装时工厂函数抛出明确错误）
// 用法：
//   import { createIvmSource } from './source-ivm.ts'
//   const source = await createIvmSource({ scriptPath })      // scriptPath 必填（sources/ 扫描逻辑见 source.ts）
//   const source = await createIvmSource({ scriptPath, http }) // http 可注入 mock 做离线测试
//   await source.kw.getMusicUrl({ songmid: '123' }, '320k').promise
//   await source.destroy()
//
// 已知边界（相对桌面端 preload 的差异）：
//   - source.request 回调的 resp 不含 raw/bytes（Buffer 无法跨隔离边界，实测脚本未使用）
//   - formData 选项不支持（httpFetch 不支持 multipart）
//   - updateAlert 事件仅记录到日志，不弹窗

import fs from 'node:fs'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { httpFetch } from '../sdk/common/request.ts'

// 从脚本头部的 SERVER_SCRIPT_CONFIG 提取 apiUrl 声明，作为 HTTP 白名单缺省值。
// 兼容裸键(apiUrl:)与 JSON 风格("apiUrl":)，并处理 \/ 转义
const extractAllowedOrigins = (script) => {
  const origins: string[] = []
  const re = /["']?apiUrl["']?\s*:\s*["'`]([^"'`\s]+)["'`]/g
  let m
  while ((m = re.exec(script))) {
    try { origins.push(new URL(m[1].replace(/\\\//g, '/')).origin) } catch {}
  }
  return origins
}

const brief = (v, max = 72) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s
}

// 从脚本头部注释解析 @name/@version 等（对齐音源脚本 currentScriptInfo）
const parseScriptInfo = (script, scriptPath) => {
  const head = script.slice(0, 2000)
  const pick = (key) => {
    const m = new RegExp(`@${key}\\s+(.+)`).exec(head)
    return m ? m[1].trim() : ''
  }
  return {
    name: pick('name') || '未命名音源',
    description: pick('description'),
    version: pick('version') || '0',
    author: pick('author'),
    homepage: pick('homepage'),
    rawScript: script,
    path: scriptPath,
  }
}

// 注入隔离环境的胶水层：提供音源脚本 API（globalThis.lx 为脚本契约名）、定时器、console、Bytes 包装。
// 与 Node 的数据交换一律走 JSON 字符串 / hex 字符串，避免跨隔离传输复杂对象。
const GLUE = `
'use strict'
var __currentDispatch = 0
var __pendingZlib = {}
var __timers = {}

// ---- Bytes 轻量包装（对齐 Buffer 的最小用法面）----
function __utf8Encode(str) {
  var out = []
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++ }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}
function __utf8Decode(bytes) {
  var out = ''
  for (var i = 0; i < bytes.length;) {
    var b = bytes[i], cp
    if (b < 0x80) { cp = b; i += 1 }
    else if (b < 0xE0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2 }
    else if (b < 0xF0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3 }
    else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4 }
    if (cp > 0xFFFF) { cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)) }
    else out += String.fromCharCode(cp)
  }
  return out
}
function __bytesToBase64(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = ''
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2]
    out += chars[b0 >> 2]
    out += chars[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)]
    out += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)]
    out += b2 === undefined ? '=' : chars[b2 & 63]
  }
  return out
}
function __base64ToBytes(b64) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = []
  b64 = String(b64).replace(/[^A-Za-z0-9+/]/g, '')
  for (var i = 0; i < b64.length; i += 4) {
    var n = (chars.indexOf(b64[i]) << 18) | (chars.indexOf(b64[i + 1]) << 12) |
            ((chars.indexOf(b64[i + 2]) & 63) << 6) | (chars.indexOf(b64[i + 3]) & 63)
    out.push((n >> 16) & 255)
    if (b64[i + 2] && b64[i + 2] !== '=') out.push((n >> 8) & 255)
    if (b64[i + 3] && b64[i + 3] !== '=') out.push(n & 255)
  }
  return out
}
function __hexToBytes(hex) {
  var out = []
  for (var i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16))
  return out
}
function __bytesToHex(bytes) {
  var out = ''
  for (var i = 0; i < bytes.length; i++) out += ((bytes[i] & 255) < 16 ? '0' : '') + (bytes[i] & 255).toString(16)
  return out
}
globalThis.__Bytes = function (bytes) { this._b = bytes }
globalThis.__Bytes.prototype.length = 0
Object.defineProperty(globalThis.__Bytes.prototype, 'length', {
  get: function () { return this._b.length },
})
globalThis.__Bytes.prototype.toString = function (enc) {
  enc = String(enc || 'utf8').toLowerCase()
  if (enc === 'hex') return __bytesToHex(this._b)
  if (enc === 'base64') return __bytesToBase64(this._b)
  if (enc === 'binary' || enc === 'latin1') {
    var s = ''
    for (var i = 0; i < this._b.length; i++) s += String.fromCharCode(this._b[i] & 255)
    return s
  }
  return __utf8Decode(this._b)
}
globalThis.__Bytes.prototype.slice = function (start, end) {
  return new __Bytes(this._b.slice(start || 0, end === undefined || end === null ? undefined : end))
}
globalThis.__Bytes.prototype.toJSON = function () { return this.toString('utf8') }

function __toHex(data) {
  if (data instanceof __Bytes) return data.toString('hex')
  if (typeof data === 'string') return __bytesToHex(__utf8Encode(data))
  if (data && typeof data.length === 'number') {
    var out = ''
    for (var i = 0; i < data.length; i++) out += ((data[i] & 255) < 16 ? '0' : '') + (data[i] & 255).toString(16)
    return out
  }
  return ''
}
function __fromAny(data, enc) {
  if (data instanceof __Bytes) return new __Bytes(data._b.slice())
  if (typeof data === 'string') {
    enc = String(enc || 'utf8').toLowerCase()
    if (enc === 'hex') return new __Bytes(__hexToBytes(data))
    if (enc === 'base64') return new __Bytes(__base64ToBytes(data))
    if (enc === 'binary' || enc === 'latin1') {
      var out = []
      for (var i = 0; i < data.length; i++) out.push(data.charCodeAt(i) & 255)
      return new __Bytes(out)
    }
    return new __Bytes(__utf8Encode(data))
  }
  return new __Bytes(Array.prototype.slice.call(data || []))
}

// ---- console / 定时器桥接 ----
globalThis.console = {
  log: function () { __log('[source] ' + Array.prototype.map.call(arguments, String).join(' ')) },
  info: function () { __log('[source] ' + Array.prototype.map.call(arguments, String).join(' ')) },
  warn: function () { __log('[source] ' + Array.prototype.map.call(arguments, String).join(' ')) },
  error: function () { __log('[source] ' + Array.prototype.map.call(arguments, String).join(' ')) },
  debug: function () {},
}
globalThis.setTimeout = function (fn, ms) {
  var id = __newTimer(fn, Array.prototype.slice.call(arguments, 2), false)
  __startTimer(id, Number(ms) || 0, false)
  return id
}
globalThis.clearTimeout = function (id) { __clearTimer(id) }
globalThis.setInterval = function (fn, ms) {
  var id = __newTimer(fn, [], true)
  __startTimer(id, Number(ms) || 1, true)
  return id
}
globalThis.clearInterval = function (id) { __clearTimer(id) }
function __newTimer(fn, args, interval) {
  var id = Date.now() % 100000000 + Math.floor(Math.random() * 100000000)
  __timers[id] = { fn: fn, args: args, interval: interval }
  return id
}
function __clearTimer(id) {
  if (__timers[id]) { delete __timers[id]; __stopTimer(id) }
}
globalThis.__fireTimer = function (id) {
  var t = __timers[id]
  if (!t) return
  if (!t.interval) delete __timers[id]
  try { t.fn.apply(undefined, t.args) } catch (e) { __log('timer error: ' + (e && e.message)) }
}

// ---- 音源脚本 preload API ----
// 注意：globalThis.lx 是第三方脚本依赖的 API 契约名（脚本内部调用 lx.on/source.request 等），
// 属于对外兼容接口而非命名残留，不可改动，否则脚本初始化直接失败。
var __EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
var __handlers = {}
globalThis.lx = {
  EVENT_NAMES: __EVENT_NAMES,
  version: '2.0.0',
  env: 'desktop',
  currentScriptInfo: __scriptInfo,
  on: function (name, handler) {
    if (name !== __EVENT_NAMES.request) return Promise.reject(new Error('The event is not supported: ' + name))
    __handlers[name] = handler
    __on(String(name))
    return Promise.resolve()
  },
  send: function (name, data) {
    if (name !== __EVENT_NAMES.inited && name !== __EVENT_NAMES.updateAlert) {
      return Promise.reject(new Error('The event is not supported: ' + name))
    }
    var err = __send(String(name), JSON.stringify(data === undefined ? null : data))
    return err ? Promise.reject(new Error(err)) : Promise.resolve()
  },
  request: function (url, options, callback) { return __sourceRequest(url, options, callback, __currentDispatch) },
  utils: {
    crypto: {
      md5: function (str) { return __md5(str) },
      randomBytes: function (size) { return new __Bytes(__hexToBytes(__randomBytesHex(size))) },
      aesEncrypt: function (buffer, mode, key, iv) {
        return new __Bytes(__hexToBytes(__aesEncryptHex(__toHex(buffer), String(mode), __toHex(key), __toHex(iv))))
      },
      rsaEncrypt: function (buffer, key) {
        return new __Bytes(__hexToBytes(__rsaEncryptHex(__toHex(buffer), String(key))))
      },
    },
    buffer: {
      from: function (data, enc) {
        __log('source.utils.buffer.from(' + (data instanceof __Bytes ? 'Bytes(' + data.length + ')' : typeof data + (data && data.length !== undefined ? '[' + data.length + ']' : '')) + (enc ? ',' + enc : '') + ')')
        return __fromAny(data, enc)
      },
      bufToString: function (buf, format) {
        __log('source.utils.buffer.bufToString(' + (buf && buf.length !== undefined ? buf.length + 'B' : typeof buf) + ',' + (format || 'utf8') + ')')
        return buf.toString(format || 'utf8')
      },
    },
    zlib: {
      inflate: function (buf) { return __zlibAsync('inflate', buf) },
      deflate: function (data) { return __zlibAsync('deflate', data) },
    },
  },
}
// 隔离环境内不依赖 ivm 全局：回调统一走「隔离内注册表 + 自增 id」，
// Node 侧通过 jail.get 拿到 __completeHttp 等入口反调
function __sourceRequest(url, options, callback, dispatchId) {
  options = options || {}
  var payload = {
    method: options.method || 'get',
    timeout: options.timeout,
    headers: options.headers || null,
    body: options.body === undefined || options.body === null ? null :
      (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)),
    form: options.form ? JSON.stringify(options.form) : null,
  }
  var cbId = ++__seq
  __pendingCbs[cbId] = callback
  var reqId = __http(dispatchId | 0, String(url), JSON.stringify(payload), cbId)
  return function () { __cancelHttp(reqId) }
}
var __pendingCbs = {}
globalThis.__completeHttp = function (cbId, errMsg, respJson, bodyJson) {
  var cb = __pendingCbs[cbId]
  if (!cb) return
  delete __pendingCbs[cbId]
  try {
    if (errMsg) cb.call(lx, new Error(errMsg), null, null)
    else cb.call(lx, null, respJson === null ? null : JSON.parse(respJson), bodyJson === null ? null : JSON.parse(bodyJson))
  } catch (e) { __log('request callback error: ' + (e && e.message)) }
}
function __zlibAsync(op, data) {
  return new Promise(function (resolve, reject) {
    var opId = ++__seqCounter()
    __pendingZlib[opId] = { resolve: resolve, reject: reject }
    __zlib(opId, op, __toHex(data))
  })
}
var __seq = 0
function __seqCounter() { return ++__seq }
globalThis.__zlibDone = function (opId, errMsg, valHex) {
  var p = __pendingZlib[opId]
  if (!p) return
  delete __pendingZlib[opId]
  if (errMsg) p.reject(new Error(errMsg))
  else p.resolve(new __Bytes(__hexToBytes(valHex)))
}

// ---- 请求分发（Node 侧调用）----
// 注意：本函数必须不返回值（结果经 __dispatchResult 回传），
// 否则 apply 会尝试克隆隔离内 Promise 而报 "could not be cloned"
globalThis.__dispatch = function (dispatchId, payloadJson) {
  var payload = JSON.parse(payloadJson)
  __currentDispatch = dispatchId | 0
  var p
  try {
    var handler = __handlers[__EVENT_NAMES.request]
    if (!handler) p = Promise.reject(new Error('request handler 未注册'))
    else p = Promise.resolve().then(function () { return handler(payload) })
  } catch (e) {
    p = Promise.reject(e)
  }
  __currentDispatch = 0
  p.then(function (result) {
    if (payload.action === 'musicUrl') return JSON.stringify({ ok: true, url: result === undefined ? null : String(result) })
    return JSON.stringify({ ok: true, data: result === undefined ? null : result })
  }, function (err) {
    return JSON.stringify({ ok: false, message: err && err.message ? String(err.message) : String(err) })
  }).then(function (resultJson) {
    __dispatchResult(dispatchId | 0, resultJson)
  }, function (err) {
    __dispatchResult(dispatchId | 0, JSON.stringify({ ok: false, message: String(err && err.message || err) }))
  })
}
`

/**
 * 创建隔离执行的外部音源
 * @param {object} [options]
 * @param {string} options.scriptPath 音源脚本路径（必填，sources/ 目录扫描逻辑见 source.js）
 * @param {Function} [options.http] http 实现，默认项目统一 httpFetch；测试可注入 mock
 * @param {number} [options.memoryLimit] 隔离内存上限 MB，默认 256
 * @param {number} [options.initTimeout] 等待脚本上报 inited 的超时 ms，默认 10000
 * @param {number} [options.requestTimeout] 单次取流超时 ms，默认 15000
 * @param {boolean|Function} [options.log] 日志开关；true(默认)输出到 console，可传自定义 (msg)=>void，false 关闭
 * @param {string[]} [options.allowedOrigins] HTTP 白名单 origin；缺省取脚本 SERVER_SCRIPT_CONFIG.apiUrl 同源
 * @param {Function} [options.httpFilter] 自定义放行判定 (url) => boolean；提供时优先于 origin 白名单
 * @param {boolean} [options.allowAllHttp] 放行全部 http 请求（调试用，默认 false）
 * @returns {{ env: string, scriptInfo: object, inited: object|null, apis: object, allowedOrigins: string[], destroy: Function }}
 */
export const createIvmSource = async({
  scriptPath,
  http: httpImpl = httpFetch,
  memoryLimit = 256,
  initTimeout = 10000,
  requestTimeout = 15000,
  log: logOption = true,
  allowedOrigins,
  httpFilter,
  allowAllHttp = false,
}: Record<string, any> = {}) => {
  let ivm
  try {
    ivm = (await import('isolated-vm')).default
  } catch {
    throw new Error('未安装 isolated-vm，无法启用隔离执行音源：pnpm add isolated-vm')
  }
  if (!scriptPath) throw new Error('缺少音源脚本路径 scriptPath（sources/ 目录扫描逻辑见 source.js）')

  const script = fs.readFileSync(scriptPath, 'utf8')
  const scriptInfo = parseScriptInfo(script, scriptPath)

  // ---- 日志与 HTTP 白名单 ----
  const log = typeof logOption === 'function'
    ? logOption
    : logOption === false
      ? () => {}
      : (msg) => console.log('[source-ivm]', msg)
  const scriptOrigins = extractAllowedOrigins(script)
  const origins = (allowedOrigins ?? scriptOrigins).map(o => String(o).replace(/\/+$/, ''))
  const httpAllowed = (urlStr) => {
    if (allowAllHttp) return true
    if (httpFilter) return !!httpFilter(urlStr)
    try { return origins.includes(new URL(urlStr).origin) } catch { return false }
  }
  log(`加载脚本 ${scriptPath}（http 白名单: ${origins.join(', ') || '(空, 全部阻止)'}${allowAllHttp ? ' + allowAllHttp' : ''}${httpFilter ? ' + httpFilter' : ''}）`)

  const isolate = new ivm.Isolate({ memoryLimit })
  // afterEvaluate：每次外部调用返回后推进隔离内的微任务队列，否则脚本内的 Promise 链永远不会执行
  const context = await isolate.createContext({ microtaskMode: 'afterEvaluate' })
  const jail = context.global

  // ---- Node 侧状态 ----
  const state: Record<string, any> = {
    inited: null,
    updateAlerts: [],
    onRegistered: null,
    initWaiters: [],
  }
  const pendingDispatch = new Map() // dispatchId -> { resolve, reject }
  const httpRequests = new Map() // reqId -> requestObj
  const dispatchHttp = new Map() // dispatchId -> Set<requestObj>
  const nodeTimers = new Map() // timerId -> timeout对象
  let httpSeq = 0
  let dispatchSeq = 0
  let disposed = false

  const forgetHttp = (reqId, dispatchId, requestObj) => {
    httpRequests.delete(reqId)
    const set = dispatchHttp.get(dispatchId)
    if (set) { set.delete(requestObj); if (!set.size) dispatchHttp.delete(dispatchId) }
  }

  // jail.get 拿到的是 ivm.Function：apply 为同步调用（async 选项无效），
  // 隔离内异步结果一律经回调（__dispatchResult/__completeHttp 等）传回
  const safeApply = (fnRef, args) => {
    if (disposed) return
    try {
      fnRef.apply(undefined, args)
    } catch (err) {
      log(`isolate 调用失败: ${(err as any)?.message}`)
    }
  }

  // ---- 桥接回调（Node ← isolate）----
  await jail.set('__log', new ivm.Callback((msg) => log(String(msg))))
  await jail.set('__on', new ivm.Callback((name) => {
    state.onRegistered = name
    log(`source.on(${String(name)})`)
  }))
  await jail.set('__send', new ivm.Callback((name, dataJson) => {
    let data = null
    try { data = JSON.parse(dataJson) } catch {}
    log(`source.send(${String(name)}) ${brief(dataJson ?? '')}`)
    if (name === 'inited') {
      state.inited = data
      const waiters = state.initWaiters.splice(0)
      waiters.forEach(w => w.resolve(data))
    } else if (name === 'updateAlert') {
      state.updateAlerts.push(data)
    }
    return '' // 非空字符串会以异常形式抛回 isolate
  }))
  await jail.set('__dispatchResult', new ivm.Callback((dispatchId, resultJson) => {
    const p = pendingDispatch.get(dispatchId)
    if (!p) return
    pendingDispatch.delete(dispatchId)
    let parsed
    try { parsed = JSON.parse(resultJson) } catch (err) { p.reject(err); return }
    if (parsed.ok) p.resolve(parsed)
    else p.reject(new Error(parsed.message || '获取失败'))
  }))
  await jail.set('__md5', new ivm.Callback((str) => {
    log(`source.utils.crypto.md5(${brief(str)})`)
    return crypto.createHash('md5').update(String(str)).digest('hex')
  }))
  await jail.set('__randomBytesHex', new ivm.Callback((size) => {
    log(`source.utils.crypto.randomBytes(${size})`)
    return crypto.randomBytes(size).toString('hex')
  }))
  await jail.set('__aesEncryptHex', new ivm.Callback((hexBuf, mode, hexKey, hexIv) => {
    log(`source.utils.crypto.aesEncrypt(${Buffer.from(hexBuf, 'hex').length}B, ${mode})`)
    const cipher = crypto.createCipheriv(mode, Buffer.from(hexKey, 'hex'), Buffer.from(hexIv, 'hex'))
    return Buffer.concat([cipher.update(Buffer.from(hexBuf, 'hex')), cipher.final()]).toString('hex')
  }))
  await jail.set('__rsaEncryptHex', new ivm.Callback((hexBuf, pemKey) => {
    log(`source.utils.crypto.rsaEncrypt(${Buffer.from(hexBuf, 'hex').length}B, key=${brief(pemKey, 24)})`)
    let buf = Buffer.from(hexBuf, 'hex')
    buf = Buffer.concat([Buffer.alloc(128 - buf.length), buf])
    return crypto.publicEncrypt({ key: pemKey, padding: crypto.constants.RSA_NO_PADDING }, buf).toString('hex')
  }))
  await jail.set('__zlib', new ivm.Callback((opId, op, hex) => {
    log(`source.utils.zlib.${op}(${Buffer.from(hex, 'hex').length}B)`)
    const buf = Buffer.from(hex, 'hex')
    zlib[op](buf, (err, out) => {
      safeApply(zlibDoneRef, [opId, err ? String(err.message) : null, err ? '' : out.toString('hex')])
    })
  }))
  await jail.set('__http', new ivm.Callback((dispatchId, url, optionsJson, cbId) => {
    const reqId = ++httpSeq
    const opts = JSON.parse(optionsJson)
    const method = String(opts.method || 'get').toUpperCase()
    if (!httpAllowed(url)) {
      log(`✋ source.request ${method} ${url} → 已阻止（不在白名单）`)
      safeApply(completeHttpRef, [cbId, `http blocked by allowlist: ${url}`, null, null])
      return reqId
    }
    log(`→ source.request ${method} ${brief(url, 120)}`)
    const startedAt = Date.now()
    const options: Record<string, any> = {
      method: opts.method || 'get',
      timeout: typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 15000,
    }
    if (opts.headers) options.headers = opts.headers
    if (opts.body) options.body = opts.body
    if (opts.form) options.form = JSON.parse(opts.form)
    const requestObj = httpImpl(String(url), options)
    httpRequests.set(reqId, requestObj)
    if (!dispatchHttp.has(dispatchId)) dispatchHttp.set(dispatchId, new Set())
    dispatchHttp.get(dispatchId).add(requestObj)
    requestObj.promise.then(({ statusCode, statusMessage, headers, body }) => {
      log(`← source.request ${method} ${brief(url, 80)} → ${statusCode}（${Date.now() - startedAt}ms）`)
      forgetHttp(reqId, dispatchId, requestObj)
      const resp = { statusCode, statusMessage: statusMessage || '', headers: headers || {}, body }
      return safeApply(completeHttpRef, [cbId, null, JSON.stringify(resp), JSON.stringify(body === undefined ? null : body)])
    }).catch(err => {
      log(`← source.request ${method} ${brief(url, 80)} → 失败（${Date.now() - startedAt}ms）${err?.message ? ' ' + err.message : ''}`)
      forgetHttp(reqId, dispatchId, requestObj)
      return safeApply(completeHttpRef, [cbId, String(err && err.message || err), null, null])
    })
    return reqId
  }))
  await jail.set('__cancelHttp', new ivm.Callback((reqId) => {
    const requestObj = httpRequests.get(reqId)
    if (requestObj) requestObj.cancelHttp()
  }))
  await jail.set('__startTimer', new ivm.Callback((id, ms, interval) => {
    const timerRef = interval
      ? setInterval(() => safeApply(fireTimerRef, [id]), Math.max(1, ms))
      : setTimeout(() => safeApply(fireTimerRef, [id]), Math.max(0, ms))
    if (interval && typeof timerRef.unref === 'function') timerRef.unref()
    nodeTimers.set(id, timerRef)
  }))
  await jail.set('__stopTimer', new ivm.Callback((id) => {
    const t = nodeTimers.get(id)
    if (t) { clearTimeout(t); clearInterval(t); nodeTimers.delete(id) }
  }))

  // ---- 注入胶水层与脚本元信息，再加载目标脚本 ----
  await jail.set('__scriptInfo', new ivm.ExternalCopy(scriptInfo).copyInto())
  await jail.set('SCRIPT_MD5', crypto.createHash('md5').update(script).digest('hex'))
  await context.eval(GLUE)
  const fireTimerRef = await jail.get('__fireTimer')
  const zlibDoneRef = await jail.get('__zlibDone')
  const completeHttpRef = await jail.get('__completeHttp')
  const dispatchRef = await jail.get('__dispatch')
  await context.eval(script, { async: true, timeout: 15000 })

  // ---- 对外 dispatch ----
  const dispatch = (payload: any): { id: number; promise: Promise<any> } => {
    if (disposed) return Promise.reject(new Error('isolate 已销毁')) as any
    const id = ++dispatchSeq
    return {
      id,
      promise: new Promise((resolve, reject) => {
        pendingDispatch.set(id, { resolve, reject })
        try {
          dispatchRef.apply(undefined, [id, JSON.stringify(payload)])
        } catch (err) {
          if (pendingDispatch.delete(id)) reject(err)
        }
      }),
    }
  }

  const getMusicUrlFor = (source) => (songInfo, type) => {
    const requestObj = { cancelHttp() {}, promise: null as any }
    const id = songInfo?.hash || songInfo?.songmid || '?'
    const dispatched = dispatch({ source, action: 'musicUrl', info: { type, musicInfo: songInfo } })
    const startedAt = Date.now()
    log(`▶ getMusicUrl ${source}/${type} id=${id}（dispatch #${dispatched.id}）`)
    requestObj.cancelHttp = () => {
      const set = dispatchHttp.get(dispatched.id)
      if (set) [...set].forEach(r => r.cancelHttp())
    }
    requestObj.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requestObj.cancelHttp()
        pendingDispatch.delete(dispatched.id)
        reject(new Error(`请求超时 (${requestTimeout}ms)`))
      }, requestTimeout)
      timer.unref?.()
      dispatched.promise.then(result => {
        clearTimeout(timer)
        log(`✔ getMusicUrl ${source}/${type} 完成（${Date.now() - startedAt}ms）`)
        if (!result.url) reject(new Error('响应无播放地址'))
        else resolve({ type, url: result.url })
      }, err => {
        clearTimeout(timer)
        log(`✖ getMusicUrl ${source}/${type} 失败（${Date.now() - startedAt}ms）${err?.message || ''}`)
        reject(err)
      })
    })
    return requestObj
  }

  // ---- 等待脚本 inited ----
  const inited = await new Promise<any>((resolve, reject) => {
    if (state.inited) return resolve(state.inited)
    const waiter = { resolve, reject }
    state.initWaiters.push(waiter)
    const t = setTimeout(() => {
      const i = state.initWaiters.indexOf(waiter)
      if (i >= 0) state.initWaiters.splice(i, 1)
      reject(new Error(`脚本 ${initTimeout}ms 内未上报 inited（handler 注册: ${state.onRegistered || '无'}）`))
    }, initTimeout)
    t.unref?.()
  }).catch(async err => {
    await destroy()
    throw err
  })

  // 按脚本上报的 sources 生成分平台接口（过滤 local 这类服务器侧无意义条目仍保留键，但 local 无 qualitys）
  const reportedSources = inited?.sources && typeof inited.sources === 'object' ? Object.keys(inited.sources) : []
  const sources = reportedSources.length ? reportedSources : ['kw', 'kg', 'tx', 'wy']
  const apis = {}
  for (const s of sources) apis[s] = { getMusicUrl: getMusicUrlFor(s) }

  function destroy() {
    if (disposed) return Promise.resolve()
    disposed = true
    for (const t of nodeTimers.values()) { clearTimeout(t); clearInterval(t) }
    nodeTimers.clear()
    for (const r of httpRequests.values()) { try { r.cancelHttp() } catch {} }
    httpRequests.clear()
    dispatchHttp.clear()
    for (const p of pendingDispatch.values()) p.reject(new Error('isolate 已销毁'))
    pendingDispatch.clear()
    for (const w of state.initWaiters.splice(0)) w.reject(new Error('isolate 已销毁'))
    try { isolate.dispose() } catch {}
    return Promise.resolve()
  }

  return {
    env: 'isolated-vm',
    scriptInfo: { name: scriptInfo.name, version: scriptInfo.version, author: scriptInfo.author, path: scriptPath },
    inited,
    apis,
    allowedOrigins: origins,
    ...apis,
    destroy,
  }
}

export default { createIvmSource }
