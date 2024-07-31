import {afterAll, beforeAll, describe, expect, test} from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';

describe('mineos server startup', () => {
  const BASE_DIR = tmpdir() + `mineos-test-${randomUUID()}`;
  beforeAll(() => {});

  afterAll(() => {
    rmdirSync(BASE_DIR);
  });

  test('should start the backend', async () => {
    expect(true).toBe(false);
  });
});
