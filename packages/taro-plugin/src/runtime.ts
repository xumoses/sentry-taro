// Keep emitted runtimes as source text: bundlers may rename lexical references
// in ordinary functions, so Function#toString is not safe for generated modules.
export const ROUTE_RUNTIME = String.raw`
function normalizedReplayRoute(route, prefix) {
  const normalized = String(route || "").split(/[?#]/)[0].replace(/^\/+/, "").replace(/\/+/g, "/");
  return prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
`;

export const STYLES_RUNTIME = String.raw`
function dedupeStyleReferences(references, chunks) {
  const seen = new Set();
  const kept = [];
  for (let position = references.length - 1; position >= 0; position--) {
    const reference = references[position];
    const index = typeof reference === "number" ? reference : reference.index;
    const mayDedupe = typeof reference === "number" && !/@layer\b/i.test(chunks[index]);
    if (!mayDedupe || !seen.has(index)) kept.push(index);
    if (mayDedupe) seen.add(index);
  }
  return kept.reverse();
}
function createReplayStylesRuntime(encoded, byteLength, decodeReplayAssetData) {
  let data;
  return function getReplayStyles(route) {
    try {
      if (!data) data = decodeReplayAssetData(encoded, byteLength);
      const normalized = normalizedReplayRoute(route, data.prefix);
      const page = Object.prototype.hasOwnProperty.call(data.pages, normalized) ? data.pages[normalized] : [];
      return dedupeStyleReferences(data.app.concat(page), data.chunks).map(function (index) { return data.chunks[index]; }).join("\n");
    } catch (error) {
      return "";
    }
  };
}
`;

export const IMAGES_RUNTIME = String.raw`
function isPackagedImageBase64(value, byteLength) {
  if (typeof value !== "string" || value.length !== 4 * Math.ceil(byteLength / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding !== byteLength) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(value[value.length - padding - 1]);
  return padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0;
}
function createReplayImagesRuntime(encoded, byteLength, decodeReplayAssetData, readPackagedImage) {
  let data;
  const cache = new Map();
  return function getReplayImageSources(route) {
    const selected = {};
    try {
      if (!data) data = decodeReplayAssetData(encoded, byteLength);
      const normalized = normalizedReplayRoute(route, data.prefix);
      const indexes = Object.prototype.hasOwnProperty.call(data.pages, normalized) ? data.pages[normalized] : [];
      for (const index of indexes) {
        const entry = data.entries[index];
        const key = entry[0];
        const source = entry[1];
        if (source === undefined || typeof source === "string") {
          selected[key] = source === undefined ? key : source;
          continue;
        }
        if (cache.has(index)) {
          selected[key] = cache.get(index);
          continue;
        }
        // Only build-audited paths reach the reader; DOM src never constructs a path.
        if (!source || typeof source.path !== "string" || !source.path.startsWith(data.packagePrefix) || /[\\\0?#:]/.test(source.path) || source.path.split("/").some(function (part) { return !part || part === "." || part === ".."; }) || !Number.isInteger(source.bytes) || source.bytes < 0 || source.bytes > 96 * 1024 || !/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/.test(source.mime)) continue;
        try {
          const base64 = readPackagedImage(source.path);
          if (!isPackagedImageBase64(base64, source.bytes)) continue;
          const value = "data:" + source.mime + ";base64," + base64;
          cache.set(index, value);
          selected[key] = value;
        } catch (error) {
          // Unavailable subpackage files can be retried on a later route visit.
        }
      }
    } catch (error) {
      // Optional Replay data must not interrupt application rendering.
    }
    return selected;
  };
}
`;
