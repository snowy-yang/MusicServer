// 登录路由 —— wy 扫码/手机号，kg 扫码/短信/token，tx 扫码/cookie 绑定，凭据持久化于 data/auth.json
// 注意：成功响应返回裸数据对象，全局 preSerialization 钩子会统一包成 { code: 0, data }

import * as wyAuth from '../sdk/auth/wy.ts'
import * as kgAuth from '../sdk/auth/kg.ts'
import * as txAuth from '../sdk/auth/tx.ts'
import * as qsPassport from '../sdk/qs/passport.ts'
import * as biliAuth from '../sdk/bili/login.ts'
import { status as xmStatus } from '../sdk/xm/index.ts'
import { status as meStatus } from '../sdk/me/index.ts'
import { status as qianStatus } from '../sdk/qian/index.ts'
import { status as jooxStatus } from '../sdk/joox/index.ts'
import { status as appleStatus } from '../sdk/apple/index.ts'
import { status as fivesingStatus } from '../sdk/5sing/index.ts'
import * as lrAuth from '../sdk/lr/auth.ts'
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
      description: 'token 从酷狗 App 抓包获取（login.token），服务端向用户中心验证后存储。' +
        '推荐改用 /login/kg/qr 扫码或 /login/kg/cellphone 短信验证码登录，无需抓包。',
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

  fastify.post('/login/kg/qr', {
    schema: {
      summary: '获取酷狗扫码登录二维码',
      description: '用酷狗 App 扫码后轮询 /login/kg/qr/check 完成登录。返回 qrimg（data URL）可直接展示。',
      tags: ['登录'],
    },
  }, async() => kgAuth.qrKey())

  fastify.post('/login/kg/qr/check', {
    schema: {
      summary: '轮询酷狗扫码状态',
      description: 'code：800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（自动保存凭据并返回账号资料）。',
      tags: ['登录'],
      body: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  }, async(request, reply) => {
    try {
      return await kgAuth.qrCheck(request.body.key)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/kg/captcha', {
    schema: {
      summary: '发送酷狗短信验证码',
      description: '向手机号发送登录验证码（有频控，勿频繁调用），随后用 /login/kg/cellphone 提交。',
      tags: ['登录'],
      body: { type: 'object', properties: { mobile: { type: 'string' } }, required: ['mobile'] },
    },
  }, async(request, reply) => {
    try {
      return await kgAuth.sendCaptcha(request.body.mobile)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/kg/cellphone', {
    schema: {
      summary: '酷狗手机验证码登录',
      description: 'mobile + code（/login/kg/captcha 发送的短信验证码），成功后自动保存凭据并返回账号资料。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          mobile: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['mobile', 'code'],
      },
    },
  }, async(request, reply) => {
    try {
      return await kgAuth.cellphoneLogin(request.body)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/kg/password', {
    schema: {
      summary: '酷狗账号密码登录',
      description: '触发 20028 风控时返回 needVerify 挑战（含 eventid、验证类型与 sid/edt 指纹）：' +
        '滑块类需浏览器完成图形验证（返回的 url/txappid 供前端加载腾讯验证码）后调 /login/kg/verify，' +
        '再重试本接口；短信类（v_type=32）将收到的短信码先提交 /login/kg/verify，随后带 code 重试本接口完成登录。' +
        '风控较严，频繁失败建议改用扫码或短信登录。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
          code: { type: 'string', description: '短信验证码（20028 短信验证通过后重试登录时携带）' },
        },
        required: ['username', 'password'],
      },
    },
  }, async(request, reply) => {
    try {
      return await kgAuth.passwordLogin(request.body)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/kg/verify', {
    schema: {
      summary: '提交酷狗风控验证结果',
      description: '配合 /login/kg/password 的 needVerify 挑战使用：verifycode 为图形验证码凭证' +
        '（格式 KGCodeXX|{ticket,randstr,txappid}）或短信验证码。sid/edt 省略时服务端自动生成行为指纹。' +
        '验证通过后按挑战类型重试登录（短信码带 code 重试 /login/kg/password）。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          eventid: { type: 'string' },
          v_type: { type: 'integer', description: '验证类型（needVerify 返回的 v_type）' },
          verifycode: { type: 'string' },
          sid: { type: 'string' },
          edt: { type: 'string' },
        },
        required: ['eventid', 'v_type', 'verifycode'],
      },
    },
  }, async(request, reply) => {
    try {
      return await kgAuth.verifyUserInfo(request.body)
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

  fastify.post('/login/tx/qr', {
    schema: {
      summary: '获取 QQ 音乐扫码登录二维码',
      description: '用 QQ 音乐 App（或 QQ/微信）扫码后轮询 /login/tx/qr/check 完成登录。返回 qrimg（data URL）可直接展示，qrsig 需原样回传。',
      tags: ['登录'],
    },
  }, async() => txAuth.qrShow())

  fastify.post('/login/tx/qr/check', {
    schema: {
      summary: '轮询 QQ 音乐扫码状态',
      description: 'code：800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（自动保存凭据并返回账号信息）。',
      tags: ['登录'],
      body: { type: 'object', properties: { qrsig: { type: 'string' } }, required: ['qrsig'] },
    },
  }, async(request, reply) => {
    try {
      return await txAuth.qrCheck(request.body.qrsig)
    } catch (err) {
      return fail(reply, err)
    }
  })

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

  // ---------- 汽水音乐 ----------

  fastify.post('/login/qs/qr', {
    schema: {
      summary: '获取汽水音乐扫码登录二维码',
      description: '用「汽水音乐 APP」扫一扫（官方 PC 客户端同款文案：打开汽水音乐 APP → 搜索框右侧扫一扫；' +
        '抖音 APP 扫可能不完成确认）后轮询 /login/qs/qr/check 完成登录。' +
        '返回 qrimg（data URL）可直接展示，token 需原样回传；二维码内容为官方 PC 客户端同款扫码页' +
        '（bff-pc.qishui.com/light/invoke/scan_login，另见 scanUrl 字段）。轮询间隔建议 ≥2 秒。' +
        '登录后 qs 取流走签名 track_v2，解锁完整曲目。',
      tags: ['登录'],
    },
  }, async(_request, reply) => {
    try {
      return await qsPassport.createQr()
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/qs/qr/check', {
    schema: {
      summary: '轮询汽水音乐扫码状态',
      description: 'code：800 二维码过期/被拒 / 801 等待扫码 / 802 已扫码待确认（含需二次验证）/ 803 登录成功（自动保存凭据）。',
      tags: ['登录'],
      body: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
    },
  }, async(request, reply) => {
    try {
      return await qsPassport.checkQr(request.body.token)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.delete('/login/qs', {
    schema: { summary: '退出汽水音乐登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('qs')
    return { logged: false }
  })

  // ---------- 喜马拉雅 ----------

  fastify.post('/login/xm', {
    schema: {
      summary: '绑定喜马拉雅 cookie',
      description: 'cookie 从已登录的 www.ximalaya.com 浏览器请求头复制（须含 1&_token 字段），' +
        '用于解锁 xm 付费/已购内容取流。无法自动续期，失效后需重新复制绑定。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: { cookie: { type: 'string' } },
        required: ['cookie'],
      },
    },
  }, async(request, reply) => {
    const cookie = String(request.body.cookie || '')
    if (!/1&_token=\S+/.test(cookie)) {
      return reply.code(422).send({ code: 422, msg: 'cookie 需包含 1&_token 字段' })
    }
    setCredentials('xm', { cookie })
    return { logged: true }
  })

  fastify.delete('/login/xm', {
    schema: { summary: '退出喜马拉雅登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('xm')
    return { logged: false }
  })

  // ---------- 猫耳FM ----------

  fastify.post('/login/me', {
    schema: {
      summary: '绑定猫耳FM token',
      description: 'cookie 从已登录的 m.missevan.com 浏览器请求头或猫耳 App 抓包复制（须含 token= 字段），' +
        '用于解锁 me 付费声音取流（App API 签名通道会自动携带）。无法自动续期，失效后需重新绑定。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: { cookie: { type: 'string' } },
        required: ['cookie'],
      },
    },
  }, async(request, reply) => {
    const cookie = String(request.body.cookie || '')
    if (!/(?:^|;\s*)token=\S+/.test(cookie)) {
      return reply.code(422).send({ code: 422, msg: 'cookie 需包含 token 字段' })
    }
    setCredentials('me', { cookie })
    return { logged: true }
  })

  fastify.delete('/login/me', {
    schema: { summary: '退出猫耳FM登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('me')
    return { logged: false }
  })

  // ---------- 懒人听书 ----------

  fastify.post('/login/lr', {
    schema: {
      summary: '懒人听书账号登录',
      description: 'm.lrts.me 账号密码登录（密码按上游要求以 base64 提交）。成功后会话 Cookie 持久化到 data/auth.json，' +
        '此后 lr 取流自动携带 —— 懒人听书要求登录态，免费章节同样如此。',
      tags: ['登录'],
      body: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '账号（手机号）' },
          password: { type: 'string', description: '密码（明文传入，服务端自行编码）' },
        },
        required: ['account', 'password'],
      },
    },
  }, async(request, reply) => {
    const { account, password } = request.body
    try {
      return await lrAuth.login({ account, password })
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.delete('/login/lr', {
    schema: { summary: '退出懒人听书登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('lr')
    return { logged: false }
  })

  // ---------- 哔哩哔哩 ----------

  fastify.post('/login/bl/qr', {
    schema: {
      summary: '获取哔哩哔哩扫码登录二维码',
      description: '用 B站 App 扫码后轮询 /login/bl/qr/check 完成登录。返回 key 需原样回传，qrimg 为 data URL 可直接展示。',
      tags: ['登录'],
    },
  }, async(request, reply) => {
    try {
      return await biliAuth.createQRLogin()
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.post('/login/bl/qr/check', {
    schema: {
      summary: '轮询哔哩哔哩扫码状态',
      description: 'status：waiting 等待扫码 / scanned 已扫码待确认 / success 登录成功（自动保存凭据并返回账号资料）' +
        '/ expired 二维码过期 / failed 失败。code 为 B站原始返回码（86101/86038/86090/0）。',
      tags: ['登录'],
      body: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  }, async(request, reply) => {
    try {
      return await biliAuth.checkQRLogin(request.body.key)
    } catch (err) {
      return fail(reply, err)
    }
  })

  fastify.delete('/login/bl', {
    schema: { summary: '退出哔哩哔哩登录', tags: ['登录'] },
  }, async() => {
    clearCredentials('bl')
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
      description: 'wy 为实时校验（未登录或 cookie 失效返回 logged: false），kg/tx/bl 为已存凭据（含 VIP 等级与最近更新时间），' +
        'qs/xm/me/lr/bd/jx/apple/5s 为已存凭据。',
      tags: ['登录'],
    },
  }, async() => {
    const [wy, kg] = await Promise.all([wyAuth.status().catch(() => null), Promise.resolve(kgAuth.status())])
    const tx = getTxAuth()
    const txCred = getCredentials('tx') as { vipType?: string, updatedAt?: string } | null
    const kgCred = getCredentials('kg') as { updatedAt?: string } | null
    return {
      wy: wy ? { logged: true, ...wy } : { logged: false },
      kg: kg ? { logged: true, ...kg, updatedAt: kgCred?.updatedAt } : { logged: false },
      tx: tx ? { logged: true, uin: tx.uin, vipType: txCred?.vipType ?? null, updatedAt: txCred?.updatedAt } : { logged: false },
      qs: qsPassport.status(),
      xm: xmStatus(),
      me: meStatus(),
      lr: lrAuth.status(),
      bl: biliAuth.status(),
      bd: qianStatus(),
      jx: jooxStatus(),
      apple: appleStatus(),
      '5s': fivesingStatus(),
    }
  })
}
