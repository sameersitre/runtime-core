import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: ['react', 'react-dom'],
  esbuildOptions(options) {
    options.external = ['react', 'react-dom', 'react/jsx-runtime'];
  },
});
