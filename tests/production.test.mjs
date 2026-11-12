import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

test('Excel export dependency creates a readable workbook', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { card: 'Test card', description: 'Steam Games', type: 'purchase', category: 'Gaming', amount: 34.08 },
    { card: 'Test card', description: 'Payment Thank You-Mobile', type: 'payment', category: 'Uncategorized', amount: -220 },
  ]), 'Transactions');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const restored = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(restored.Sheets.Transactions), [
    { card: 'Test card', description: 'Steam Games', type: 'purchase', category: 'Gaming', amount: 34.08 },
    { card: 'Test card', description: 'Payment Thank You-Mobile', type: 'payment', category: 'Uncategorized', amount: -220 },
  ]);
});

test('ZIP backup dependency round-trips JSON and a PDF blob payload', async () => {
  const zip = new JSZip();
  const data = { categories: ['Groceries', 'Gaming', 'Uncategorized'], merchantRules: [{ merchantKey: 'STEAMGAMES', category: 'Gaming', cardId: null }] };
  zip.file('cardvault.json', JSON.stringify({ version: 1, data }));
  zip.file('statements/test/2026-10-31.pdf', Buffer.from('%PDF fictional test'));
  const archive = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  const restored = JSON.parse(await archive.file('cardvault.json').async('text'));
  assert.equal(restored.version, 1);
  assert.deepEqual(restored.data.categories, data.categories);
  assert.deepEqual(restored.data.merchantRules, data.merchantRules);
  assert.equal(await archive.file('statements/test/2026-10-31.pdf').async('text'), '%PDF fictional test');
});

test('production output contains index, referenced JS/CSS, and bundled PDF worker', { skip: !existsSync(join(dist, 'index.html')) }, () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(html, /<div id="root"><\/div>/);
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(refs.some(path => path.endsWith('.js')), 'index.html has a JS asset reference');
  assert.ok(refs.some(path => path.endsWith('.css')), 'index.html has a CSS asset reference');
  for (const ref of refs) assert.ok(existsSync(join(dist, ref.slice(1))), `${ref} exists in dist`);
  assert.ok(readdirAssets().some(file => /^pdf\.worker.*\.mjs$/.test(file)), 'PDF.js worker is bundled in dist/assets');
});

test('Netlify config uses the Vite output and SPA fallback', () => {
  const config = readFileSync(join(root, 'netlify.toml'), 'utf8');
  assert.match(config, /command\s*=\s*"npm run build"/);
  assert.match(config, /publish\s*=\s*"dist"/);
  assert.match(config, /from\s*=\s*"\/\*"[\s\S]*to\s*=\s*"\/index\.html"[\s\S]*status\s*=\s*200/);
});

function readdirAssets() {
  return readdirSync(join(dist, 'assets'));
}
