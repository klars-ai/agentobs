// Copies non-TS runtime assets (schema.sql, the dashboard UI) into dist/,
// since tsc only emits JS. Kept as a script rather than a shell cp so the
// build works identically on Windows and CI.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [
  ['src/core/schema.sql', 'dist/core/schema.sql'],
  ['src/server/public', 'dist/server/public'],
];

for (const [from, to] of assets) {
  const src = join(root, from);
  const dest = join(root, to);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Asset not created yet (e.g. dashboard UI before it is written) -
    // don't fail the build during incremental development.
    console.warn(`[copy-assets] skipped missing ${from}`);
  }
}
