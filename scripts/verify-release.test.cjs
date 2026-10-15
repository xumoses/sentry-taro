const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { verifyArtifact, verifyPublishedArtifact } = require('./verify-release.cjs');

const config = {
  name: '@xumoses/sentry-taro',
  version: '0.1.0-beta.1',
  tag: 'beta',
  registry: 'https://registry.npmjs.org/',
};
const sourceCommit = 'a'.repeat(40);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-taro-verify-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('A synthetic release artifact, never published.');
  const manifest = {
    ...config,
    access: 'public',
    filename: 'xumoses-sentry-taro-0.1.0-beta.1.tgz',
    bytes: bytes.length,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceCommit,
    hasUncommittedChanges: false,
  };
  const saveManifest = () => {
    fs.writeFileSync(
      path.join(directory, 'release.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  };
  saveManifest();
  fs.writeFileSync(path.join(directory, manifest.filename), bytes);
  return { directory, manifest, bytes, saveManifest };
}

test('accepts the expected artifact and leaves files untouched', (t) => {
  const { directory, manifest, bytes } = fixture(t);
  const before = fs.readFileSync(path.join(directory, 'release.json'), 'utf8');
  const artifact = verifyArtifact(directory, config, sourceCommit, true);
  assert.deepEqual(artifact.manifest, manifest);
  assert.equal(artifact.tarball, path.join(directory, manifest.filename));
  assert.deepEqual(fs.readFileSync(artifact.tarball), bytes);
  assert.equal(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'), before);
});

test('rejects tarball tampering even when the size stays unchanged', (t) => {
  const { directory, manifest, bytes } = fixture(t);
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  fs.writeFileSync(path.join(directory, manifest.filename), changed);
  assert.throws(() => verifyArtifact(directory, config, sourceCommit), /SHA-512/);
});

test('rejects mismatched metadata, hashes, and unsafe filenames', async (t) => {
  const cases = [
    ['name', '@other/package'],
    ['version', '0.1.0-beta.2'],
    ['tag', 'latest'],
    ['registry', 'https://example.org/'],
    ['access', 'restricted'],
    ['sourceCommit', 'b'.repeat(40)],
    ['bytes', 1],
    ['integrity', 'sha512-tampered'],
    ['sha256', '0'.repeat(64)],
    ['filename', '../outside.tgz'],
    ['filename', '/tmp/outside.tgz'],
    ['filename', '..\\outside.tgz'],
    ['filename', 'xumoses-sentry-taro-0.1.0-beta.1.tgz\ntag=latest'],
    ['hasUncommittedChanges', 'false'],
  ];
  for (const [field, value] of cases) {
    await t.test(`${field}: ${JSON.stringify(value)}`, (subtest) => {
      const { directory, manifest, saveManifest } = fixture(subtest);
      manifest[field] = value;
      saveManifest();
      assert.throws(() => verifyArtifact(directory, config, sourceCommit));
    });
  }
});

test('requires a clean candidate in CI but permits dirty local candidates', (t) => {
  const { directory, manifest, saveManifest } = fixture(t);
  manifest.hasUncommittedChanges = true;
  saveManifest();
  assert.equal(
    verifyArtifact(directory, config, sourceCommit).manifest.hasUncommittedChanges,
    true,
  );
  assert.throws(() => verifyArtifact(directory, config, sourceCommit, true), /clean checkout/);
});

test('rejects symlinked tarballs', (t) => {
  const { directory, manifest, bytes } = fixture(t);
  const tarball = path.join(directory, manifest.filename);
  fs.unlinkSync(tarball);
  const target = path.join(directory, 'other.tgz');
  fs.writeFileSync(target, bytes);
  fs.symlinkSync(target, tarball);
  assert.throws(() => verifyArtifact(directory, config, sourceCommit), /symbolic link/);
});

function registryFixture(manifest, bytes) {
  const tarballUrl = `https://registry.npmjs.org/@xumoses/sentry-taro/-/sentry-taro-${manifest.version}.tgz`;
  const metadata = {
    versions: {
      [manifest.version]: { dist: { integrity: manifest.integrity, tarball: tarballUrl } },
    },
    'dist-tags': { [manifest.tag]: manifest.version },
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === tarballUrl) {
      return { ok: true, arrayBuffer: async () => bytes };
    }
    assert.equal(url, `${config.registry}${encodeURIComponent(config.name)}`);
    return { ok: true, json: async () => metadata };
  };
  return { metadata, calls, fetchImpl };
}

test('checks published metadata and downloaded bytes with anonymous nonredirecting requests', async (t) => {
  const { directory, manifest, bytes } = fixture(t);
  const artifact = verifyArtifact(directory, config, sourceCommit);
  const remote = registryFixture(manifest, bytes);
  await verifyPublishedArtifact(artifact, { fetchImpl: remote.fetchImpl, attempts: 1 });
  assert.equal(remote.calls.length, 2);
  for (const { options } of remote.calls) {
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.keys(options).sort(), ['redirect', 'signal']);
  }
});

test('rejects published mismatches and nonregistry tarball origins', async (t) => {
  const cases = [
    [
      'wrong integrity',
      (metadata) => {
        metadata.versions[config.version].dist.integrity = 'sha512-other';
      },
    ],
    [
      'wrong tag',
      (metadata) => {
        metadata['dist-tags'].beta = '0.1.0-beta.2';
      },
    ],
    [
      'other origin',
      (metadata) => {
        metadata.versions[config.version].dist.tarball = 'https://example.org/package.tgz';
      },
    ],
    [
      'insecure origin',
      (metadata) => {
        metadata.versions[config.version].dist.tarball = 'http://registry.npmjs.org/package.tgz';
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (subtest) => {
      const { directory, manifest, bytes } = fixture(subtest);
      const artifact = verifyArtifact(directory, config, sourceCommit);
      const remote = registryFixture(manifest, bytes);
      mutate(remote.metadata);
      await assert.rejects(
        verifyPublishedArtifact(artifact, {
          fetchImpl: remote.fetchImpl,
          sleepImpl: async () => assert.fail('Must not retry a published mismatch'),
        }),
      );
      assert.equal(remote.calls.length, 1);
    });
  }
});

test('rejects a published tarball whose bytes differ from registry metadata', async (t) => {
  const { directory, manifest, bytes } = fixture(t);
  const artifact = verifyArtifact(directory, config, sourceCommit);
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  const remote = registryFixture(manifest, changed);
  await assert.rejects(
    verifyPublishedArtifact(artifact, {
      fetchImpl: remote.fetchImpl,
      sleepImpl: async () => assert.fail('Must not retry a mismatched tarball'),
    }),
    /SHA-512/,
  );
  assert.equal(remote.calls.length, 2);
});

test('bounds publish-time scanning waits to forty-one attempts thirty seconds apart', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { directory } = fixture(t);
  const artifact = verifyArtifact(directory, config, sourceCommit);
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 404 };
  };
  const sleepImpl = async (milliseconds) => {
    waits.push(milliseconds);
  };
  await assert.rejects(verifyPublishedArtifact(artifact, { fetchImpl, sleepImpl }), /HTTP 404/);
  assert.equal(calls, 41);
  assert.deepEqual(waits, Array(40).fill(30_000));
  await assert.rejects(
    verifyPublishedArtifact(artifact, { fetchImpl, attempts: 42 }),
    /between 1 and 41/,
  );
});

