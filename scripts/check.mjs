import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

let count = 0;
for (const directory of ['bin', 'src', 'public', 'scripts', 'tests']) {
  for (const file of await readdir(directory)) {
    if (/\.(mjs|js)$/.test(file)) {
      execFileSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
      count += 1;
    }
  }
}
console.log(`Syntax checked ${count} JavaScript files.`);
