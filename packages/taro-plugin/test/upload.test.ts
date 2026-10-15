import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { uploadSourceMaps, type SourceMapUploadOptions } from '../src/upload';

const mocked = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
  upload: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock('@sentry/cli', () => ({
  SentryCli: class {
    constructor(...args: unknown[]) {
      mocked.constructor(...args);
    }
    releases = { new: mocked.create, uploadSourceMaps: mocked.upload, finalize: mocked.finalize };
  },
}));

const roots: string[] = [];
const MAP = JSON.stringify(
  {
    version: 3,
    file: 'app-service.js',
    sources: ['webpack:///src/screen.ts'],
    sourcesContent: ['const answer = 42;'],
    names: [],
    mappings: 'AAAA;AACA',
    x_custom: 'preserve-me',
  },
  null,
  2,
);
const REAL_JS = '// Final WeChat assembled JavaScript\nconst answer = 42;\n';

function write(root: string, files: Record<string, string>) {
  for (const [name, data] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

function fixture(files: Record<string, string> = { '__APP__/app-service.js.map': MAP }) {
  const root = mkdtempSync(join(tmpdir(), 'sentry-taro-upload-test-'));
  roots.push(root);
  const input = join(root, 'download');
  mkdirSync(input);
  write(input, files);
  return { root, input };
}

function options(input: string): SourceMapUploadOptions {
  return {
    release: { name: 'sample@1.0.0+0123456789ab', dist: 'ci-42' },
    wechat: { sourceMapPath: input },
    silent: true,
  };
}

function snapshot(root: string, relative = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    if (lstatSync(join(root, path)).isDirectory()) Object.assign(result, snapshot(root, path));
    else result[path] = readFileSync(join(root, path), 'base64');
  }
  return result;
}

function stagingDirectories() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('sentry-taro-sourcemaps-'))
    .sort();
}

