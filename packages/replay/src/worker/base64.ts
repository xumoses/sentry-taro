const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A JSON-safe wire representation also supported by older WeChat workers. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const value =
      (bytes[offset]! << 16) | ((bytes[offset + 1] || 0) << 8) | (bytes[offset + 2] || 0);
    chunks.push(
      ALPHABET[(value >>> 18) & 63]! +
        ALPHABET[(value >>> 12) & 63]! +
        (offset + 1 < bytes.length ? ALPHABET[(value >>> 6) & 63] : '=') +
        (offset + 2 < bytes.length ? ALPHABET[value & 63] : '='),
    );
  }
  return chunks.join('');
}

export function decodeBase64(value: string, maxBytes: number): Uint8Array | undefined {
  if (
    !value ||
    value.length % 4 ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    return undefined;
  const length = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (length > maxBytes) return undefined;
  const bytes = new Uint8Array(length);
  let index = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const chunk =
      (ALPHABET.indexOf(value[offset]!) << 18) |
      (ALPHABET.indexOf(value[offset + 1]!) << 12) |
      (Math.max(0, ALPHABET.indexOf(value[offset + 2]!)) << 6) |
      Math.max(0, ALPHABET.indexOf(value[offset + 3]!));
    bytes[index++] = chunk >>> 16;
    if (index < length) bytes[index++] = chunk >>> 8;
    if (index < length) bytes[index++] = chunk;
  }
  return bytes;
}
