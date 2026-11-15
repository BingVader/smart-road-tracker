import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStorage } from '../src/storage/memoryStorage';
import { WebStorageAdapter } from '../src/storage/webStorage';
import { GPSPoint } from '../src/types';

describe('Storage Adapters', () => {
  const samplePoints: GPSPoint[] = [
    { latitude: 51.5, longitude: -0.1, timestamp: 1000 },
    { latitude: 51.51, longitude: -0.11, timestamp: 2000 },
    { latitude: 51.52, longitude: -0.12, timestamp: 3000 },
  ];

  describe('MemoryStorage', () => {
    let storage: MemoryStorage;

    beforeEach(() => {
      storage = new MemoryStorage();
    });

    it('initializes with empty queue', async () => {
      expect(await storage.size()).toBe(0);
      expect(await storage.getQueue()).toEqual([]);
    });

    it('appends single and multiple points maintaining FIFO order', async () => {
      await storage.append(samplePoints[0]!);
      expect(await storage.size()).toBe(1);

      await storage.append([samplePoints[1]!, samplePoints[2]!]);
      expect(await storage.size()).toBe(3);

      const queue = await storage.getQueue();
      expect(queue.length).toBe(3);
      expect(queue[0]?.timestamp).toBe(1000);
      expect(queue[2]?.timestamp).toBe(3000);
    });

    it('clears specific count of points from the front (FIFO)', async () => {
      await storage.append(samplePoints);
      await storage.clear(1);

      expect(await storage.size()).toBe(2);
      const remaining = await storage.getQueue();
      expect(remaining[0]?.timestamp).toBe(2000);
      expect(remaining[1]?.timestamp).toBe(3000);
    });

    it('clears entire queue when count is omitted or exceeds size', async () => {
      await storage.append(samplePoints);
      await storage.clear();
      expect(await storage.size()).toBe(0);
      expect(await storage.getQueue()).toEqual([]);
    });
  });

  describe('WebStorageAdapter', () => {
    it('gracefully uses in-memory fallback in Node environment (no window)', async () => {
      const adapter = new WebStorageAdapter();
      expect(await adapter.size()).toBe(0);

      await adapter.append(samplePoints[0]!);
      expect(await adapter.size()).toBe(1);

      const queue = await adapter.getQueue();
      expect(queue[0]?.latitude).toBe(51.5);

      await adapter.clear(1);
      expect(await adapter.size()).toBe(0);
    });

    it('correctly persists to mocked window.localStorage', async () => {
      const mockStore: Record<string, string> = {};
      const mockLocalStorage = {
        getItem: (key: string) => mockStore[key] ?? null,
        setItem: (key: string, val: string) => {
          mockStore[key] = val;
        },
        removeItem: (key: string) => {
          delete mockStore[key];
        },
        clear: () => {
          for (const k in mockStore) delete mockStore[k];
        },
        length: 0,
        key: () => null,
      };

      // Temporarily inject window.localStorage
      const originalWindow = (globalThis as unknown as { window?: unknown }).window;
      (globalThis as unknown as { window: unknown }).window = {
        localStorage: mockLocalStorage,
      };

      try {
        const adapter = new WebStorageAdapter({ storageKey: 'test_gps_queue' });
        await adapter.append(samplePoints);

        expect(await adapter.size()).toBe(3);
        expect(mockStore['test_gps_queue']).toBeDefined();

        const parsed = JSON.parse(mockStore['test_gps_queue']!);
        expect(parsed.length).toBe(3);

        await adapter.clear(2);
        expect(await adapter.size()).toBe(1);

        await adapter.clear();
        expect(await adapter.size()).toBe(0);
        expect(mockStore['test_gps_queue']).toBeUndefined();
      } finally {
        if (originalWindow !== undefined) {
          (globalThis as unknown as { window: unknown }).window = originalWindow;
        } else {
          delete (globalThis as unknown as { window?: unknown }).window;
        }
      }
    });
  });
});
