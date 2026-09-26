import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Emulator tests share one Firestore/Auth emulator; run files serially.
    fileParallelism: false,
  },
});
