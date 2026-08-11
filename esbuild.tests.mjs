import esbuild from 'esbuild';
import { readdirSync } from 'fs';
import path from 'path';

const TEST_DIR = 'tests';
const OUT_DIR = '.test-build';

/**
 * `obsidian` only exists inside the app, and the Svelte components pull in a
 * DOM. Point both at local stand-ins so the logic under test can run in Node.
 */
const stubs = {
  name: 'test-stubs',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: path.resolve(TEST_DIR, 'obsidian.stub.ts'),
    }));
    build.onResolve({ filter: /\.svelte$/ }, () => ({
      path: path.resolve(TEST_DIR, 'svelte.stub.ts'),
    }));
  },
};

const entryPoints = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(TEST_DIR, name));

if (entryPoints.length === 0) {
  console.error(`No *.test.ts files found in ${TEST_DIR}/`);
  process.exit(1);
}

await esbuild.build({
  entryPoints,
  outdir: OUT_DIR,
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  sourcemap: 'inline',
  logLevel: 'info',
  // Keep the runner's own module out of the bundle.
  external: ['node:*'],
  plugins: [stubs],
});
