#!/usr/bin/env node
// Usage: node scripts/render-demo.mjs   Writes docs/demo-1.svg and docs/demo-2.svg from the made-up logs in demo.mjs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const demo = fileURLToPath(new URL('./demo.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [demo, ...args], { encoding: 'utf8' }).stdout.trimEnd().split('\n');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const COLUMNS = 80;
const ROWS = 17;
const CHAR = 8.43;
const LINE = 19;
const width = Math.ceil(COLUMNS * CHAR + 32);
const height = ROWS * LINE + 56;

function frame(command, output) {
  const lines = [`$ ${command}`, ...output].slice(0, ROWS);
  const text = lines
    .map((line, i) => `<text x="16" y="${52 + i * LINE}" fill="${i === 0 ? '#9ece6a' : '#c0caf5'}" xml:space="preserve">${escape(line)}</text>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" rx="8" fill="#1a1b26"/>
<circle cx="18" cy="16" r="5" fill="#f7768e"/><circle cx="36" cy="16" r="5" fill="#e0af68"/><circle cx="54" cy="16" r="5" fill="#9ece6a"/>
<g font-family="ui-monospace, Menlo, Consolas, monospace" font-size="14">
${text}
</g>
</svg>
`;
}

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
mkdirSync(docs, { recursive: true });
writeFileSync(`${docs}demo-1.svg`, frame('costlog by model', run('by', 'model')));
writeFileSync(`${docs}demo-2.svg`, frame('costlog windows', run('windows')));
console.log('wrote docs/demo-1.svg and docs/demo-2.svg');
