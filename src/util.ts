import fs from 'node:fs';
import ini from 'ini';
import { EventEmitter } from 'node:stream';

import { Logger } from './logger.js';

const logger = Logger('util');

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
