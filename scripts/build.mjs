#!/usr/bin/env node
// Emits dist/*.js from src/*.ts by stripping types, so the published CLI needs no TypeScript runtime.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { stripTypeScriptTypes } = nodeModule;
if (!stripTypeScriptTypes) {
  console.error(`build needs Node 22.13 or newer (this is ${process.version}). The output in dist/ runs on Node 20.`);
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(join(root, 'dist'), { recursive: true, force: true });
for (const file of readdirSync(join(root, 'src'), { recursive: true })) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
  const source = readFileSync(join(root, 'src', file), 'utf8');
  const out = join(root, 'dist', file.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, stripTypeScriptTypes(source).replace(/(from\s+'\.[^']*)\.ts'/g, "$1.js'"));
}
console.log('built dist/');
