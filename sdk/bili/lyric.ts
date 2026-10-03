// Bilibili 歌词（上游 bilibili/lyric.go 即空实现：GetLyrics 对 bilibili 源恒返回空字符串）
// B 站视频没有公开歌词接口（cc_subtitle 需登录且绝大多数视频没有），上游未实现，此处保持一致：
// 返回统一结构 { lyric: '', tlyric: '' }，让 /lyric/bili 有响应而不是 404。
export const getLyric = (_songInfo?: any, ..._rest: any[]) => {
  const requestObj = {
    promise: Promise.resolve({ lyric: '', tlyric: '' }),
    cancelHttp() {},
  }
  return requestObj
}

export default { getLyric }
