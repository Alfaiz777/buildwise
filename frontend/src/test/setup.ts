import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Full-route renders are slow when every test file runs in parallel on a busy machine.
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
});
