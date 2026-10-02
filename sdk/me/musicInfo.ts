// 猫耳FM 曲目信息（App API 通道）
// 接口: GET https://app.missevan.com/sound/sound?sound_id=
// 返回 info 直接是 sound 对象（非 web 版的 info.sound 包装）：
//   soundstr/duration(毫秒)/front_cover/soundurl(原文件)/soundurl_64(=原文件)/
//   soundurl_128/-192k 变体，均为 maoercdn.com 免签名明文直链
import { appApiGet } from './sign.ts'

export const getSoundInfo = async(soundId: string): Promise<any> => appApiGet('/sound/sound', `sound_id=${soundId}`)

export default { getSoundInfo }
