#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const expectedNode = (await readFile('.node-version', 'utf8')).trim();
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const expectedNpm = String(packageJson.packageManager ?? '').replace(/^npm@/u, '');
const actualNode = process.version.replace(/^v/u, '');
const actualNpm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();

if (actualNode !== expectedNode) {
  throw new Error(`Sotto releases require Node ${expectedNode}; running ${actualNode}.`);
}
if (!actualNpm || actualNpm !== expectedNpm) {
  throw new Error(`Sotto releases require npm ${expectedNpm}; running ${actualNpm ?? 'unknown'}.`);
}

console.log(`Toolchain verified: Node ${actualNode}, npm ${actualNpm}.`);
