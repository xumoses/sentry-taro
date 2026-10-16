import { strFromU8, unzlibSync } from 'fflate';
import { decodeBase64 } from './worker/base64';

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const INVALID_ASSET = 'Invalid compressed Replay asset data';

function invalid(): never {
  throw new Error(INVALID_ASSET);
}

/** Reject invalid UTF-8 consistently, including runtimes without TextDecoder. */
function validateUtf8(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]!;
    if (first < 0x80) continue;
    const count =
      first >= 0xc2 && first <= 0xdf
        ? 1
        : first <= 0xef && first >= 0xe0
          ? 2
          : first >= 0xf0 && first <= 0xf4
            ? 3
            : 0;
    if (!count || index + count > bytes.length) invalid();
    const second = bytes[index]!;
    if (
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second >= 0xa0) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second >= 0x90)
    )
      invalid();
    for (let offset = 0; offset < count; offset++) {
      if ((bytes[index++]! & 0xc0) !== 0x80) invalid();
    }
  }
}

function adler32(bytes: Uint8Array): number {
  let first = 1;
  let second = 0;
  // Periodic reduction bounds both sums for large assets.
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(start + 5552, bytes.length);
    for (let index = start; index < end; index++) {
      first += bytes[index]!;
      second += first;
    }
    first %= 65521;
    second %= 65521;
  }
  return ((second << 16) | first) >>> 0;
}

/**
 * Decode trusted build-time JSON assets encoded as UTF-8, zlib and base64.
 * Both compressed bytes and the declared UTF-8 length are limited to 2 MiB.
 * Throws for invalid data. No code is evaluated and no globals are installed.
 */
export function decodeReplayAssetData(encoded: string, byteLength: number): unknown {
  if (
    typeof encoded !== 'string' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MAX_ASSET_BYTES
  )
    invalid();
  const compressed = decodeBase64(encoded, MAX_ASSET_BYTES);
  if (!compressed || compressed.length < 8) invalid();
  // Reject noncanonical padding bits instead of accepting aliases for the same bytes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (
    (encoded.endsWith('==') && alphabet.indexOf(encoded[encoded.length - 3]!) & 15) ||
    (encoded.endsWith('=') &&
      !encoded.endsWith('==') &&
      alphabet.indexOf(encoded[encoded.length - 2]!) & 3)
  )
    invalid();

  let bytes: Uint8Array;
  try {
    // fflate never grows an explicit output buffer. The extra byte detects
    // overflow; using exactly byteLength would silently accept a truncated result.
    bytes = unzlibSync(compressed, { out: new Uint8Array(byteLength + 1) });
  } catch {
    invalid();
  }
  if (bytes.length !== byteLength) invalid();

  // fflate validates the zlib header but does not verify its Adler-32 trailer.
  const end = compressed.length;
  const expected =
    ((compressed[end - 4]! << 24) |
      (compressed[end - 3]! << 16) |
      (compressed[end - 2]! << 8) |
      compressed[end - 1]!) >>>
    0;
  if (adler32(bytes) !== expected) invalid();
  validateUtf8(bytes);
  // JSON.stringify does not add a BOM. Reject one consistently because native
  // TextDecoder strips it while fflate's portable decoder preserves it.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();
  try {
    return JSON.parse(strFromU8(bytes)) as unknown;
  } catch {
    invalid();
  }
}
