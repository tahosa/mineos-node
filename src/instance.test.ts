import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

describe('Instance', () => {
  describe('static', () => {
    test('should pass', () => {
      expect(true).toBeTruthy();
    });
  });

  describe('instance', () => {
    test('should fail', () => {
      expect(true).toBeFalsy();
    });
  });
});
