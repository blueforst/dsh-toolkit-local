/**
 * Isolated native acceptance. Run from the toolkit package directory.
 * Requires Node 24+, pnpm on PATH, DSH 0.2.2-alpha.2, and (unless --api-only or --install-only)
 * Playwright with an installed Chromium. No user profile or model credential is used.
 *
 * Optional environment: DSH_CLI_PATH, DSH_PACKAGE_DIR, DSH_PACKAGE_TGZ,
 * DSH_ACCEPTANCE_OUTPUT, PLAYWRIGHT_MODULE, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
 * DSH_PACKAGE_TGZ avoids packing; otherwise npm pack runs in DSH_PACKAGE_DIR/cwd.
 * --api-only explicitly skips the UI; it never reports browser checks as passed.
 * --install-only tests only install/start/auth/uninstall, not session or UI behavior.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const packageName = '@forst/dsh-toolkit-local';
const packageRoot = resolve(process.env.DSH_PACKAGE_DIR ?? process.cwd());
const cli = resolve(process.env.DSH_CLI_PATH ?? join(packageRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
const output = process.env.DSH_ACCEPTANCE_OUTPUT
  ? resolve(process.env.DSH_ACCEPTANCE_OUTPUT)
  : mkdtempSync(join(tmpdir(), 'dsh-local-acceptance-'));
mkdirSync(output, { recursive: true });
const dshHome = mkdtempSync(join(output, 'dsh-home-'));
const workspace = join(dshHome, 'test-workspace');
mkdirSync(workspace);
const apiOnly = process.argv.includes('--api-only');
const installOnly = process.argv.includes('--install-only');
assert(!(apiOnly && installOnly), 'Choose either --api-only or --install-only, not both');
const env = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: 'DISABLED' };
for (const key of Object.keys(env)) {
  if (/API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|MODEL_KEY/.test(key)) delete env[key];
}
env.DSH_TEST_MODEL_KEY = 'isolated-fixture-only';
delete env.OPENCODE_GO_API_KEY;
const manifestPath = join(dshHome, 'profiles/web/package.json');
const patchPath = join(dshHome, 'profiles/web/cordis.patch.yml');
const overlay = join(output, 'fixture.patch.yml');
const result = {
  status: 'running', package: packageName,
  scope: installOnly ? 'install-smoke' : apiOnly ? 'native-session-api' : 'native-session-ui',
  ui: installOnly ? 'not-run-install-only' : apiOnly ? 'not-run-api-only' : 'pending', checks: {},
};
let installed = false, fixture, dsh, browser, page, bootstrap, base, cookie;
let baselineManifest, baselinePatch;
let logs = '', completions = 0;
const frontendErrors = [];
const redact = value => String(value).replace(/token=[^\s&]+/g, 'token=REDACTED');
const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'));
const readPatch = () => existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null;

async function run(command, args, cwd = packageRoot) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  if (code !== 0) throw new Error(`${command} ${args.map(a => String(a).includes('token=') ? '[redacted]' : a).join(' ')} failed (${code})\n${redact(stdout + stderr)}`);
  return stdout;
}

async function stopDSH() {
  if (!dsh) return;
  dsh.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  while (dsh.exitCode === null && dsh.signalCode === null && Date.now() < deadline) await delay(100);
  if (dsh.exitCode === null && dsh.signalCode === null) dsh.kill('SIGKILL');
  dsh = undefined;
}

async function startDSH() {
  let bootLog = '';
  bootstrap = undefined;
  dsh = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
  });
  dsh.stdout.on('data', b => { logs += b; bootLog += b; });
  dsh.stderr.on('data', b => { logs += b; bootLog += b; });
  const until = Date.now() + 60000;
  while (!bootstrap && Date.now() < until) {
    bootstrap = bootLog.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]*token=[^\s\u001b]+/)?.[0];
    if (dsh.exitCode !== null || dsh.signalCode !== null) throw new Error('DSH terminated before serving: ' + redact(bootLog));
    if (!bootstrap) await delay(200);
  }
  if (!bootstrap) throw new Error('DSH bootstrap URL was not reported in 60s');
  bootstrap = bootstrap.replace(/[)\]\"']+$/, '');
  base = new URL(bootstrap).origin;
  const response = await fetch(bootstrap, { redirect: 'manual' });
  assert.equal(response.status, 303);
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'Native bootstrap did not issue a cookie');
  console.log(JSON.stringify({ phase: 'web-started', host: base, credential: 'not printed' }));
}

async function rpc(method, request) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `${method}: ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.result.ok, true, `${method}: ${JSON.stringify(envelope.result.error)}`);
  return envelope.result.value;
}

try {
  assert(existsSync(cli), `DSH CLI not found; set DSH_CLI_PATH: ${cli}`);
  const runtimeManifest = JSON.parse(readFileSync(join(dirname(dirname(cli)), 'package.json'), 'utf8'));
  assert.equal(runtimeManifest.version, '0.2.2-alpha.2', 'Acceptance fixtures target this explicit DSH version');
  result.runtime = { dsh: runtimeManifest.version, node: process.version };
  await run(process.execPath, [cli, 'web', '--dump-config']);
  baselineManifest = readManifest();
  baselinePatch = readPatch();

  let tgz = process.env.DSH_PACKAGE_TGZ && resolve(process.env.DSH_PACKAGE_TGZ);
  if (!tgz) {
    const packOutput = await run('npm', ['pack', '--json', '--pack-destination', output]);
    // npm lifecycle scripts may write stdout before the JSON pack result.
    const jsonStart = packOutput.lastIndexOf('\n[');
    const packed = JSON.parse(jsonStart < 0 ? packOutput : packOutput.slice(jsonStart + 1));
    tgz = join(output, packed[0].filename);
  }
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '--ignore-scripts', '--save-exact', tgz]);
  installed = true;
  const installedManifest = readManifest();
  assert.deepEqual(installedManifest.dsh.profile.bundles, [...baselineManifest.dsh.profile.bundles, packageName]);
  assert.deepEqual(Object.keys(installedManifest.dependencies ?? {}).filter(k => !(k in (baselineManifest.dependencies ?? {}))), [packageName]);
  assert.equal(readPatch(), baselinePatch, 'Installation altered native profile overrides');
  result.checks.nativeInstall = true;
  result.checks.onlyLocalBundleAdded = true;
  result.checks.nativeBrowserCuaOverridesUnchanged = true;

  fixture = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404); return res.end();
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    if (payload.model !== 'deepseek-v4.1-flash') {
      res.writeHead(400); return res.end('unexpected test model');
    }
    completions++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunkBase = { id: 'local-fixture-' + completions, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model };
    const send = chunk => res.write('data: ' + JSON.stringify({ ...chunkBase, ...chunk }) + '\n\n');
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: '工具包隔离验收通过。' }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11000, completion_tokens: 200, total_tokens: 11200, prompt_tokens_details: { cached_tokens: 10000 } } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
  const fixturePort = fixture.address().port;
  writeFileSync(overlay, `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: Isolated fixture\n        apiKeyEnv: DSH_TEST_MODEL_KEY\n        api: openai-completions\n        baseURL: http://127.0.0.1:${fixturePort}/v1\n        compat:\n          supportsStore: false\n          supportsDeveloperRole: false\n          supportsUsageInStreaming: true\n          maxTokensField: max_tokens\n        models:\n          - id: deepseek-v4.1-flash\n            name: Isolated fixture\n            input: [text]\n            contextWindow: 1000000\n            maxTokens: 4096\n            reasoningEfforts: false\n- id: agent-default-model\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n- id: session-title-llm\n  disabled: true\n`);

  await startDSH();
  assert.equal((await fetch(base + '/opencode-go-quota')).status, 401);
  result.checks.unauthenticated401 = true;
  assert.equal((await fetch(base + '/opencode-go-quota', { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } })).status, 403);
  result.checks.untrustedOrigin403 = true;
  assert.equal((await fetch(base + '/opencode-go-quota', { headers: { Cookie: cookie, Origin: base } })).status, 503);
  result.checks.quotaMissingKey503 = true;

  if (!installOnly) {
  const charged = await rpc('session/create', { cwd: workspace });
  await rpc('session/prompt', { sessionId: charged.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'local toolkit isolated acceptance' }] });
  let projection;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    projection = await rpc('session/projections', { sessionId: charged.sessionId });
    if (projection?.values?.forstSessionCost?.pricedCalls === 1) break;
    await delay(250);
  }
  const charge = projection?.values?.forstSessionCost;
  assert(charge, 'Native session did not produce the local billing projection');
  assert.equal(charge.pricedCalls, 1, JSON.stringify(charge));
  assert.equal(charge.unpricedCalls, 0);
  assert(Math.abs(charge.usd - .0003) < 1e-12, `Unexpected real session cost ${charge.usd}`);
  assert.equal(completions, 1);
  result.checks.realSessionCost = charge;
  const blank = await rpc('session/create', { cwd: workspace });
  assert.notEqual(blank.sessionId, charged.sessionId);
  const blankProjection = await rpc('session/projections', { sessionId: blank.sessionId });
  assert.equal(blankProjection.values.forstSessionCost.usd, 0);
  const restored = await rpc('session/projections', { sessionId: charged.sessionId });
  assert.deepEqual(restored.values.forstSessionCost, charge);
  result.checks.separateSessionProjections = true;
  await stopDSH();
  await startDSH();
  const replayed = await rpc('session/projections', { sessionId: charged.sessionId });
  assert.deepEqual(replayed.values.forstSessionCost, charge);
  result.checks.processRestartRestoredProjection = true;

  if (!apiOnly) {
    const pwModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
    const { chromium } = await import(isAbsolute(pwModule) ? pathToFileURL(pwModule).href : pwModule);
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      });
    } catch (error) {
      result.ui = 'blocked-browser-launch';
      throw error;
    }
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', error => frontendErrors.push(error.message));
    assert.equal((await page.goto(bootstrap, { waitUntil: 'domcontentloaded' })).status(), 200);
    const continueButton = page.getByRole('button', { name: '继续', exact: true });
    if (await continueButton.isVisible()) await continueButton.click();
    await page.locator('[data-dsh-opencode-go-quota][data-state="unavailable"]').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-dsh-server-metrics]').count(), 0);
    await page.screenshot({ path: join(output, 'local-home.png'), fullPage: true });
    const create = page.getByRole('button', { name: '新建会话', exact: true }).first();
    await create.click();
    const editor = page.locator('[contenteditable="true"][role="textbox"]');
    await editor.click();
    await editor.pressSequentially('local toolkit isolated acceptance');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('p:visible').filter({ hasText: /^工具包隔离验收通过。$/ }).last().waitFor({ timeout: 45000 });
    const cost = page.locator('[data-dsh-session-cost]');
    await cost.waitFor({ timeout: 15000 });
    const usd = Number(await cost.getAttribute('data-usd'));
    assert(Math.abs(usd - .0003) < 1e-12, `unexpected UI cost ${usd}`);
    const activity = page.locator('[data-composer-stat="activity"]');
    assert((await cost.boundingBox()).x < (await activity.boundingBox()).x);
    await cost.getByRole('button').click();
    const panel = page.getByRole('dialog', { name: '会话费用', exact: true });
    await panel.waitFor();
    assert.deepEqual(await panel.locator('dt').allTextContents(), ['输入', '输出', '缓存读']);
    assert.equal(await panel.locator('[data-cost-bucket="cacheWriteUsd"]').count(), 0);
    await page.screenshot({ path: join(output, 'local-billing.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    const chargedURL = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await cost.waitFor({ timeout: 30000 });
    assert.equal(Number(await cost.getAttribute('data-usd')), usd);
    await page.setViewportSize({ width: 430, height: 932 });
    await cost.getByRole('button').click();
    await panel.waitFor();
    const bounds = await panel.boundingBox();
    assert(bounds.x >= 11 && bounds.x + bounds.width <= 419, 'billing popover is out of narrow viewport');
    await page.screenshot({ path: join(output, 'local-narrow.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await create.click();
    await cost.waitFor({ state: 'hidden' });
    await page.goto(chargedURL, { waitUntil: 'domcontentloaded' });
    await cost.waitFor({ timeout: 30000 });
    assert.equal(Number(await cost.getAttribute('data-usd')), usd);
    assert.deepEqual(frontendErrors, []);
    assert.equal(completions, 2);
    result.ui = 'passed';
    result.checks.ui = { serverMetricsAbsent: true, costLabels: ['输入', '输出', '缓存读'], firstInStatsRow: true, reloadRestored: true, sessionSwitchRestored: true, narrowViewport: true, frontendErrors };
  }
  }
  result.status = installOnly ? 'passed' : apiOnly ? 'api-passed-ui-not-run' : 'passed';
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(join(output, 'failure.html'), redact(await page.content().catch(() => '')));
  }
  result.status = 'failed';
  if (result.ui === 'pending') result.ui = page ? 'failed' : 'not-run-before-ui';
  result.error = redact(error.stack);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopDSH();
  if (fixture) await new Promise(resolveClose => fixture.close(resolveClose));
  if (installed) {
    try {
      await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', packageName]);
      const removed = readManifest();
      assert.deepEqual(removed.dsh.profile.bundles, baselineManifest.dsh.profile.bundles);
      assert(!Object.hasOwn(removed.dependencies ?? {}, packageName));
      assert.equal(readPatch(), baselinePatch, 'Uninstall altered native profile overrides');
      result.checks.nativeUninstall = true;
      result.checks.nativeBrowserCuaOverridesUnchangedAfterUninstall = true;
    } catch (error) {
      result.status = 'failed';
      result.uninstallError = redact(error.stack);
      process.exitCode = 1;
    }
  }
  result.fixtureModelCalls = completions;
  writeFileSync(join(output, 'dsh.log'), redact(logs));
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(JSON.stringify({ evidenceDirectory: output }));
}
