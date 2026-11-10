import { createRequire, findPackageJSON } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 从当前 DSH 进程定位它实际使用的 Pi，避免再安装一份 SDK 或复制价格表。
export async function loadRuntime(entrypoint = process.argv[1]) {
  const host = createRequire(entrypoint);
  const adapter = host.resolve('@deepseek-ai/dsh-llm-pi-ai');
  const manifestURL = pathToFileURL(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(adapter)));
  const manifest = JSON.parse(readFileSync(manifestURL, 'utf8'));
  const models = await import(new URL(manifest.exports['./models'].import, manifestURL).href);
  const catalog = await import(new URL('./providers/all.js', new URL(manifest.exports['./models'].import, manifestURL)).href);
  const { z } = host('zod');
  return { calculateCost: models.calculateCost, getBuiltinModels: catalog.getBuiltinModels, z, version: manifest.version };
}
