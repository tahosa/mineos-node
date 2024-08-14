import fs from 'node:fs';
import ini from 'ini';
import { EventEmitter } from 'node:stream';

import { Logger } from './logger';

const logger = Logger.child({ service: 'util' });

/**
 * Read an INI formatted file
 *
 * @param filepath File to read
 * @param clearOnError If there is an error, set the file to an empty contents
 * @returns Contents of the INI file as a JSON object
 */
export const readIni = (filepath: string, clearOnError = false): { [key: string]: any } | undefined => {
  try {
    const data = fs.readFileSync(filepath);
    return ini.parse(data.toString());
  } catch (e) {
    logger.warn(`error reading ini file ${filepath}`, e);

    if (clearOnError) {
      fs.writeFileSync(filepath, '');
    }

    return;
  }
};

/**
 * Swap the order (big-endian or little-endian) of bytes in a buffer
 *
 * @param buffer Source buffer
 * @returns Buffer with byte order swapped
 */
export const swapBytes = (buffer: Buffer): Buffer => {
  //http://stackoverflow.com/a/7460958/1191579
  const l = buffer.length;
  if (l & 0x01) {
    throw new Error('buffer length must be even');
  }
  for (let i = 0; i < l; i += 2) {
    const a = buffer[i];
    buffer[i] = buffer[i + 1];
    buffer[i + 1] = a;
  }
  return buffer;
};

/**
 * Divide a source buffer into multiple sub-buffers by splitting on a binary character
 *
 * @param buf Source buffer
 * @param delimiter Binary delimiter to split on
 * @returns Array of buffers
 */
export const splitBuffer = (buf: Buffer, delimiter: number): Buffer[] => {
  //http://stackoverflow.com/a/8920913/1191579
  const arr: Buffer[] = [];
  let p = 0;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== delimiter) continue;
    if (i === 0) {
      p = 1;
      continue; // skip if it's at the start of buffer
    }
    arr.push(buf.subarray(p, i));
    p = i + 1;
  }

  // add final part
  if (p < buf.length) {
    arr.push(buf.subarray(p, buf.length));
  }

  return arr;
};

/**
 * Convert a buffer to an ASCII string, removing any null bytes (0x00)
 * @param buf Source buffer
 * @returns ASCII string with null bytes removed
 */
export const bufferToAscii = (buf: Buffer): string => {
  let retval = '';
  for (let i = 0; i < buf.length; i++) retval += buf[i] == 0x0000 ? '' : String.fromCharCode(buf[i]);
  return retval;
};

/**
 * Data returned from mcquery based on the binary output from Minecraft for a Full Stat request
 */
export type MinecraftFullStats = {
  hostname: string;
  gametype: string;
  game_id: string;
  version: string;
  plugins: string;
  map: string;
  numplayers: string;
  maxplayers: string;
  hostport: string;
  hostip: string;
  players?: string[];
};

/**
 * Native wrapper for promises to provide a concurrency limit
 *
 * https://levelup.gitconnected.com/promise-pool-or-how-to-improve-the-performance-of-node-js-2b7d3c1f035e
 */
export class PromisePool<T, I> {
  static TASK_COMPLETED = 'TASK_COMPLETED';
  static DRAIN = 'DRAIN';

  data: I[];
  concurrancy: number;
  processor: (data: I) => Promise<T>;
  results: T[] = [];
  errors: [I, Error][] = [];
  processed: number = 0;
  inFlight: number = 0;
  promise: Promise<T[]> | null = null;
  eventEmitter: EventEmitter = new EventEmitter();

  constructor(data: I[], concurrency: number, processor: (data: I) => Promise<T>) {
    this.data = data;
    this.concurrancy = concurrency;
    this.processor = processor;
  }

  /**
   * Set the concurrancy limit
   *
   * @param concurrancy Maximum number of concurrent operations
   * @returns PromisePool
   */
  withConcurrency(concurrancy: number) {
    this.concurrancy = concurrancy;
    return this;
  }

  /**
   * Process all records in this instance
   *
   * @returns Promise<T[]> Promise for all the processed data
   */
  process(): Promise<T[]> {
    if (this.promise != null) {
      return this.promise;
    }
    // eslint-disable-next-line no-async-promise-executor
    this.promise = new Promise<T[]>(async (res, rej) => {
      try {
        for (const elem of this.data) {
          await this._waitAvailable();
          this._processRecord(elem);
        }
        this.eventEmitter.once(PromisePool.DRAIN, () => res(this.results));
      } catch (e) {
        rej(e);
      }
    });
    return this.promise;
  }

  /**
   * Process a single record and emit an event when complete.
   *
   * @param data Single record to process
   */
  async _processRecord(data: I) {
    try {
      this.inFlight++;
      this.results.push(await this.processor(data));
    } catch (e) {
      this.errors.push([data, e as Error]);
    } finally {
      this.inFlight--;
      this.processed++;
      this.eventEmitter.emit(PromisePool.TASK_COMPLETED);
      if (this.inFlight === 0 && this.processed === this.data.length) {
        this.eventEmitter.emit(PromisePool.DRAIN);
      }
    }
  }

  /**
   * Wait until the queue drains enough to start processing the next task
   * @returns Promise<void>
   */
  _waitAvailable(): Promise<void> {
    if (this.inFlight >= this.concurrancy) {
      return new Promise((res) => {
        this.eventEmitter.once(PromisePool.TASK_COMPLETED, res);
      });
    } else {
      return Promise.resolve();
    }
  }
}
