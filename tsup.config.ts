import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    // JSX runtime opt-in entries — additive subpath exports. Active when the
    // user sets `"jsxImportSource": "@flotrace/runtime-core"` in tsconfig.json.
    // Co-located with the fiber walker that reads FLOTRACE_SOURCE.
    'src/jsx-runtime.ts',
    'src/jsx-dev-runtime.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: ['react', 'react-dom'],
  esbuildOptions(options) {
    options.external = [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ];
  },
});
