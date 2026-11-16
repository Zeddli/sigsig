// Prerender the landing into dist/index.html (so it reads with scripts off and for the share card), and copy the
// SPA shell to each known app route, so the static build serves them on any host (and in the taste-skill checks)
// even where public/_redirects is not read.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const ssr = resolve(here, '../dist-ssr/entry-server.js');

const { render } = await import(pathToFileURL(ssr).href);
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
const body = render('/');
await writeFile(resolve(dist, 'index.html'), html.replace('<!--app-html-->', body));

const shell = await readFile(resolve(dist, 'app.html'), 'utf8');
const routes = [
  'keeper', 'new',
  'vaults/ops-treasury', 'vaults/ops-treasury/pay',
  'vaults/grants-dao', 'vaults/fund-reserve', 'vaults/builders-guild',
  'sign/demo-payroll', 'sign/demo-unknown',
];
for (const r of routes) {
  const file = resolve(dist, r, 'index.html');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, shell);
}
await rm(resolve(here, '../dist-ssr'), { recursive: true, force: true });
console.log(`prerender: landing ${(body.length / 1024).toFixed(1)} kB, ${routes.length} app routes`);
