import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const source = resolve(root, 'edge-functions');
const target = resolve(root, 'dist', 'edge-functions');

if (existsSync(source)) {
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await rm(target, { force: true, recursive: true });
  await cp(source, target, { recursive: true });
  console.log('Copied edge-functions/ into dist/edge-functions/');
}
