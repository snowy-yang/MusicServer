// 替代原 lx-music 渲染器的 @renderer/store
// 服务器环境默认使用内置直连接口（apiSource.value === 'internal'），
// 设置 LX_SOURCE_ENABLED=true 可切换至 lx-music-source-v5 聚合源。

export const apiSource = {
  value: process.env.LX_SOURCE_ENABLED === 'true' ? 'v5' : 'internal',
}

export const userApi = {
  apis: {},
}

export default { apiSource, userApi }
