import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
};

async function build() {
  // Service worker
  const swCtx = await esbuild.context({
    ...common,
    entryPoints: ['src/background/service-worker.ts'],
    outfile: 'dist/service-worker.js',
  });

  // Content script
  const csCtx = await esbuild.context({
    ...common,
    format: 'iife',
    entryPoints: ['src/content/slack-extractor.ts'],
    outfile: 'dist/slack-extractor.js',
  });

  // Popup
  const popupCtx = await esbuild.context({
    ...common,
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup.js',
  });

  if (watch) {
    await Promise.all([swCtx.watch(), csCtx.watch(), popupCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([swCtx.rebuild(), csCtx.rebuild(), popupCtx.rebuild()]);
    await Promise.all([swCtx.dispose(), csCtx.dispose(), popupCtx.dispose()]);
    console.log('Build complete.');
  }
}

build().catch(console.error);
