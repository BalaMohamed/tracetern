import { build } from 'esbuild';
import { createRequire } from 'node:module';

const resolve = createRequire(import.meta.url);
const [source, entry, hashDependency] = process.argv.slice(2);
if (!source || !entry) throw new Error('Missing library snapshot directory or entry point');

const result = await build({
  absWorkingDir: source,
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  tsconfigRaw: '{}',
  logLevel: 'silent',
  plugins: [{
    name: 'library-dependencies',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path, kind }) => {
        if (kind === 'entry-point') return;
        if (path === 'stable-hash' && hashDependency === 'stable-hash') return { path: resolve.resolve(path) };
        return { errors: [{ text: 'Unsupported library dependency: ' + path }] };
      });
    },
  }],
});
process.stdout.write(result.outputFiles[0].text);
