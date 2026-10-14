/** UTF-8 without a platform TextEncoder; unmatched UTF-16 surrogates become U+FFFD. */
export function encodeUtf8(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 3);
  let offset = 0;
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + next - 0xdc00;
        index++;
      } else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes[offset++] = code;
    else if (code < 0x800) {
      bytes[offset++] = 0xc0 | (code >> 6);
      bytes[offset++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      bytes[offset++] = 0xe0 | (code >> 12);
      bytes[offset++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (code & 0x3f);
    } else {
      bytes[offset++] = 0xf0 | (code >> 18);
      bytes[offset++] = 0x80 | ((code >> 12) & 0x3f);
      bytes[offset++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (code & 0x3f);
    }
  }
  return bytes.subarray(0, offset);
}
