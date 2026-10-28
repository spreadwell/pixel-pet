import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
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

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
