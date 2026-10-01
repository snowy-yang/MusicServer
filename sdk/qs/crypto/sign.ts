import { hash } from "./index.ts";
import { getArgus } from "./argus.ts";
import { getLadon } from "./ladon.ts";
import { defaultUnidbgConfig, type UnidbgConfig } from "./unidbgconfig.ts";

export interface UnidbgHeaders extends Record<string, string> {
    "x-argus": string;
    "x-ladon": string;
    "x-khronos": string;
}

export default async function generateHeaders(
    rawQuery: string,
    xssStub = "",
    timestamp: number = Math.floor(Date.now() / 1000),
    config: UnidbgConfig = defaultUnidbgConfig,
): Promise<UnidbgHeaders> {
    const [argus, ladon] = await Promise.all([
        getArgus(rawQuery, xssStub, timestamp, config),
        getLadon(timestamp, config),
    ]);

    return {
        "x-argus": argus,
        "x-ladon": ladon,
        "x-khronos": String(timestamp),
    };
}

export async function signRequest(
    url: string,
    body?: ArrayBuffer | Uint8Array<ArrayBuffer> | string,
    config: UnidbgConfig = defaultUnidbgConfig,
): Promise<Record<string, string>> {
    const rawQuery = new URL(url).search.replace(/^\?/, "");

    const hasBody = typeof body === "string" ? body.length > 0 : (body?.byteLength ?? 0) > 0;
    const xssStub = hasBody ? await hash.md5(body!) : "";

    const now = Date.now();
    const headers: Record<string, string> = await generateHeaders(
        rawQuery,
        xssStub,
        Math.floor(now / 1000),
        config,
    );
    headers["x-ss-req-ticket"] = String(now);
    if (hasBody) {
        headers["X-SS-STUB"] = xssStub;
    }
    return headers;
}

export { getArgus } from "./argus.ts";
export { getLadon } from "./ladon.ts";
export { defaultUnidbgConfig, type UnidbgConfig } from "./unidbgconfig.ts";
