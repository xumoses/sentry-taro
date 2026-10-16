/** Static image and Canvas frame validation without browser or Node decoding APIs. */

export const MEDIA_NODE_NAMES = new Set([
  'image',
  'img',
  'video',
  'audio',
  'live-player',
  'live-pusher',
  'camera',
  'canvas',
  'web-view',
]);

export const MAX_STATIC_IMAGE_SOURCE_BYTES = 128 * 1024;
export const MAX_CANVAS_FRAME_BYTES = 128 * 1024;
export const CANVAS_FRAME_INTERVAL_MS = 1000;
export const STATIC_IMAGE_DATA_URI =
  /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
export const STATIC_SVG_BASE64_DATA_URI =
  /^data:image\/svg\+xml(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]+={0,2})$/;

export const STATIC_SVG_PERCENT_DATA_URI =
  /^data:image\/svg\+xml(?:;charset=utf-8)?,([A-Za-z0-9\-._~!$&'()*+,;=:@/?%]+)$/;

// This validates encoding only. The caller must audit the static image contents.
export function isStaticImageDataUri(value: string): boolean {
  if (STATIC_IMAGE_DATA_URI.test(value)) return true;
  const base64Svg = STATIC_SVG_BASE64_DATA_URI.exec(value);
  if (base64Svg) return base64Svg[1]!.length % 4 === 0;
  const svg = STATIC_SVG_PERCENT_DATA_URI.exec(value);
  if (!svg) return false;
  try {
    decodeURIComponent(svg[1]!);
    return true;
  } catch {
    return false;
  }
}

/** Validate the encoding and raster signature without browser/Node decoding APIs. */
export function isCanvasFrame(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_CANVAS_FRAME_BYTES) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const encoded = match[2]!;
  if (encoded.length % 4) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (
    (padding === 2 && alphabet.indexOf(encoded[encoded.length - 3]!) % 16) ||
    (padding === 1 && alphabet.indexOf(encoded[encoded.length - 2]!) % 4)
  )
    return false;
  const length = (encoded.length / 4) * 3 - padding;
  const byte = (index: number): number => {
    const offset = Math.floor(index / 3) * 4;
    const shift = index % 3;
    const a = alphabet.indexOf(encoded[offset + shift]!);
    const b = alphabet.indexOf(encoded[offset + shift + 1]!);
    return shift === 0
      ? (a << 2) | (b >> 4)
      : shift === 1
        ? ((a & 15) << 4) | (b >> 2)
        : ((a & 3) << 6) | b;
  };
  const matches = (offset: number, bytes: number[]): boolean =>
    bytes.every((value, index) => byte(offset + index) === value);
  if (match[1] === 'png')
    return (
      length >= 45 &&
      matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
      matches(8, [0, 0, 0, 13, 73, 72, 68, 82]) &&
      matches(length - 12, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
    );
  if (match[1] === 'jpeg')
    return length >= 4 && matches(0, [255, 216, 255]) && matches(length - 2, [255, 217]);
  return (
    length >= 20 &&
    matches(0, [82, 73, 70, 70]) &&
    matches(8, [87, 69, 66, 80]) &&
    byte(4) + byte(5) * 256 + byte(6) * 65536 + byte(7) * 16777216 + 8 === length
  );
}
