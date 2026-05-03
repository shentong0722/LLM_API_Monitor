import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const dist = resolve(root, 'dist');
const directories = ['cloud-functions', 'shared'];

await mkdir(dist, { recursive: true });

for (const directory of directories) {
  const source = resolve(root, directory);
  const target = resolve(dist, directory);

  if (existsSync(source)) {
    await rm(target, { force: true, recursive: true });
    await cp(source, target, { recursive: true });
    console.log(`Copied ${directory}/ into dist/${directory}/`);
  }
}
