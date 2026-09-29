// 登录路由 —— wy 扫码/手机号登录，kg token 绑定，凭据持久化于 data/auth.json
// 注意：成功响应返回裸数据对象，全局 preSerialization 钩子会统一包成 { code: 0, data }

import * as wyAuth from '../sdk/auth/wy.ts'
import * as kgAuth from '../sdk/auth/kg.ts'
import { clearCredentials, getCredentials, getTxAuth, setCredentials } from '../sdk/auth/store.ts'
import { refreshAll } from './refresh.ts'

const fail = (reply, err) => {
  const status = err.status ?? 502
  return reply.code(status).send({ code: status, msg: err.message })
}

/**
 * 注册登录相关路由
 * @param {import('fastify').FastifyInstance} fastify
 */
export const loginRoutes = async(fastify) => {
  // ---------- 网易云 ----------

  fastify.post('/login/wy/qr', {
    schema: {
      summary: '获取网易云扫码登录二维码',
      description: '用网易云 App 扫码后轮询 /login/wy/qr/check 完成登录。返回 qrimg（data URL）可直接展示。',
      tags: ['登录'],
    },
  }, async() => wyAuth.qrKey())

  fastify.post('/login/wy/qr/check', {
    schema: {
      summary: '轮询网易云扫码状态',
      description: 'code：800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（自动保存凭据并返回账号资料）。',
      tags: ['登录'],
      body: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  }, async(request, reply) => {
    try {
      return await wyAuth.qrCheck(request.body.key)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/wy/cellphone', {
    schema: {
      summary: '网易云手机号登录',
      description: 'password（明文，服务端 MD5 后提交）与 captcha（短信验证码）二选一。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          phone: { type: 'string' },
          password: { type: 'string' },
          captcha: { type: 'string' },
          countrycode: { type: 'string', default: '86' },
        },
        required: ['phone'],
      },
    },
  }, async(request, reply) => {
    try {
      return await wyAuth.cellphoneLogin(request.body)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.delete('/login/wy', {
    schema: { summary: '退出网易云登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('wy')
    return { logged: false }
  })

  // ---------- 酷狗 ----------

  fastify.post('/login/kg', {
    schema: {
      summary: '绑定酷狗 token',
      description: 'token 从酷狗 App 抓包获取（login.token），服务端向用户中心验证后存储。手机号/扫码登录暂未实现。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          userid: { type: ['integer', 'string'] },
        },
        required: ['token', 'userid'],
      },
    },
  }, async(request, reply) => {
    try {
      return await kgAuth.loginByToken(request.body)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.delete('/login/kg', {
    schema: { summary: '退出酷狗登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('kg')
    return { logged: false }
  })

  // ---------- QQ音乐 ----------

  fastify.post('/login/tx', {
    schema: {
      summary: '绑定 QQ 音乐 cookie',
      description: 'cookie 从已登录的 y.qq.com 浏览器请求头复制（需含 uin 与 qm_keyst 字段），用于解锁 tx 取流的 320k/无损音质。' +
        '可选提供 App 抓包的 openId/accessToken/refreshToken/refreshKey，供定时任务自动续期登录态。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          cookie: { type: 'string' },
          openId: { type: 'string' },
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          refreshKey: { type: 'string' },
        },
        required: ['cookie'],
      },
    },
  }, async(request, reply) => {
    const cookie = request.body.cookie
    const uin = cookie.match(/uin=(\d+)/)?.[1]
    if (!uin || !/qm_keyst=\S+/.test(cookie)) {
      return reply.code(422).send({ code: 422, msg: 'cookie 需包含 uin 与 qm_keyst 字段' })
    }
    const { openId, accessToken, refreshToken, refreshKey } = request.body
    setCredentials('tx', { cookie, uin, openId, accessToken, refreshToken, refreshKey })
    return { logged: true, uin }
  })

  fastify.delete('/login/tx', {
    schema: { summary: '退出 QQ 音乐登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('tx')
    return { logged: false }
  })

  // ---------- 通用 ----------

  fastify.post('/login/refresh', {
    schema: {
      summary: '手动触发登录态续期',
      description: '对已登录的 kg/tx 执行 token/cookie 续期（与自动任务同一逻辑）。' +
        '未登录的平台跳过；失败的平台在对应字段返回 error，不影响其他平台。',
      tags: ['登录'],
    },
  }, async() => refreshAll())

  fastify.get('/login/status', {
    schema: {
      summary: '查看登录状态',
      description: 'wy 为实时校验（未登录或 cookie 失效返回 logged: false），kg/tx 为已存凭据（含 VIP 等级与最近更新时间）。',
      tags: ['登录'],
    },
  }, async() => {
    const [wy, kg] = await Promise.all([wyAuth.status().catch(() => null), Promise.resolve(kgAuth.status())])
    const tx = getTxAuth()
    const txCred = getCredentials('tx') as { vipType?: string; updatedAt?: string } | null
    const kgCred = getCredentials('kg') as { updatedAt?: string } | null
    return {
      wy: wy ? { logged: true, ...wy } : { logged: false },
      kg: kg ? { logged: true, ...kg, updatedAt: kgCred?.updatedAt } : { logged: false },
      tx: tx ? { logged: true, uin: tx.uin, vipType: txCred?.vipType ?? null, updatedAt: txCred?.updatedAt } : { logged: false },
    }
  })
}
