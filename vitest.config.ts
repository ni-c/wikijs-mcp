import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and exits
      // the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-30: 96.69 statements, 87.46 branches, 98.28
      // functions, 97.32 lines. These sit just below that, with headroom on
      // functions. Write the missing tests rather than lowering them — vitest 4
      // measures AST-based and stricter than v3, so a major bump can cost a few
      // points and the answer to that is tests too.
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 93,
        lines: 95,
      },
    },
  },
});
