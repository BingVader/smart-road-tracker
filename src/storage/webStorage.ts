/**
 * @file webStorage.ts
 * Web Storage (localStorage / sessionStorage) adapter with SSR safety and failure resilience.
 */

import { GPSPoint, StorageAdapter } from '../types';

export interface WebStorageOptions {
  /** Key prefix used in storage (default: 'smart_road_tracker_queue') */
  storageKey?: string;
  /** Storage type: 'local' (localStorage) or 'session' (sessionStorage) (default: 'local') */
  storageType?: 'local' | 'session';
}

/**
 * WebStorageAdapter wraps browser localStorage/sessionStorage.
 * Includes safeguards against SSR environments, JSON parsing corruptions,
 * and quota limits by falling back to memory storage when unavailable.
 */
export class WebStorageAdapter implements StorageAdapter {
  private readonly storageKey: string;
  private readonly storageType: 'local' | 'session';
  private memoryFallback: GPSPoint[] = [];
  private isStorageAvailable: boolean;

  constructor(options?: WebStorageOptions) {
    this.storageKey = options?.storageKey ?? 'smart_road_tracker_queue';
    this.storageType = options?.storageType ?? 'local';
    this.isStorageAvailable = this.checkStorageAvailability();
  }

  /**
   * Safe check for Web Storage availability in current execution context.
   */
  private checkStorageAvailability(): boolean {
    try {
      if (typeof window === 'undefined') {
        return false;
      }
      const storage =
        this.storageType === 'local' ? window.localStorage : window.sessionStorage;
      if (!storage) {
        return false;
      }
      const testKey = '__srt_test__';
      storage.setItem(testKey, testKey);
      storage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  private getStorage(): Storage | null {
    if (!this.isStorageAvailable) return null;
    try {
      return this.storageType === 'local'
        ? window.localStorage
        : window.sessionStorage;
    } catch {
      return null;
    }
  }

  /**
   * Retrieves all points currently in the queue in chronological order.
   */
  public async getQueue(): Promise<GPSPoint[]> {
    const storage = this.getStorage();
    if (!storage) {
      return this.memoryFallback.map((p) => ({ ...p }));
    }

    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed;
    } catch {
      return this.memoryFallback.map((p) => ({ ...p }));
    }
  }

  /**
   * Appends one or multiple GPS points to the end of the queue.
   * @param points GPSPoint or array of GPSPoints
   */
  public async append(points: GPSPoint | GPSPoint[]): Promise<void> {
    const current = await this.getQueue();
    const toAdd = Array.isArray(points) ? points : [points];

    for (const p of toAdd) {
      current.push({ ...p });
    }

    const storage = this.getStorage();
    if (!storage) {
      this.memoryFallback = current;
      return;
    }

    try {
      storage.setItem(this.storageKey, JSON.stringify(current));
    } catch {
      // Storage quota exceeded or disabled: use memory fallback
      this.memoryFallback = current;
    }
  }

  /**
   * Removes items from the beginning of the queue.
   * @param count Number of items to remove. If omitted or >= queue size, clears the entire queue.
   */
  public async clear(count?: number): Promise<void> {
    const current = await this.getQueue();
    if (count === undefined || count >= current.length) {
      current.length = 0;
    } else if (count > 0) {
      current.splice(0, count);
    }

    const storage = this.getStorage();
    if (!storage) {
      this.memoryFallback = current;
      return;
    }

    try {
      if (current.length === 0) {
        storage.removeItem(this.storageKey);
      } else {
        storage.setItem(this.storageKey, JSON.stringify(current));
      }
    } catch {
      this.memoryFallback = current;
    }
  }

  /**
   * Returns current count of queued points.
   */
  public async size(): Promise<number> {
    const queue = await this.getQueue();
    return queue.length;
  }
}

/**
 * Alias for WebStorageAdapter configured for localStorage.
 */
export const LocalStorageAdapter = WebStorageAdapter;
