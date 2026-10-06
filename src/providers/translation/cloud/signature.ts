/**
 * @file src/providers/translation/cloud/signature.ts
 *
 * 文件职责：为云服务厂商机器翻译适配器提供共用的签名原语，避免每家厂商各写一份 HMAC、摘要与百分号编码实现。
 * 主要内容：基于 WebCrypto 实现 HMAC-SHA1/HMAC-SHA256、SHA-256 摘要、十六进制与 Base64 编码，以及 RFC 3986 百分号编码和查询串规范化；另提供不依赖 WebCrypto 的 MD5，用于百度翻译开放平台的签名。 可核对的公开符号包括 hmacSha256、hmacSha1、sha256Hex、toHex、toBase64、percentEncode、canonicalQueryString、md5Hex。
 * 模块边界：本文件位于 provider 适配层，只做纯计算，不读取配置、不发起网络请求，也不认识任何一家厂商的业务参数；密钥由调用方传入且不做任何记录。
 */

const textEncoder = new TextEncoder();

function toBytes(value: string | ArrayBuffer): Uint8Array {
    return typeof value === 'string' ? textEncoder.encode(value) : new Uint8Array(value);
}

async function hmac(algorithm: 'SHA-1' | 'SHA-256', key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        toBytes(key) as unknown as BufferSource,
        {name: 'HMAC', hash: algorithm},
        false,
        ['sign'],
    );
    return crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(message) as unknown as BufferSource);
}

/** 火山引擎与腾讯云的派生签名密钥基于 HMAC-SHA256；阿里云 RPC 使用下方 SHA1 原语。 */
export function hmacSha256(key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> {
    return hmac('SHA-256', key, message);
}

/** 阿里云 RPC 1.0 签名仍使用 HMAC-SHA1。 */
export function hmacSha1(key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> {
    return hmac('SHA-1', key, message);
}

export function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function toBase64(buffer: ArrayBuffer): string {
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export async function sha256Hex(message: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', textEncoder.encode(message) as unknown as BufferSource));
}

/**
 * 云厂商签名要求 RFC 3986 编码：encodeURIComponent 保留的 ! ' ( ) * 必须继续转义，
 * 而 ~ 必须保持原样，否则规范请求串与服务端计算结果不一致。
 */
export function percentEncode(value: string): string {
    return encodeURIComponent(value)
        .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 按参数名字典序拼接规范查询串，空值参数保留等号，与各家签名文档一致。 */
export function canonicalQueryString(parameters: Record<string, string>): string {
    return Object.keys(parameters)
        .sort()
        .map((key) => `${percentEncode(key)}=${percentEncode(parameters[key])}`)
        .join('&');
}

/* ------------------------------------------------------------------ *
 * MD5：百度翻译开放平台的签名算法，WebCrypto 不提供，必须自行实现。
 * 实现遵循 RFC 1321，只处理 UTF-8 字节序列，不做任何输入记录。
 * ------------------------------------------------------------------ */

const MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_SINES = Array.from({length: 64}, (_unused, index) => (
    Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296)
));

function rotateLeft(value: number, bits: number): number {
    return (value << bits) | (value >>> (32 - bits));
}

export function md5Hex(input: string): string {
    const bytes = textEncoder.encode(input);
    const bitLength = bytes.length * 8;
    // 填充到 64 字节分组：先补 0x80，再补零，最后 8 字节写入小端比特长度。
    const paddedLength = (((bytes.length + 8) >>> 6) + 1) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

    let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < paddedLength; offset += 64) {
        const words = Array.from({length: 16}, (_unused, index) => view.getUint32(offset + index * 4, true));
        let [a, b, c, d] = [a0, b0, c0, d0];
        for (let step = 0; step < 64; step += 1) {
            let f: number;
            let wordIndex: number;
            if (step < 16) {
                f = (b & c) | (~b & d);
                wordIndex = step;
            } else if (step < 32) {
                f = (d & b) | (~d & c);
                wordIndex = (5 * step + 1) % 16;
            } else if (step < 48) {
                f = b ^ c ^ d;
                wordIndex = (3 * step + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                wordIndex = (7 * step) % 16;
            }
            const rotated = rotateLeft((a + f + MD5_SINES[step] + words[wordIndex]) >>> 0, MD5_SHIFTS[step]);
            [a, d, c, b] = [d, c, b, (b + rotated) >>> 0];
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const digest = new DataView(new ArrayBuffer(16));
    digest.setUint32(0, a0, true);
    digest.setUint32(4, b0, true);
    digest.setUint32(8, c0, true);
    digest.setUint32(12, d0, true);
    return toHex(digest.buffer);
}
