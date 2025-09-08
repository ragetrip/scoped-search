import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const cfg = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  outfile: 'main.js',
  external: ['obsidian'],
  sourcemap: true,
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
    console.log('Scoped Search: watching…');
  } else {
    await esbuild.build(cfg);
    console.log('Scoped Search: build complete');
  }
})();
