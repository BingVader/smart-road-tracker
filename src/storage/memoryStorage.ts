/**
 * @file memoryStorage.ts
 * In-memory storage adapter for zero-overhead, non-persisted point queueing.
 */

import { GPSPoint, StorageAdapter } from '../types';

/**
 * MemoryStorage stores queued GPS points in a local in-memory array.
 * Suitable for environments where persistence across app restarts is not required.
 */
export class MemoryStorage implements StorageAdapter {
  private queue: GPSPoint[] = [];

  /**
   * Retrieves all points currently in the queue in chronological order.
   */
  public async getQueue(): Promise<GPSPoint[]> {
    return this.queue.map((p) => ({ ...p }));
  }

  /**
   * Appends one or multiple GPS points to the end of the queue.
   * @param points GPSPoint or array of GPSPoints
   */
  public async append(points: GPSPoint | GPSPoint[]): Promise<void> {
    if (Array.isArray(points)) {
      for (const p of points) {
        this.queue.push({ ...p });
      }
    } else {
      this.queue.push({ ...points });
    }
  }

  /**
   * Removes items from the beginning of the queue.
   * @param count Number of items to remove. If omitted or >= queue size, clears the entire queue.
   */
  public async clear(count?: number): Promise<void> {
    if (count === undefined || count >= this.queue.length) {
      this.queue = [];
    } else if (count > 0) {
      this.queue.splice(0, count);
    }
  }

  /**
   * Returns current count of queued points.
   */
  public async size(): Promise<number> {
    return this.queue.length;
  }
}
