// 各平台 URL 直连接口汇总
// 服务器环境固定使用内置直连接口（apiSource.value === 'internal'）
// lx 为 lx-music 聚合源：isolated-vm 硬隔离执行原始脚本（签名方案已放弃，见 docs/lx-source-ivm.md）
import kw from './kw.js';
import kg from './kg.js';
import tx from './tx.js';
import wy from './wy.js';
import mg from './mg.js';
import bd from './bd.js';
import lx from './lx-source.js';
export default {
    kw: kw,
    kg: kg,
    tx: tx,
    wy: wy,
    mg: mg,
    bd: bd,
    lx: lx,
};
