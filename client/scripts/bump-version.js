#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionFile = join(__dirname, '../src/version.js');

const content = readFileSync(versionFile, 'utf8');
const match = content.match(/VERSION = '(\d+)\.(\d+)\.(\d{2})'/);
if (!match) {
  console.error('Could not parse version in', versionFile);
  process.exit(1);
}

let major = parseInt(match[1]);
let minor = parseInt(match[2]);
let patch = parseInt(match[3]);

patch++;
if (patch > 99) { patch = 0; minor++; }

const next = `${major}.${minor}.${String(patch).padStart(2, '0')}`;
writeFileSync(versionFile, `export const VERSION = '${next}';\n`);
console.log(`v${match[1]}.${match[2]}.${match[3]} → v${next}`);
