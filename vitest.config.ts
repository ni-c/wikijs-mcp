import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite has its own config and its own command, because it
    // needs a Wiki.js in Docker. Excluding it here keeps `npm test` runnable
    // with nothing installed, and keeps the coverage numbers below comparable
    // to what they measured before it existed — a suite that drives every tool
    // end to end would inflate them without testing anything new.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        // Entry point: only wires config and server to the stdio transport and
        // exits the process; not reachable from unit tests.
        'src/index.ts',
        // Runs inside a worker thread, where v8 coverage does not reach. It is
        // exercised — test/audit.test.ts drives it through matchPages, including
        // the timeout path — the instrumentation simply cannot see it, and
        // leaving it in reports 0% for a file that is covered.
        'src/grep-worker.ts',
      ],
      // Measured on 2026-09-02 after the second security audit: 97.49
      // statements, 88.50 branches, 99.65 functions, 97.97 lines. These sit
      // below that, with headroom on functions. Write the missing tests rather
      // than lowering them — vitest 4 measures AST-based and stricter than v3,
      // so a major bump can cost a few points and the answer to that is tests
      // too.
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 93,
        lines: 95,
      },
    },
  },
});
