// 各平台 URL 直连接口汇总
// 服务器环境固定使用内置直连接口（apiSource.value === 'internal'）
// 外部聚合音源（sources/ 目录脚本）不走这里，由 musicSdk/api-source.ts 直接接入 source.js
import kw from './kw.js';
import kg from './kg.js';
import tx from './tx.js';
import wy from './wy.js';
import mg from './mg.js';
import bd from './bd.js';
export default {
    kw: kw,
    kg: kg,
    tx: tx,
    wy: wy,
    mg: mg,
    bd: bd,
};
