#!/usr/bin/env node
/**
 * Packages the Roku channel as a sideloadable ZIP, after checking the mistakes that
 * the device would otherwise report as something unhelpful.
 *
 * A Roku channel is a ZIP with `manifest` at the ROOT -- not inside a folder. That is
 * the most common packaging error, and the installer rejects it with a bare "manifest
 * not found", which reads like a broken build rather than a zip one level too deep.
 *
 * A plain ZIP is deliberate, not a shortcut: a .pkg needs Roku's branded SDK, which is
 * only required to PUBLISH. Developer Mode sideloads a plain ZIP, so the whole loop
 * (write, upload, debug over telnet 8085) needs nothing installed and no Roku account.
 *
 * Usage: node scripts/build-roku.mjs [--out roku.zip]
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'roku');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const red = s => `\x1b[31m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

const problems = [];
const check = (name, ok, detail) => {
  if (ok) console.log(`${green('ok')}    ${name}`);
  else { console.log(`${red('MISS')}  ${name}${detail ? dim('  ' + detail) : ''}`); problems.push(name); }
};

console.log(dim('checking the Roku channel\n'));

// --- manifest ---
const template = await readFile(path.join(srcDir, 'manifest.template'), 'utf8');
const keys = template.split('\n')
  .filter(l => l.trim() && !l.trim().startsWith('#'))
  .map(l => l.split('=')[0].trim());
// Roku refuses to install without all five. Each has its own error message, so checking
// here is faster than five round trips through the device.
for (const k of ['title', 'major_version', 'minor_version', 'build_version', 'compilation_version']) {
  check(`manifest has ${k}`, keys.includes(k));
}

const brs = (await readdir(path.join(srcDir, 'source'))).filter(f => f.endsWith('.brs'));
const xml = (await readdir(path.join(srcDir, 'components'))).filter(f => f.endsWith('.xml'));
check('entry point exists (source/main.brs)', brs.includes('main.brs'));
check('at least one screen', xml.length > 0, xml.join(', '));

// --- screens pushed must exist ---
// A screen with no component dies at the push, after the app has already booted, which
// on a TV looks like the app hanging with no error on screen.
const mainSrc = await readFile(path.join(srcDir, 'source', 'main.brs'), 'utf8');
const pushed = [...mainSrc.matchAll(/PushScreen\("(\w+)"/g)].map(m => m[1]);
const components = xml.map(f => path.basename(f, '.xml'));
const absent = pushed.filter(s => !components.includes(s));
check('every pushed screen has a component', absent.length === 0,
  absent.length ? `missing: ${absent.join(', ')}` : `${pushed.length} pushed`);

// --- referenced scripts must exist ---
// A pkg:/ script that is not in the ZIP means that scene's init() never runs, so the
// screen appears empty and unresponsive rather than reporting anything.
for (const f of xml) {
  const text = await readFile(path.join(srcDir, 'components', f), 'utf8');
  for (const m of text.matchAll(/uri="pkg:\/([^"]+)"/g)) {
    try { await stat(path.join(srcDir, m[1])); check(`${f} → ${m[1]}`, true); }
    catch { check(`${f} → ${m[1]}`, false, 'not in the channel'); }
  }
}

// --- balanced blocks ---
// An unclosed Sub is the most common BrightScript error, and the device reports it as a
// runtime failure much later rather than at the point of the mistake.
for (const f of brs) {
  const text = await readFile(path.join(srcDir, 'source', f), 'utf8');
  const opens = (text.match(/^\s*(Sub|Function)\s+\w+/gim) || []).length;
  const closes = (text.match(/^\s*End\s+(Sub|Function)/gim) || []).length;
  check(`${f} blocks balanced`, opens === closes, `${opens} open, ${closes} close`);
}

if (problems.length) {
  console.log(`\n${red(`FAILED: ${problems.length} problem(s)`)}`);
  for (const p of problems) console.log(`  x ${p}`);
  process.exit(1);
}

// --- build ---
// Uses the system `zip` rather than a dependency: this runs on the developer's Mac,
// and adding a zip library for a 40-line job is not worth it.
const outPath = path.resolve(root, argOf('out', 'roku.zip'));
await rm(outPath, { force: true });
const manifest = template.replace(/build_version=\d+/, `build_version=${Date.now().toString().slice(-6)}`);
await (await import('node:fs/promises')).writeFile(path.join(srcDir, 'manifest'), manifest, 'utf8');

const dirs = ['manifest', 'source', 'components'];
try { await stat(path.join(srcDir, 'images')); dirs.push('images'); } catch { /* optional */ }
execFileSync('zip', ['-r', '-X', '-q', outPath, ...dirs], { cwd: srcDir });

console.log('');
console.log(green(`built ${path.relative(root, outPath)}`));
console.log(`  manifest at ZIP root: ${green('yes')}`);
console.log(`  entries: ${execFileSync('unzip', ['-Z1', outPath], { encoding: 'utf8' }).trim().split('\n').length}`);
console.log('');
console.log('Install:');
console.log(dim('  1. Remote: Home x3, Up x2, Right, Left, Right, Left, Right'));
console.log(dim('  2. Accept the SDK licence, set a web server password, enable installer, restart'));
console.log(dim('  3. Open http://<device-ip>, sign in as rokudev, upload the zip'));
console.log(dim('  4. Watch it run: telnet <device-ip> 8085'));
console.log(dim('  5. Set your server address in Settings (LAN IP — never localhost)'));
process.exit(0);