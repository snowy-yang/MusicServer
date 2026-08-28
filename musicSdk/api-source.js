import apiSourceInfo from './api-source-info.js'
import { apiSource, userApi } from '../src/renderer/store.js'
import internalApi from '../src/apis/index.js'
import { createApi as createLxSourceApi } from '../src/apis/lx-source.js'
// import api_temp_kw from './kw/api-temp.js'
// // import api_test_bd from './bd/api-test.js'
// import api_test_tx from './tx/api-test.js'
// import api_test_kg from './kg/api-test.js'
// import api_test_kw from './kw/api-test.js'
// import api_test_mg from './mg/api-test.js'
// import api_test_wy from './wy/api-test.js'

const allApi = {
  v5_kw: createLxSourceApi('kw'),
  v5_kg: createLxSourceApi('kg'),
  v5_tx: createLxSourceApi('tx'),
  v5_wy: createLxSourceApi('wy'),
  v5_mg: createLxSourceApi('mg'),
  // temp_kw: api_temp_kw,
  // // test_bd: api_test_bd,
  // test_tx: api_test_tx,
  // test_kg: api_test_kg,
  // test_kw: api_test_kw,
  // test_mg: api_test_mg,
  // test_wy: api_test_wy,
}

const apiList = {}
const supportQuality = {}

for (const api of apiSourceInfo) {
  supportQuality[api.id] = api.supportQualitys
  for (const source of Object.keys(api.supportQualitys)) {
    apiList[`${api.id}_api_${source}`] = allApi[`${api.id}_${source}`]
  }
}

const getAPI = source => apiList[`${apiSource.value}_api_${source}`]

const apis = source => {
  if (/^user_api/.test(apiSource.value)) return userApi.apis[source]
  // 服务器内置直连接口
  if (apiSource.value == 'internal') {
    const api = internalApi[source]
    if (api) return api
    throw new Error('Api is not found')
  }
  let api = getAPI(source)
  if (api) return api
  throw new Error('Api is not found')
}

export { apis, supportQuality }