beforeEach(() => {
  mocked.constructor.mockReset();
  mocked.create.mockReset().mockResolvedValue('created');
  mocked.upload.mockReset().mockResolvedValue(['uploaded']);
  mocked.finalize.mockReset().mockResolvedValue('finalized');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('final WeChat source-map upload', () => {
  test('preserves final bytes, main and subpackage URLs, and input while delegating to the official CLI', async () => {
    const { input } = fixture({
      '__APP__/app-service.js.map': MAP,
      '__APP__/app-service.js': REAL_JS,
      '__FULL__/app-service.js.map': 'not a selected map',
      '__FULL__/app-service.js': 'aggregate must not upload',
      'subpackage/app-service.js.map': MAP,
      'subpackage/readme.txt': 'not an artifact',
    });
    const before = snapshot(input);
    let staging = '';
    mocked.upload.mockImplementation(async (release, settings) => {
      expect(release).toBe('sample@1.0.0+0123456789ab');
      expect(settings).toMatchObject({
        dist: 'ci-42',
        rewrite: false,
        validate: true,
        dedupe: true,
        urlPrefix: 'https://usr',
        projects: ['front-end', 'mobile'],
      });
      expect(settings.include).toHaveLength(1);
      staging = dirname(settings.include[0]);
      expect(snapshot(settings.include[0])).toEqual({
        'app-service.js': Buffer.from(REAL_JS).toString('base64'),
        'app-service.js.map': Buffer.from(MAP).toString('base64'),
        'subpackage/app-service.js': Buffer.from(
          '//# sourceMappingURL=app-service.js.map\n',
        ).toString('base64'),
        'subpackage/app-service.js.map': Buffer.from(MAP).toString('base64'),
      });
      return [];
    });
    const result = await uploadSourceMaps({
      ...options(input),
      project: ['front-end', 'mobile'],
      org: 'example-org',
      authToken: 'example-token',
      url: 'https://sentry.example.test',
      headers: { 'X-Example': 'header-secret' },
    });
    expect(mocked.constructor).toHaveBeenCalledWith(null, {
      org: 'example-org',
      authToken: 'example-token',
      url: 'https://sentry.example.test',
      headers: { 'X-Example': 'header-secret' },
      silent: true,
    });
    expect(mocked.create).toHaveBeenCalledWith('sample@1.0.0+0123456789ab', {
      projects: ['front-end', 'mobile'],
    });
    expect(mocked.create.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.upload.mock.invocationCallOrder[0]!,
    );
    expect(mocked.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.finalize.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      release: 'sample@1.0.0+0123456789ab',
      dist: 'ci-42',
      sourceMaps: 2,
      files: [
        'app-service.js',
        'app-service.js.map',
        'subpackage/app-service.js',
        'subpackage/app-service.js.map',
      ],
      generatedCompanions: ['subpackage/app-service.js'],
    });
    expect(existsSync(staging)).toBe(false);
    expect(snapshot(input)).toEqual(before);
  });

  test('reads the final ZIP without changing it, and generates only missing assembled-JS companions', async () => {
    const { root } = fixture();
    const archive = join(root, 'final.zip');
    const zip = new AdmZip();
    zip.addFile('__APP__/app-service.js.map', Buffer.from(MAP));
    zip.addFile('subpackage/app-service.js.map', Buffer.from(MAP));
    zip.addFile('subpackage/app-service.js', Buffer.from(REAL_JS));
    zip.writeZip(archive);
    const before = readFileSync(archive);
    mocked.upload.mockImplementation(async (_release, settings) => {
      expect(readFileSync(join(settings.include[0], 'subpackage/app-service.js'), 'utf8')).toBe(
        REAL_JS,
      );
      return [];
    });
    const result = await uploadSourceMaps(options(archive));
    expect(result?.generatedCompanions).toEqual(['app-service.js']);
    expect(readFileSync(archive)).toEqual(before);
  });

  test.each(['**/*.js', '**/*.map', './**/*.map'])(
    'resolves %s against normalized paths and includes the associated files',
    async (assets) => {
      const { input } = fixture({
        '__APP__/app-service.js.map': MAP,
        'subpackage/app-service.js.map': MAP,
      });
      const result = await uploadSourceMaps({
        ...options(input),
        sourcemaps: { assets, ignore: 'subpackage/**' },
      });
      expect(result?.files).toEqual(['app-service.js', 'app-service.js.map']);
    },
  );

  test('rejects an explicitly ignored required companion before constructing the CLI', async () => {
    const { input } = fixture();
    await expect(
      uploadSourceMaps({
        ...options(input),
        sourcemaps: { assets: '**/*.js', ignore: '**/*.map' },
      }),
    ).rejects.toThrow('ignored companion');
    expect(mocked.constructor).not.toHaveBeenCalled();
  });

  test.each([{ assets: 'missing/**' }, { assets: [] }, { ignore: '**/*' }])(
    'rejects no-map selection: %j',
    async (sourcemaps) => {
      const { input } = fixture();
      await expect(uploadSourceMaps({ ...options(input), sourcemaps })).rejects.toThrow(
        'No final WeChat source maps',
      );
      expect(mocked.constructor).not.toHaveBeenCalled();
    },
  );

  test('creates and finalizes independently, and passes custom prefixes and a single project', async () => {
    const { input } = fixture();
    await uploadSourceMaps({
      ...options(input),
      project: 'mobile',
      release: { name: 'release-id', create: false },
      wechat: { sourceMapPath: input, urlPrefix: 'https://runtime.example.test' },
    });
    expect(mocked.create).not.toHaveBeenCalled();
    expect(mocked.upload).toHaveBeenCalledWith(
      'release-id',
      expect.objectContaining({ projects: ['mobile'], urlPrefix: 'https://runtime.example.test' }),
    );
    expect(mocked.finalize).toHaveBeenCalledWith('release-id');
    expect(mocked.constructor).toHaveBeenCalledWith(null, { project: 'mobile', silent: true });
    mocked.create.mockClear();
    mocked.finalize.mockClear();
    await uploadSourceMaps({ ...options(input), release: { name: 'release-id', finalize: false } });
    expect(mocked.create).toHaveBeenCalledWith('release-id', {});
    expect(mocked.finalize).not.toHaveBeenCalled();
  });

  test.each(['create', 'upload', 'finalize'] as const)(
    'cleans all staging on %s failure, without changing downloaded artifacts',
    async (stage) => {
      const { input } = fixture();
      const before = snapshot(input);
      const stagingBefore = stagingDirectories();
      mocked[stage].mockRejectedValue(new Error(`${stage} failed`));
      await expect(uploadSourceMaps(options(input))).rejects.toThrow(`${stage} failed`);
      expect(snapshot(input)).toEqual(before);
      expect(stagingDirectories()).toEqual(stagingBefore);
      if (stage === 'create') expect(mocked.upload).not.toHaveBeenCalled();
      if (stage !== 'finalize') expect(mocked.finalize).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    'redacts token and header values before errorHandler (rethrow=%s) and cleans staging',
    async (rethrow) => {
      const { input } = fixture();
      vi.stubEnv('SENTRY_AUTH_TOKEN', 'env-secret');
      const stagingBefore = stagingDirectories();
      const cause = new Error('failure token-secret header-secret env-secret');
      mocked.upload.mockRejectedValue(cause);
      const handler = vi.fn((error: Error) => {
        expect(error.message).toBe('failure [redacted] [redacted] [redacted]');
        expect(error.stack).not.toContain('token-secret');
        expect(error).not.toHaveProperty('cause');
        if (rethrow) throw error;
      });
      const promise = uploadSourceMaps({
        ...options(input),
        authToken: 'token-secret',
        headers: { 'X-Secret': 'header-secret' },
        errorHandler: handler,
      });
      if (rethrow) await expect(promise).rejects.toThrow('failure [redacted]');
      else await expect(promise).resolves.toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(stagingDirectories()).toEqual(stagingBefore);
    },
  );

  test('logs filenames only when debugging and gives silent precedence', async () => {
    const { input } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const common = {
      ...options(input),
      debug: true,
      authToken: 'token-secret',
      headers: { 'X-Secret': 'header-secret' },
    };
    await uploadSourceMaps({ ...common, silent: false });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('app-service.js.map');
    expect(logged).not.toContain('token-secret');
    expect(logged).not.toContain('header-secret');
    expect(logged).not.toContain('preserve-me');
    log.mockClear();
    await uploadSourceMaps(common);
    expect(log).not.toHaveBeenCalled();
  });

  test.each([{ disable: true }, { sourcemaps: { disable: true } }])(
    'disabled upload skips disk and CLI operations: %j',
    async (disabled) => {
      await expect(
        uploadSourceMaps({ ...options('/does-not-exist'), ...disabled }),
      ).resolves.toBeUndefined();
      expect(mocked.constructor).not.toHaveBeenCalled();
    },
  );

  test.each([
    { unsupported: true },
    { release: { name: 'release-id', inject: true } },
    { sourcemaps: { filesToDeleteAfterUpload: '**/*' } },
    { wechat: { sourceMapPath: '/missing', layout: 'local' } },
    { sourcemaps: { assets: '../*.map' } },
    { sourcemaps: { assets: '/absolute/**/*.map' } },
    { sourcemaps: { ignore: '!app-service.js' } },
    { release: { name: '--help' } },
    { project: [] },
    { headers: { 'X-Secret': 'value\ninjected' } },
  ])('rejects unsupported or invalid options before CLI work: %j', async (invalid) => {
    await expect(
      uploadSourceMaps({ ...options('/missing'), ...invalid } as SourceMapUploadOptions),
    ).rejects.toThrow();
    expect(mocked.constructor).not.toHaveBeenCalled();
  });

  test.each([
    { 'app-service.js.map': MAP },
    { '__APP__/unrelated.js.map': MAP },
    { '__APP__/app-service.js.map': 'invalid JSON' },
    { '__APP__/app-service.js.map': '{"version":2,"mappings":"","sources":[]}' },
    { '__APP__/app-service.js.map': MAP, 'subpackage/missing.js.map': MAP },
    { '__APP__/app-service.js.map': MAP, 'app-service.js.map': MAP },
  ])(
    'rejects missing, incomplete, invalid or colliding final layout and cleans staging: %j',
    async (files) => {
      const { input } = fixture(files);
      const stagingBefore = stagingDirectories();
      await expect(uploadSourceMaps(options(input))).rejects.toThrow();
      expect(mocked.constructor).not.toHaveBeenCalled();
      expect(stagingDirectories()).toEqual(stagingBefore);
    },
  );

  test('accepts indexed final maps without flattening them', async () => {
    const indexed = JSON.stringify({
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, map: JSON.parse(MAP) }],
    });
    const { input } = fixture({ '__APP__/app-service.js.map': indexed });
    mocked.upload.mockImplementation(async (_release, settings) => {
      expect(readFileSync(join(settings.include[0], 'app-service.js.map'), 'utf8')).toBe(indexed);
      return [];
    });
    await uploadSourceMaps(options(input));
  });

  test.each(['input', 'file', 'directory'])(
    'rejects a symbolic link at the %s boundary',
    async (boundary) => {
      const { root, input } = fixture();
      let source = input;
      if (boundary === 'input') {
        source = join(root, 'linked-input');
        symlinkSync(input, source);
      } else if (boundary === 'file')
        symlinkSync(join(input, '__APP__/app-service.js.map'), join(input, 'linked.js.map'));
      else symlinkSync(join(input, '__APP__'), join(input, 'linked-directory'));
      await expect(uploadSourceMaps(options(source))).rejects.toThrow('Symbolic links');
      expect(mocked.constructor).not.toHaveBeenCalled();
    },
  );

  test.each([
    '../escape.js',
    '/absolute.js',
    'C:/drive.js',
    'folder\\escape.js',
    './dot.js',
    'folder//double.js',
    'folder/file.js:stream',
    'folder/.. /escape.js',
    'folder/file.js.',
    'folder/CON.js',
    'folder/NUL',
  ])('rejects unsafe ZIP entry %s', async (name) => {
    const { root } = fixture();
    const archive = join(root, 'unsafe.zip');
    const zip = new AdmZip();
    zip.addFile('__APP__/app-service.js.map', Buffer.from(MAP));
    zip.addFile('placeholder.js', Buffer.from('content'));
    zip.getEntry('placeholder.js')!.entryName = name;
    zip.writeZip(archive);
    await expect(uploadSourceMaps(options(archive))).rejects.toThrow('Unsafe path');
    expect(mocked.constructor).not.toHaveBeenCalled();
  });

  test('rejects ZIP symbolic links instead of materializing or following them', async () => {
    const { root } = fixture();
    const archive = join(root, 'symlink.zip');
    const zip = new AdmZip();
    zip.addFile('__APP__/app-service.js.map', Buffer.from(MAP));
    zip.addFile('link', Buffer.from('/outside'));
    zip.getEntry('link')!.attr = (0xa1ff << 16) >>> 0;
    zip.writeZip(archive);
    await expect(uploadSourceMaps(options(archive))).rejects.toThrow('Symbolic links');
    expect(mocked.constructor).not.toHaveBeenCalled();
  });

  test('rejects duplicate ZIP entries before choosing an ambiguous artifact', async () => {
    const { root } = fixture();
    const archive = join(root, 'duplicate.zip');
    const zip = new AdmZip();
    zip.addFile('__APP__/app-service.js.map', Buffer.from(MAP));
    zip.addFile('placeholder.map', Buffer.from(MAP));
    zip.getEntry('placeholder.map')!.entryName = '__APP__/app-service.js.map';
    zip.writeZip(archive);
    await expect(uploadSourceMaps(options(archive))).rejects.toThrow('Duplicate path');
    expect(mocked.constructor).not.toHaveBeenCalled();
  });

  test('rejects declared ZIP expansion beyond the limit before inflating entries', async () => {
    const { root } = fixture();
    const archive = join(root, 'oversized.zip');
    const zip = new AdmZip();
    zip.addFile('__APP__/app-service.js.map', Buffer.from(MAP));
    const bytes = zip.toBuffer();
    const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(512 * 1024 * 1024 + 1, centralHeader + 24);
    writeFileSync(archive, bytes);
    await expect(uploadSourceMaps(options(archive))).rejects.toThrow('exceed 512 MiB');
    expect(mocked.constructor).not.toHaveBeenCalled();
  });

  test.each(['archive', 'directory'])(
    'rejects an oversized %s before reading or copying it',
    async (kind) => {
      const { root, input } = fixture();
      let source = input;
      if (kind === 'archive') {
        source = join(root, 'oversized.zip');
        writeFileSync(source, '');
        truncateSync(source, 256 * 1024 * 1024 + 1);
      } else truncateSync(join(input, '__APP__/app-service.js.map'), 512 * 1024 * 1024 + 1);
      await expect(uploadSourceMaps(options(source))).rejects.toThrow(/exceeds? (?:256|512) MiB/);
      expect(mocked.constructor).not.toHaveBeenCalled();
    },
  );

  test('keeps source text out of malformed JSON diagnostics', async () => {
    const { input } = fixture({ '__APP__/app-service.js.map': '"private-source-text" malformed' });
    await expect(uploadSourceMaps(options(input))).rejects.toThrow(
      'Invalid final source map: app-service.js.map',
    );
    const handled = vi.fn();
    await uploadSourceMaps({ ...options(input), errorHandler: handled });
    expect(handled.mock.calls[0]?.[0].message).not.toContain('private-source-text');
  });

  test('cleans staging if the optional CLI cannot initialize', async () => {
    const { input } = fixture();
    const before = snapshot(input);
    const stagingBefore = stagingDirectories();
    mocked.constructor.mockImplementation(() => {
      throw new Error('Sentry CLI binary not found');
    });
    await expect(uploadSourceMaps(options(input))).rejects.toThrow('Sentry CLI binary not found');
    expect(mocked.create).not.toHaveBeenCalled();
    expect(mocked.upload).not.toHaveBeenCalled();
    expect(snapshot(input)).toEqual(before);
    expect(stagingDirectories()).toEqual(stagingBefore);
  });
});
