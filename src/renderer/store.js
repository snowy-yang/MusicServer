// 替代原渲染器的 @renderer/store 模块（保留导入别名所需的接口形态）
// 服务器环境默认使用内置直连接口（apiSource.value === 'internal'），
// 设置 SOURCE_ENABLED 环境变量（任意非 0/false 值）即启用外部聚合音源。

const enabled = process.env.SOURCE_ENABLED

export const apiSource = {
  value: enabled && enabled !== '0' && enabled !== 'false' ? 'source' : 'internal',
}

export const userApi = {
  apis: {},
}

export default { apiSource, userApi }
