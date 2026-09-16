// 渲染器 IPC 桥（替代 Electron ipcRenderer.invoke）
// 服务器环境下 IPC 调用直接映射到本地实现：
//   handle_kw_decode_lyric → 酷我歌词解码（见 lyricDecode.js）
//   handle_tx_decode_lyric → QQ音乐歌词解码（见 lyricDecode.js）

import { handleKwDecodeLyric, handleTxDecodeLyric } from './lyricDecode.js'

const localHandlers = {
  [WIN_MAIN_RENDERER_EVENT_NAME.handle_kw_decode_lyric]: handleKwDecodeLyric,
  [WIN_MAIN_RENDERER_EVENT_NAME.handle_tx_decode_lyric]: handleTxDecodeLyric,
}

/**
 * 调用主进程能力（本地直调）
 * @param {string} name 事件名
 * @param {*} params 参数
 */
export const rendererInvoke = async(name, params) => {
  const handler = localHandlers[name]
  if (!handler) throw new Error(`Unsupported invoke: ${name}`)
  return handler(params)
}

export const rendererSend = () => {}
export const rendererOn = () => {}
export const rendererOnce = () => {}
export const rendererOff = () => {}
export const rendererOffAll = () => {}
export const rendererSendSync = () => {}

import { WIN_MAIN_RENDERER_EVENT_NAME } from './ipcNames.js'

export default { rendererInvoke, rendererSend, rendererOn, rendererOnce, rendererOff, rendererOffAll, rendererSendSync }
