// 登录路由 —— wy 扫码/手机号登录，kg token 绑定，凭据持久化于 data/auth.json
// 注意：成功响应返回裸数据对象，全局 preSerialization 钩子会统一包成 { code: 0, data }

import * as wyAuth from './auth/wy.js'
import * as kgAuth from './auth/kg.js'
import { clearCredentials, getCredentials } from './auth/store.js'

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

  // ---------- 通用 ----------

  fastify.get('/login/status', {
    schema: {
      summary: '查看登录状态',
      description: 'wy 为实时校验（未登录或 cookie 失效返回 logged: false），kg 为已存凭据。',
      tags: ['登录'],
    },
  }, async() => {
    const [wy, kg] = await Promise.all([wyAuth.status().catch(() => null), Promise.resolve(kgAuth.status())])
    return {
      wy: wy ? { logged: true, ...wy } : { logged: false },
      kg: kg ? { logged: true, ...kg } : { logged: false },
    }
  })
}
