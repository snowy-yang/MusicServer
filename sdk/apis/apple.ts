// Apple Music 取流（上游 apple.go GetDownloadURL）
// ⚠️ Apple 只提供 **preview 试听片段**（audio-ssl.itunes.apple.com，AAC/m4a，约 30-90 秒，实测单文件 ~3MB），
//    完整曲目是 FairPlay DRM 加密流（extendedAssetUrls.enhancedHls），需要 gamdl 等外部工具解密，
//    本 SDK 不提供。因此这里**任何请求档位都返回 type='preview'**，并在注释/响应里明确标注，不假装是无损完整曲。
//    歌曲的 previews[0].url 来自 catalog 歌曲详情（搜索结果缓存里的 previewUrl 也会直接复用，同上游 s.URL 逻辑）。
// 统一接口约定：apis('ap').getMusicUrl(songInfo, type) → { promise, cancelHttp }
//   promise resolve → { type:'preview', url, ext:'m4a', preview:true, songDuration, isrc }
//   （songDuration 是歌曲完整时长，试听片段本身约 30-90 秒）
//   type 请求参数不影响结果（只有 preview 一档）；supportQualitys 声明为 ['128k'] 以对齐
//   /sources 与 /url?quality 枚举，返回的实际档位以 type='preview' 为准。
import { appleAmpGetTracked, extractAppleID, getAppleConfig } from '../apple/util.ts'

export const supportQualitys = ['128k']

const isAudioURL = (value: any): boolean => /^https?:/i.test(String(value ?? ''))

/** 详情 → preview 结果（内部/测试用） */
export const previewFromAttributes = (attr: any) => {
  const url = String(attr?.previews?.[0]?.url ?? '')
  if (!url) {
    throw new Error('apple music: no preview URL available (完整曲目受 DRM 保护，SDK 仅提供 30-90 秒试听片段)')
  }
  return {
    type: 'preview',
    url,
    ext: 'm4a',
    preview: true,
    // 注意：这是歌曲完整时长（catalog durationInMillis），不是试听片段长度——试听片段约 30-90 秒
    songDuration: Math.round(Number(attr?.durationInMillis ?? 0) / 1000),
    isrc: attr?.isrc || '',
  }
}

/** 按 song id 拉取 preview（上游 GetDownloadURL → Parse） */
export const getPreviewUrl = async(songId: string, tracker?: { current: any }) => {
  const cfg = getAppleConfig()
  const body: any = await appleAmpGetTracked(
    `/v1/catalog/${cfg.storefront}/songs/${songId}`,
    { extend: 'extendedAssetUrls' },
    tracker,
  )
  const data = body?.data ?? []
  if (!data.length) throw new Error(`apple song not found: ${songId}`)
  return previewFromAttributes(data[0]?.attributes)
}

export const getMusicUrl = (songInfo: any, _type?: string) => {
  const requestObj: any = { promise: null as any, cancelHttp() {} }
  const tracker: { current: any } = { current: null }
  requestObj.cancelHttp = () => {
    try {
      tracker.current?.cancelHttp?.()
    } catch {
      // ignore
    }
    tracker.current = null
  }

  requestObj.promise = (async() => {
    // 上游 GetDownloadURL：Song.URL 已有直链时直接复用（搜索结果里的 previewUrl / 链接解析结果）
    if (isAudioURL(songInfo?.previewUrl)) return { type: 'preview', url: String(songInfo.previewUrl), ext: 'm4a', preview: true }
    if (isAudioURL(songInfo?.url)) return { type: 'preview', url: String(songInfo.url), ext: 'm4a', preview: true }

    const songId = extractAppleID(String(songInfo?.songmid ?? songInfo?.id ?? ''), 'song')
    if (!songId) throw new Error('apple 歌曲 id 无效（需要数字 song id 或 Apple Music 歌曲链接）')
    return getPreviewUrl(songId, tracker)
  })()

  return requestObj
}

export default { getMusicUrl, getPreviewUrl, previewFromAttributes, supportQualitys }
