import { b64encode, getCrypto } from "./index.ts";
import { generateLadonKey, speckEncrypt } from "./speck.ts";
import type { UnidbgConfig } from "./unidbgconfig.ts";

export async function getLadon(timestamp: number, config: UnidbgConfig): Promise<string> {
    const randomBytes = getCrypto().getRandomValues(new Uint8Array(4));

    const plaintext = new TextEncoder().encode(
        `${timestamp}-${config.licenseId}-${config.aid}`,
    );
    const key = await generateLadonKey(randomBytes, config.aid);
    const encrypted = speckEncrypt(key, plaintext);

    const result = new Uint8Array(randomBytes.length + encrypted.length);
    result.set(randomBytes);
    result.set(encrypted, randomBytes.length);
    return b64encode(result.buffer);
}
