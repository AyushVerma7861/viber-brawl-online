/* =============================================================================
   build-client.mjs — assembles `public/viber-brawl-multiplayer.html`.

   The original game file is treated as READ-ONLY input. This script only ever
   ADDS three things to a copy of it:

     1. a <style> block (multiplayer UI)
     2. the multiplayer screen markup, injected before the loader
     3. a <script> block (the multiplayer client layer), appended after the
        original game script so it shares the original top-level bindings

   It then asserts that every byte of the original <script> body survives
   untouched, so a build can never silently break solo play.

   Usage:  node build-client.mjs
   ============================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ORIGINAL = path.join(ROOT, 'public', 'viber-brawl-v6-original.html');
const OUT = path.join(ROOT, 'public', 'viber-brawl-multiplayer.html');
const CSS = path.join(ROOT, 'multiplayer', 'client', 'mp.css');
const UI = path.join(ROOT, 'multiplayer', 'client', 'mp-ui.html');
const ACCOUNT = path.join(ROOT, 'multiplayer', 'client', 'mp-account.js');
const PROFILE = path.join(ROOT, 'multiplayer', 'client', 'mp-profile.js');
const LAYER = path.join(ROOT, 'multiplayer', 'client', 'mp-layer.js');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');

const src = read(ORIGINAL);
const css = read(CSS);
const ui = read(UI);
const account = read(ACCOUNT);
const profile = read(PROFILE);
const layer = read(LAYER);

const ORIGINAL_HASH = md5(src);

/* ---------------------------------------------------------------- inject -- */

/* 1. styles: a second <style> block, right before </head>. Appending rather
      than editing means no original rule can be altered. */
let out = src.replace(
  '</head>',
  '\n<style id="vb-multiplayer-styles">\n' + css + '\n</style>\n</head>'
);

/* 2. screens: inserted just before the loader element. */
const loaderAnchor = '<div id="loader"';
if (out.indexOf(loaderAnchor) === -1) throw new Error('loader anchor not found');
out = out.replace(
  loaderAnchor,
  '<!-- ================= MULTIPLAYER (added by build-client.mjs) ================= -->\n' +
  ui + '\n' + loaderAnchor
);

/* 3. the client layer: classic <script>s AFTER the original script, so they can
      read the original top-level `const`/`let`/`class`/`function` bindings.
      Order matters: the account module installs `window.__VB_ACCOUNT` and the
      multiplayer layer uses it, so the account module comes first. */
const clientScripts =
  '<!-- ============ MULTIPLAYER CLIENT LAYER (added by build-client.mjs) ============ -->\n' +
  '<script id="vb-account-layer">\n' + account + '\n</script>\n' +
  '<script id="vb-profile-layer">\n' + profile + '\n</script>\n' +
  '<script id="vb-multiplayer-layer">\n' + layer + '\n</script>\n';

const scriptClose = '</script>\n\n\n\n</body></html>';
let injected = false;
if (out.indexOf(scriptClose) !== -1) {
  out = out.replace(scriptClose, '</script>\n\n' + clientScripts + '\n</body></html>');
  injected = true;
}
if (!injected) {
  /* tolerate whitespace differences in the original tail */
  const alt = out.lastIndexOf('</script>');
  if (alt === -1) throw new Error('could not find the original script close tag');
  out = out.slice(0, alt + '</script>'.length) + '\n\n' + clientScripts +
    out.slice(alt + '</script>'.length);
}

/* --------------------------------------------------------------- verify --- */

/* The original body must still be present, verbatim, in the output. */
const originalScriptStart = src.indexOf('<script>\nconst clamp=');
const originalScriptEnd = src.lastIndexOf('})();\n</script>');
const originalScript = src.slice(originalScriptStart, originalScriptEnd + '})();'.length);
const survived = out.indexOf(originalScript) !== -1;

/* The original file on disk must be untouched. */
const stillOriginal = md5(read(ORIGINAL)) === ORIGINAL_HASH;

/* Solo-only code paths must not have been rewritten. */
const soloChecks = [
  ['solo AI control', 'function aiControl(f,dt){'],
  ['solo match start', "document.getElementById('btnFight').addEventListener('click'"],
  ['tutorial', 'const Tutorial={'],
  ['onboarding', 'const Onboard = {'],
  ['results screen', "document.getElementById('btnRematch').addEventListener('click'"],
  ['pause', 'function togglePause(){'],
  ['touch controls', 'function setupTouch(){'],
  ['music', 'const Music={'],
  ['camera', 'function updateCamera(dt){'],
  ['character defs', "const CHARACTERS=["],
  ['arena build', 'function buildArena(){'],
  ['hazards', 'function buildHazards(){'],
  ['powerups', 'function spawnPowerup(){'],
  ['viber models', 'function buildViber(def){'],
  ['solo stepFighter', 'function stepFighter(f,dt,ctrl){']
];
const missing = soloChecks.filter(([, needle]) => out.indexOf(needle) === -1).map(([name]) => name);

fs.writeFileSync(OUT, out, 'utf8');

/* ---------------------------------------------------------------- report -- */
const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
console.log('');
console.log('Viber Brawl — multiplayer client build');
console.log('─'.repeat(64));
console.log('  input    public/viber-brawl-v6-original.html   ' + kb(src) + '   md5 ' + ORIGINAL_HASH.slice(0, 12));
console.log('  + css    multiplayer/client/mp.css             ' + kb(css));
console.log('  + html   multiplayer/client/mp-ui.html         ' + kb(ui));
console.log('  + js     multiplayer/client/mp-account.js      ' + kb(account));
console.log('  + js     multiplayer/client/mp-profile.js      ' + kb(profile));
console.log('  + js     multiplayer/client/mp-layer.js        ' + kb(layer));
console.log('  = out    public/viber-brawl-multiplayer.html   ' + kb(out));
console.log('─'.repeat(64));
console.log('  original script preserved verbatim : ' + (survived ? 'YES' : 'NO  <-- PROBLEM'));
console.log('  original file on disk untouched    : ' + (stillOriginal ? 'YES' : 'NO  <-- PROBLEM'));
console.log('  solo systems still present         : ' + (missing.length === 0 ? 'ALL ' + soloChecks.length : 'MISSING ' + missing.join(', ')));
console.log('─'.repeat(64));
console.log('');

if (!survived || !stillOriginal || missing.length) {
  console.error('BUILD FAILED verification.');
  process.exit(1);
}
console.log('Build OK — solo play is byte-identical, multiplayer is additive only.\n');
