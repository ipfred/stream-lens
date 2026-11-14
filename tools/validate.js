#!/usr/bin/env node
/**
 * Validates the extension without launching Chrome.
 *
 * Checks:
 *   1. manifest.json parses, is MV3, permissions are exactly ["storage","activeTab"],
 *      minimum_chrome_version is at least 111, content scripts set match_about_blank.
 *   2. Every file referenced by the manifest exists (service worker, popup,
 *      icons, content script js files). Icons must be valid PNGs of the
 *      declared size.
 *   3. content_scripts match PRD section 3 (all_frames, world, run_at, js order).
 *   4. `node --check` passes for every .js file in the extension directory.
 *
 * Exits with status 1 and a list of problems on failure.
 *
 * Usage: node tools/validate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function requireFile(rel, what) {
  if (typeof rel !== 'string' || !rel) {
    fail(`${what}: path is missing in manifest`);
    return false;
  }
  if (!exists(rel)) {
    fail(`${what}: file not found: ${rel}`);
    return false;
  }
  return true;
}

function checkPng(rel, size) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    fail(`${rel}: not a valid PNG`);
    return;
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== size || h !== size) fail(`${rel}: expected ${size}x${size}, got ${w}x${h}`);
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function sameArray(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function validateManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  } catch (e) {
    fail(`manifest.json cannot be read or parsed: ${e.message}`);
    return;
  }

  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (!manifest.name) fail('manifest name is missing');
  if (!manifest.version) fail('manifest version is missing');
  if (!sameArray(manifest.permissions, ['storage', 'activeTab'])) {
    fail(`permissions must be exactly ["storage","activeTab"], got ${JSON.stringify(manifest.permissions)}`);
  }
  if (manifest.host_permissions) fail('host_permissions must not be declared');
  // content_scripts[].world needs Chrome 111; setBadgeTextColor needs 110; storage.session needs 102.
  if (Number(manifest.minimum_chrome_version) < 111) {
    fail(`minimum_chrome_version must be at least "111", got ${JSON.stringify(manifest.minimum_chrome_version)}`);
  }

  // Background, popup, icons
  requireFile(manifest.background && manifest.background.service_worker, 'background.service_worker');
  const action = manifest.action || {};
  requireFile(action.default_popup, 'action.default_popup');
  for (const size of ['16', '48', '128']) {
    const actionIcon = action.default_icon && action.default_icon[size];
    const topIcon = manifest.icons && manifest.icons[size];
    for (const [label, rel] of [['action.default_icon', actionIcon], ['icons', topIcon]]) {
      if (requireFile(rel, `${label}[${size}]`)) checkPng(rel, Number(size));
    }
  }

  // Commands
  const cmd = manifest.commands && manifest.commands['toggle-osd'];
  if (!cmd) fail('commands.toggle-osd is missing');
  else if (!cmd.suggested_key || cmd.suggested_key.default !== 'Alt+Shift+V') {
    fail('commands.toggle-osd.suggested_key.default must be Alt+Shift+V');
  }

  // Content scripts
  const cs = manifest.content_scripts;
  if (!Array.isArray(cs) || cs.length !== 2) {
    fail('content_scripts must contain exactly two entries');
    return;
  }
  const expected = [
    { js: ['content_main.js'], run_at: 'document_start', world: 'MAIN' },
    { js: ['utils/quality_evaluator.js', 'content_isolated.js'], run_at: 'document_idle', world: 'ISOLATED' },
  ];
  cs.forEach((entry, i) => {
    const want = expected[i];
    const tag = `content_scripts[${i}]`;
    if (!sameArray(entry.matches, ['<all_urls>'])) fail(`${tag}.matches must be ["<all_urls>"]`);
    if (entry.all_frames !== true) fail(`${tag}.all_frames must be true`);
    if (entry.match_about_blank !== true) fail(`${tag}.match_about_blank must be true`);
    if (entry.run_at !== want.run_at) fail(`${tag}.run_at must be ${want.run_at}`);
    if (entry.world !== want.world) fail(`${tag}.world must be ${want.world}`);
    if (!sameArray(entry.js, want.js)) fail(`${tag}.js must be ${JSON.stringify(want.js)}`);
    (entry.js || []).forEach((rel) => requireFile(rel, `${tag}.js`));
  });
}

function syntaxCheck() {
  for (const file of listJsFiles(ROOT)) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      fail(`syntax error in ${path.relative(ROOT, file)}:\n${(res.stderr || '').trim()}`);
    }
  }
}

validateManifest();
syntaxCheck();

if (errors.length) {
  console.error(`Validation failed with ${errors.length} problem(s):`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log('Validation passed.');