test('waits for missing versions or tags before confirming downloaded bytes', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const pending of [{ versions: {} }, { versions: null }, 'missing tag']) {
    await t.test(JSON.stringify(pending), async (subtest) => {
      const { directory, manifest, bytes } = fixture(subtest);
      const artifact = verifyArtifact(directory, config, sourceCommit);
      const remote = registryFixture(manifest, bytes);
      let requests = 0;
      const waits = [];
      await verifyPublishedArtifact(artifact, {
        fetchImpl: async (url, options) => {
          requests += 1;
          if (requests === 1) {
            return {
              ok: true,
              json: async () =>
                pending === 'missing tag' ? { ...remote.metadata, 'dist-tags': {} } : pending,
            };
          }
          return remote.fetchImpl(url, options);
        },
        sleepImpl: async (milliseconds) => waits.push(milliseconds),
        attempts: 2,
      });
      assert.equal(requests, 3);
      assert.deepEqual(waits, [30_000]);
    });
  }
});

test('retries temporary HTTP failures in metadata and tarball requests', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const status of [404, 429, 500, 503]) {
    for (const failRequest of [1, 2]) {
      await t.test(`HTTP ${status} at request ${failRequest}`, async (subtest) => {
        const { directory, manifest, bytes } = fixture(subtest);
        const artifact = verifyArtifact(directory, config, sourceCommit);
        const remote = registryFixture(manifest, bytes);
        let requests = 0;
        const waits = [];
        await verifyPublishedArtifact(artifact, {
          fetchImpl: async (url, options) => {
            requests += 1;
            if (requests === failRequest) return { ok: false, status };
            return remote.fetchImpl(url, options);
          },
          sleepImpl: async (milliseconds) => waits.push(milliseconds),
          attempts: 2,
        });
        assert.equal(requests, failRequest + 2);
        assert.deepEqual(waits, [30_000]);
      });
    }
  }
});

test('retries network failures and request timeouts', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const errors = [
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    }),
    new DOMException('request timed out', 'TimeoutError'),
  ];
  for (const error of errors) {
    await t.test(error.message, async (subtest) => {
      const { directory, manifest, bytes } = fixture(subtest);
      const artifact = verifyArtifact(directory, config, sourceCommit);
      const remote = registryFixture(manifest, bytes);
      let requests = 0;
      const waits = [];
      await verifyPublishedArtifact(artifact, {
        fetchImpl: async (url, options) => {
          requests += 1;
          if (requests === 1) throw error;
          return remote.fetchImpl(url, options);
        },
        sleepImpl: async (milliseconds) => waits.push(milliseconds),
        attempts: 2,
      });
      assert.equal(requests, 3);
      assert.deepEqual(waits, [30_000]);
    });
  }
});

test('fails immediately for permanent HTTP errors, invalid metadata, and redirects', async (t) => {
  const responses = [
    ...[400, 401, 403].map((status) => ({
      label: `HTTP ${status}`,
      fetchImpl: async () => ({ ok: false, status }),
    })),
    {
      label: 'invalid JSON',
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Invalid JSON');
        },
      }),
    },
    {
      label: 'redirect blocked',
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      },
    },
  ];
  for (const { label, fetchImpl } of responses) {
    await t.test(label, async (subtest) => {
      const { directory } = fixture(subtest);
      const artifact = verifyArtifact(directory, config, sourceCommit);
      let requests = 0;
      await assert.rejects(
        verifyPublishedArtifact(artifact, {
          fetchImpl: async (...args) => {
            requests += 1;
            return fetchImpl(...args);
          },
          sleepImpl: async () => assert.fail('Must not retry permanent errors'),
        }),
      );
      assert.equal(requests, 1);
    });
  }
});
