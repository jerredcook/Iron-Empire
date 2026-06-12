/**
 * Poly Haven CC0 asset fetcher.
 *   node tools/fetch-assets.mjs model <slug> <res>     -> public/assets/models/<slug>/
 *   node tools/fetch-assets.mjs texture <slug> <res> <maps...> -> public/assets/textures/<slug>/
 *   node tools/fetch-assets.mjs hdri <slug> <res>      -> public/assets/hdri/<slug>_<res>.hdr
 * Skips files that already exist with the right size.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [, , kind, slug, res = '1k', ...maps] = process.argv;
if (!kind || !slug) {
  console.error('usage: fetch-assets.mjs <model|texture|hdri> <slug> [res] [maps...]');
  process.exit(1);
}

const api = await fetch(`https://api.polyhaven.com/files/${slug}`);
if (!api.ok) throw new Error(`files API ${api.status} for ${slug}`);
const files = await api.json();

async function dl(url, dest, size) {
  try {
    const s = await stat(dest);
    if (!size || s.size === size) {
      console.log(`  skip ${dest}`);
      return;
    }
  } catch {}
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  got  ${dest} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
}

if (kind === 'model') {
  const entry = files.gltf?.[res]?.gltf;
  if (!entry) throw new Error(`no gltf @${res} for ${slug}`);
  const root = `public/assets/models/${slug}`;
  await dl(entry.url, join(root, `${slug}_${res}.gltf`), entry.size);
  for (const [rel, f] of Object.entries(entry.include ?? {})) {
    await dl(f.url, join(root, rel), f.size);
  }
} else if (kind === 'texture') {
  const want = maps.length ? maps : ['diff', 'nor_gl', 'rough'];
  const root = `public/assets/textures/${slug}`;
  for (const m of want) {
    const entry = files[m]?.[res]?.jpg ?? files[m]?.[res]?.png;
    if (!entry) {
      console.warn(`  no ${m}@${res} for ${slug}`);
      continue;
    }
    const ext = entry.url.split('.').pop();
    const short = m.toLowerCase().replace('diffuse', 'diff').replace('rough', 'rough');
    await dl(entry.url, join(root, `${short}_${res}.${ext}`), entry.size);
  }
} else if (kind === 'hdri') {
  const entry = files.hdri?.[res]?.hdr;
  if (!entry) throw new Error(`no hdr @${res} for ${slug}`);
  await dl(entry.url, `public/assets/hdri/${slug}_${res}.hdr`, entry.size);
}
console.log(`done: ${kind} ${slug} @${res}`);
