import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

let count = 0;
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(path);
    } else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) {
      execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      count += 1;
    }
  }
}
for (const directory of ['bin', 'src', 'public', 'scripts', 'tests']) {
  await checkDirectory(directory);
}
console.log(`Syntax checked ${count} JavaScript files.`);
