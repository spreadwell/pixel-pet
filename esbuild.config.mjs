import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';

const mode = process.argv[2];
const production = mode === 'production';
const harness = mode === 'harness';

const context = await esbuild.context(harness ? {
  entryPoints: ['harness/harness.ts', 'harness/studio.ts', 'harness/compare.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  sourcemap: 'inline',
  outdir: 'harness',
  logLevel: 'info',
} : {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtins],
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  logLevel: 'info',
});

if (production || harness) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
