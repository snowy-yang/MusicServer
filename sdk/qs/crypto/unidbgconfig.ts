// 汽水音乐（luna, aid=386088）签名配置
// signKey/licenseId 是字节 metasec SDK 家族（v04.04.05-ov-android）共用密钥——经 ssovit(TikTok
// aid=1233)/fanqie-assistant(番茄 aid=1967)/本项目(汽水 aid=386088) 三方同源实证；per-app 的只有
// 载荷里的 msAppID（argus protobuf field 4，由 config.aid 提供）。metasec license blob（native
// SDK 运行时 init 用）不参与离线签名。
import { unhex } from "./index.ts";

export interface UnidbgConfig {
    signKey: Uint8Array;
    aid: string;
    licenseId: string;
    sdkVersion: string;
    sdkVersionInt: number;
    callType: number;
    secDeviceId?: string;
}

export const defaultUnidbgConfig: UnidbgConfig = {
    signKey: new Uint8Array(
        unhex("ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c"),
    ),
    aid: "386088",
    licenseId: "1611921764",
    sdkVersion: "v04.04.05-ov-android",
    sdkVersionInt: 134744640,
    callType: 738,
};
