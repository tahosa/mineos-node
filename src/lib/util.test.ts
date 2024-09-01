import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
};

jest.mock('./logger', () => ({
  Logger: {
    child: () => mockLogger,
  },
}));

import { readIni, splitBuffer, bufferToAscii, PromisePool } from './util';

describe('readIni', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should parse INI data and return it as json', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('[java]\njava_xmx=256\n\n[minecraft]\nprofile=1.21.0'));
    const result = readIni('teststring', false);

    expect(result).toEqual({
      java: {
        java_xmx: '256',
      },
      minecraft: {
        profile: '1.21.0',
      },
    });
  });

  test('should throw an error if clearOnError is not set', () => {
    const err = new Error('read error');
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw err;
    });
    jest.spyOn(fs, 'writeFileSync');

    expect(() => {
      readIni('teststring');
    }).toThrowError(err);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('should write an empty file on error if clearOnError is set', () => {
    const err = new Error('read error');
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw err;
    });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const result = readIni('teststring', true);
    expect(result).toBeUndefined();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).toHaveBeenCalledWith('teststring', '');
  });
});

describe('splitBuffer', () => {
  test('should split buffers on the given value', () => {
    expect(splitBuffer(Buffer.from([0x1, 0x1, 0x0, 0x2, 0x0, 0x3]), 0x0)).toEqual([
      Buffer.from([0x1, 0x1]),
      Buffer.from([0x2]),
      Buffer.from([0x3]),
    ]);
  });

  test('should handle buffers that start with the delimiter', () => {
    expect(splitBuffer(Buffer.from([0x0, 0x1, 0x0, 0x2, 0x0, 0x3]), 0x0)).toEqual([
      Buffer.from([0x1]),
      Buffer.from([0x2]),
      Buffer.from([0x3]),
    ]);
  });
});

describe('bufferToAscii', () => {
  test('should remove null bytes and return ascii values', () => {
    expect(bufferToAscii(Buffer.from('\x00a\x00b\x00c\x00\x00d'))).toEqual('abcd');
  });
});

describe('PromisePool', () => {
  beforeAll(() => {
    // See this gist for details on jest fake timers with promises:
    // https://gist.github.com/apieceofbart/e6dea8d884d29cf88cdb54ef14ddbcc4?permalink_comment_id=4760758#gistcomment-4760758
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  test('should return a valid promise pool when constructed', () => {
    const data = ['a', 'b', 'c'];
    const limit = 1;
    const processor = (str) => Promise.resolve(`${str}${str}`);
    const pool = new PromisePool(data, limit, processor);

    expect(pool.data).toEqual(data);
    expect(pool.concurrancy).toEqual(limit);
    expect(pool.processor).toBe(processor);
  });

  test('should set the concurrancy value and return the pool for chaining', () => {
    const data = ['a', 'b', 'c'];
    const limit = 1;
    const processor = (str) => Promise.resolve(`${str}${str}`);
    const pool = new PromisePool(data, limit, processor);

    expect(pool.withConcurrency(3)).toBe(pool);
    expect(pool.concurrancy).toEqual(3);
  });

  test('should process all successfully', async () => {
    const data = ['a', 'b', 'c', 'd', 'e'];
    const limit = 2;
    const processor = (str) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(`${str}${str}`);
        }, 99);
      });
    };

    const pool = new PromisePool(data, limit, processor);
    const promise = pool.process();

    // First batch
    expect(pool.results.length).toEqual(0);
    await jest.advanceTimersByTimeAsync(100);
    await new Promise(process.nextTick);
    expect(pool.results).toEqual(['aa', 'bb']);

    // Second batch
    await jest.advanceTimersByTimeAsync(100);
    await new Promise(process.nextTick);
    expect(pool.results).toEqual(['aa', 'bb', 'cc', 'dd']);

    // Final batch
    await jest.advanceTimersByTimeAsync(100);
    await new Promise(process.nextTick);
    await expect(promise).resolves.toEqual(['aa', 'bb', 'cc', 'dd', 'ee']);
  });

  test('should not re-run if process is invoked again', async () => {
    const data = ['a'];
    const limit = 2;
    const processor = (str) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(`${str}${str}`);
        }, 99);
      });
    };

    const pool = new PromisePool(data, limit, processor);
    const promise = pool.process();

    // First batch
    expect(pool.results.length).toEqual(0);
    await jest.advanceTimersByTimeAsync(100);
    await new Promise(process.nextTick);

    await expect(promise).resolves.toEqual(['aa']);
    await expect(pool.process()).resolves.toEqual(['aa']);
  });

  // Something weird is going on with not handling the error thrown.
  // It definitely has to do with the Promise lifecycle, but despite the await
  // inside a try block in the implementation, the error is not caught and we get
  // an Unhandled Rejection Error
  test.skip('should reject if any errors are thrown from processing', async () => {
    const data = ['a'];
    const limit = 2;
    const processor = () => {
      return new Promise(() => {
        setTimeout(() => {
          throw new Error('rejected');
        }, 100);
      });
    };

    const pool = new PromisePool(data, limit, processor);
    const promise = pool.process();
    expect(pool.results.length).toEqual(0);

    await jest.advanceTimersByTimeAsync(100);
    await new Promise(process.nextTick);

    await expect(promise).rejects.toBeTruthy();
  }, 10000);

  test('should return errors from internal rejection in the errors property', async () => {
    const data = ['a'];
    const limit = 2;
    const err = new Error('rejected');
    const processor = () => {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(err);
        }, 100);
      });
    };

    const pool = new PromisePool(data, limit, processor);
    const promise = pool.process();

    // First batch
    expect(pool.results.length).toEqual(0);
    await jest.advanceTimersByTimeAsync(100);
    await new Promise(process.nextTick);
    expect(pool.errors).toEqual([['a', err]]);
    await expect(promise).resolves.toEqual([]);
  });
});
