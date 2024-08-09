import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('mineos server startup', () => {
  const BASE_DIR = join(tmpdir(), `mineos-test-${randomUUID()}`);
  beforeAll(() => {
    mkdirSync(BASE_DIR);
  });

  afterAll(() => {
    rmdirSync(BASE_DIR);
  });

  test('should start the backend', async () => {
    expect(true).toBe(false);
  });
});
