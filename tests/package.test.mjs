import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function tarEntries(bytes) {
  const tar = gunzipSync(bytes), entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const read = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = read(0, 100);
    if (!name) break;
    const size = parseInt(read(124, 136).trim(), 8) || 0;
    const prefix = read(345, 500);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (header[156] === 48 || header[156] === 0) entries.set(fullName, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('local plugin declares only its own bundle and native DSH UI dependencies', () => {
  assert.equal(manifest.name, '@forst/dsh-toolkit-local');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], 'reuse installed DSH/Pi, do not install a second SDK');
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal((patch.match(/\bname:/g) ?? []).length, 3);
  assert.doesNotMatch(patch, /disabled:|browser|computer-use|cua-driver|noVNC|\/opt\//i);
  for (const name of ['opencode-go-quota', 'session-billing', 'web-search-tavily']) {
    assert(patch.includes(`name: ./plugins/${name}/index.js`));
    const component = JSON.parse(readFileSync(new URL(`../plugins/${name}/package.json`, import.meta.url)));
    assert.equal(component.dsh.client.platform, 'web');
    assert.equal(component.exports['./client'], './client.js');
    assert(component.dsh.client.inject.every(name => !/browser|cua|computer-use|desktop/i.test(name)));
  }
});

test('packed release is self-contained and excludes Linux infrastructure, browser/CUA, and fixtures', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-local-pack-'));
  try {
    const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', temp];
    const npmCli = process.env.npm_execpath;
    const result = spawnSync(npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm'), npmCli ? [npmCli, ...args] : args,
      { cwd: root, encoding: 'utf8', shell: !npmCli && process.platform === 'win32' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const [packed] = JSON.parse(result.stdout);
    assert.equal(packed.name, manifest.name);
    const entries = tarEntries(readFileSync(join(temp, packed.filename)));
    for (const name of ['index.js', 'cordis.patch.yml', 'package.json',
      'plugins/opencode-go-quota/index.js', 'plugins/opencode-go-quota/client.js', 'plugins/opencode-go-quota/package.json',
      'plugins/session-billing/index.js', 'plugins/session-billing/runtime.js', 'plugins/session-billing/projection.js', 'plugins/session-billing/client.js', 'plugins/session-billing/package.json',
      'plugins/web-search-tavily/index.js', 'plugins/web-search-tavily/client.js', 'plugins/web-search-tavily/package.json']) {
      assert(entries.has(`package/${name}`), `missing runtime file: ${name}`);
    }
    for (const [name, content] of entries) {
      assert.doesNotMatch(name, /(?:^|\/)(?:tests|fixtures|node_modules|host|integrations|\.github)(?:\/|$)/);
      assert.doesNotMatch(name, /Dockerfile|compose\.(?:ya?ml)|install-host-metrics|server-metrics/);
      if (/^package\/(?:index\.js|client\.js|plugins\/.*\.js)$/.test(name)) {
        assert.doesNotMatch(content.toString('utf8'), /\/proc\/|DSH_METRICS_URL|\/server-metrics|mountSessionMcp|cua-driver|noVNC|camoufox|Xvfb/);
      }
    }
    const packedManifest = JSON.parse(entries.get('package/package.json').toString('utf8'));
    assert.equal(packedManifest.version, manifest.version);
    assert(!packedManifest.scripts?.postinstall, 'install must not mutate existing host/browser configuration');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
