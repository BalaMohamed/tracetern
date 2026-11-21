import { build } from 'esbuild';
import { createRequire } from 'node:module';

const resolve = createRequire(import.meta.url);
const [source, hashDependency] = process.argv.slice(2);
if (!source) throw new Error('Missing query-core snapshot directory');

const result = await build({
  absWorkingDir: source,
  entryPoints: ['index.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  tsconfigRaw: '{}',
  logLevel: 'silent',
  plugins: [{
    name: 'query-core-dependencies',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path, kind }) => {
        if (kind === 'entry-point') return;
        if (path === 'stable-hash' && hashDependency === 'stable-hash') return { path: resolve.resolve(path) };
        return { errors: [{ text: 'Unsupported query-core dependency: ' + path }] };
      });
    },
  }],
});
process.stdout.write(result.outputFiles[0].text);
