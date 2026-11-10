import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', '__pycache__', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(m?js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `检查失败：${path}`);
      checked++;
    } else if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'));
  }
}
walk(root);
const build = spawnSync(process.execPath, [join(root, 'scripts/build-client.mjs'), '--check'], { encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr || build.error?.message || '客户端构建校验失败。');
console.log(`语法、JSON 与构建一致性检查通过：${checked} 个 JavaScript 文件。`);
