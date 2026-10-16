#!/usr/bin/env node
'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4178;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_COUNT = 20;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const VIEWER_NONCE_TOKEN = '{{NONCE}}';

const viewerTemplate = readFileSync(join(__dirname, 'viewer.html'), 'utf8');
const captures = new Map();
let totalBytes = 0;

function readPort() {
  const args = process.argv.slice(2);
  const equalsArgument = args.find((argument) => argument.startsWith('--port='));
  const separateIndex = args.indexOf('--port');
  const raw = equalsArgument
    ? equalsArgument.slice('--port='.length)
    : separateIndex >= 0
      ? args[separateIndex + 1]
      : process.env.SENTRY_REPLAY_VIEWER_PORT;

  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}`);
  }

  return port;
}

function setSecurityHeaders(response, nonce) {
  const scriptPolicy = nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'";
  const stylePolicy = nonce ? `style-src 'nonce-${nonce}'` : "style-src 'none'";

  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      scriptPolicy,
      stylePolicy,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  setSecurityHeaders(response);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function sendViewer(response) {
  const nonce = randomBytes(18).toString('base64');
  const body = viewerTemplate.replaceAll(VIEWER_NONCE_TOKEN, nonce);
  response.statusCode = 200;
  setSecurityHeaders(response, nonce);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function isAllowedHost(hostHeader, port) {
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function isSameOriginRequest(request, port) {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }

  const fetchSite = request.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      request.resume();
      reject(
        Object.assign(new Error('Capture exceeds the 5 MiB upload limit.'), { statusCode: 413 }),
      );
      return;
    }

    const chunks = [];
    let byteLength = 0;
    let exceededLimit = false;

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Upload timed out.'));
    });

    request.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_UPLOAD_BYTES) {
        exceededLimit = true;
        chunks.length = 0;
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (exceededLimit) {
        reject(
          Object.assign(new Error('Capture exceeds the 5 MiB upload limit.'), { statusCode: 413 }),
        );
        return;
      }

      try {
        const text = Buffer.concat(chunks, byteLength).toString('utf8');
        resolve({ value: JSON.parse(text), byteLength });
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });

    request.on('error', reject);
  });
}

function validateCapture(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Capture must be a JSON object.';
  }

  if (typeof value.marker !== 'string' || value.marker.length > 200) {
    return 'Capture.marker must be a short string.';
  }

  if (
    typeof value.replayId !== 'string' ||
    value.replayId.length < 1 ||
    value.replayId.length > 128
  ) {
    return 'Capture.replayId must be a non-empty string.';
  }

  if (!Array.isArray(value.events)) {
    return 'Capture.events must be an array.';
  }

  return undefined;
}

function evictOldCaptures() {
  while (captures.size > MAX_CAPTURE_COUNT || totalBytes > MAX_TOTAL_BYTES) {
    const oldestId = captures.keys().next().value;
    if (oldestId === undefined) {
      break;
    }

    const oldest = captures.get(oldestId);
    captures.delete(oldestId);
    totalBytes -= oldest.byteLength;
  }
}

function captureSummary(record) {
  const { capture } = record;
  return {
    id: record.id,
    replayId: capture.replayId,
    marker: capture.marker,
    eventCount: capture.events.length,
    startedAt: capture.startedAt ?? null,
    endedAt: capture.endedAt ?? null,
    stopReason: capture.stopReason ?? null,
    byteLength: record.byteLength,
    receivedAt: record.receivedAt,
  };
}

async function handleApi(request, response, pathname, port) {
  if (!isSameOriginRequest(request, port)) {
    sendJson(response, 403, { error: 'Cross-origin requests are not accepted.' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/captures') {
    sendJson(response, 200, {
      captures: [...captures.values()].reverse().map(captureSummary),
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxCaptureCount: MAX_CAPTURE_COUNT,
        maxTotalBytes: MAX_TOTAL_BYTES,
      },
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/captures') {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      request.resume();
      sendJson(response, 415, { error: 'Content-Type must be application/json.' });
      return;
    }

    try {
      const { value, byteLength } = await readJsonBody(request);
      const capture = value?.capture ?? value;
      const validationError = validateCapture(capture);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const record = {
        id: randomUUID(),
        capture,
        byteLength,
        receivedAt: new Date().toISOString(),
      };
      captures.set(record.id, record);
      totalBytes += byteLength;
      evictOldCaptures();
      sendJson(response, 201, { capture: captureSummary(record) });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      sendJson(response, statusCode, { error: error?.message ?? 'Unable to read capture.' });
    }
    return;
  }

  if (request.method === 'DELETE' && pathname === '/api/captures') {
    captures.clear();
    totalBytes = 0;
    sendJson(response, 200, { ok: true });
    return;
  }

  const match = /^\/api\/captures\/([0-9a-f-]+)$/i.exec(pathname);
  if (request.method === 'GET' && match) {
    const record = captures.get(match[1]);
    if (!record) {
      sendJson(response, 404, { error: 'Capture not found.' });
      return;
    }

    sendJson(response, 200, { capture: record.capture, summary: captureSummary(record) });
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}

let port;
try {
  port = readPort();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const server = createServer((request, response) => {
  if (!isAllowedHost(request.headers.host, port)) {
    sendJson(response, 421, { error: 'Invalid Host header.' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  } catch {
    sendJson(response, 400, { error: 'Invalid request URL.' });
    return;
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/') {
    if (request.method === 'HEAD') {
      response.statusCode = 200;
      setSecurityHeaders(response);
      response.end();
      return;
    }

    sendViewer(response);
    return;
  }

  if (pathname.startsWith('/api/')) {
    void handleApi(request, response, pathname, port);
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = REQUEST_TIMEOUT_MS + 1_000;

server.on('clientError', (_error, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
});

server.on('error', (error) => {
  console.error(`Replay viewer failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, HOST, () => {
  console.log(`Experimental Taro Replay viewer: http://${HOST}:${port}`);
  console.log(`In-memory only; maximum upload ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB.`);
});

function shutdown() {
  server.close(() => {
    process.exitCode = 0;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
