import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RoadTracker } from '../src/tracker';
import { MemoryStorage } from '../src/storage/memoryStorage';
import { GPSPoint, MatchedRouteResult, MatchingProvider } from '../src/types';

describe('RoadTracker', () => {
  let mockProvider: MatchingProvider;
  let tracker: RoadTracker;

  beforeEach(() => {
    vi.useFakeTimers();

    mockProvider = {
      name: 'mock',
      match: vi.fn().mockImplementation(async (points: GPSPoint[]): Promise<MatchedRouteResult> => {
        return {
          geometry: {
            type: 'LineString',
            coordinates: points.map((p) => [p.longitude, p.latitude]),
          },
          confidence: 0.95,
          distanceMeters: 500,
          durationSeconds: 60,
          isFallback: false,
          rawPoints: points,
        };
      }),
    };
  });

  afterEach(async () => {
    if (tracker) {
      await tracker.destroy();
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('initializes in tracking state', () => {
    tracker = new RoadTracker({
      provider: mockProvider,
      autoFlush: false,
    });
    expect(tracker.getState()).toBe('tracking');
  });

  it('emits pointAccepted for valid movement points and pointDropped for jitter', async () => {
    tracker = new RoadTracker({
      provider: mockProvider,
      autoFlush: false,
    });

    const acceptedEvents: GPSPoint[] = [];
    const droppedEvents: GPSPoint[] = [];

    tracker.on('pointAccepted', (pt) => acceptedEvents.push(pt));
    tracker.on('pointDropped', (pt) => droppedEvents.push(pt));

    // First point: accepted
    const p1: GPSPoint = { latitude: 51.5, longitude: -0.1, timestamp: 1000, accuracy: 10 };
    const res1 = await tracker.pushPoint(p1);
    expect(res1.accepted).toBe(true);

    // Jitter point (moved 2m): dropped
    const p2: GPSPoint = { latitude: 51.5 + 0.00001, longitude: -0.1, timestamp: 2000, accuracy: 10 };
    const res2 = await tracker.pushPoint(p2);
    expect(res2.accepted).toBe(false);

    // Movement point (>25m): accepted
    const p3: GPSPoint = { latitude: 51.5 + 0.0005, longitude: -0.1, timestamp: 5000, accuracy: 10 };
    const res3 = await tracker.pushPoint(p3);
    expect(res3.accepted).toBe(true);

    expect(acceptedEvents.length).toBe(2);
    expect(droppedEvents.length).toBe(1);
  });

  it('automatically triggers flush when batchSize is reached', async () => {
    tracker = new RoadTracker({
      provider: mockProvider,
      batchSize: 3,
      autoFlush: true,
    });

    const routeMatchedPromise = new Promise<MatchedRouteResult>((resolve) => {
      tracker.once('routeMatched', (r) => resolve(r));
    });

    // Push 3 accepted points spaced > 25m apart
    for (let i = 0; i < 3; i++) {
      await tracker.pushPoint({
        latitude: 51.5 + i * 0.0005,
        longitude: -0.1,
        timestamp: 1000 + i * 5000,
        accuracy: 10,
      });
    }

    const matched = await routeMatchedPromise;

    expect(matched).toBeDefined();
    expect(mockProvider.match).toHaveBeenCalledTimes(1);
    expect(await tracker.getQueue()).toEqual([]);
  });

  it('manually flushes queued points on tracker.flush()', async () => {
    tracker = new RoadTracker({
      provider: mockProvider,
      autoFlush: false,
    });

    await tracker.pushPoint({ latitude: 51.5, longitude: -0.1, timestamp: 1000, accuracy: 10 });
    await tracker.pushPoint({ latitude: 51.5005, longitude: -0.1, timestamp: 5000, accuracy: 10 });

    expect((await tracker.getQueue()).length).toBe(2);

    const result = await tracker.flush();
    expect(result).not.toBeNull();
    expect(result?.isFallback).toBe(false);
    expect((await tracker.getQueue()).length).toBe(0);
  });

  it('retains points in storage queue on network failure when fallbackOnFailure is false and recovers on next flush', async () => {
    let shouldFail = true;
    const failingProvider: MatchingProvider = {
      name: 'flaky',
      match: vi.fn().mockImplementation(async (points: GPSPoint[]) => {
        if (shouldFail) {
          throw new Error('Network timeout: 503 Service Unavailable');
        }
        return {
          geometry: {
            type: 'LineString',
            coordinates: points.map((p) => [p.longitude, p.latitude]),
          },
          isFallback: false,
          rawPoints: points,
        };
      }),
    };

    const storage = new MemoryStorage();
    tracker = new RoadTracker({
      provider: failingProvider,
      storage,
      autoFlush: false,
      maxRetries: 1,
      retryBackoffMs: 10,
      fallbackOnFailure: false,
    });

    const errorEvents: Error[] = [];
    tracker.on('error', (err) => errorEvents.push(err));

    await tracker.pushPoint({ latitude: 51.5, longitude: -0.1, timestamp: 1000, accuracy: 10 });
    await tracker.pushPoint({ latitude: 51.5005, longitude: -0.1, timestamp: 5000, accuracy: 10 });

    // Flush fails
    const flushPromise = tracker.flush();
    await vi.advanceTimersByTimeAsync(500);
    const result1 = await flushPromise;

    expect(result1).toBeNull();
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]?.message).toContain('Network timeout');

    // Points are preserved in storage queue
    expect(await storage.size()).toBe(2);

    // Network recovers
    shouldFail = false;
    const result2 = await tracker.flush();

    expect(result2).not.toBeNull();
    expect(result2?.isFallback).toBe(false);
    expect(await storage.size()).toBe(0);
  });

  it('generates fallback route when fallbackOnFailure is true', async () => {
    const errorProvider: MatchingProvider = {
      name: 'error-provider',
      match: vi.fn().mockRejectedValue(new Error('Fatal API crash')),
    };

    tracker = new RoadTracker({
      provider: errorProvider,
      autoFlush: false,
      maxRetries: 0,
      fallbackOnFailure: true,
    });

    await tracker.pushPoint({ latitude: 51.5, longitude: -0.1, timestamp: 1000, accuracy: 10 });
    await tracker.pushPoint({ latitude: 51.5005, longitude: -0.1, timestamp: 5000, accuracy: 10 });

    const result = await tracker.flush();
    expect(result).not.toBeNull();
    expect(result?.isFallback).toBe(true);
    expect(result?.geometry.coordinates).toEqual([
      [-0.1, 51.5],
      [-0.1, 51.5005],
    ]);
  });

  it('maintains cumulative stitched getFullRoute and getRawRoute', async () => {
    tracker = new RoadTracker({
      provider: mockProvider,
      autoFlush: false,
    });

    // Batch 1
    await tracker.pushPoint({ latitude: 51.5, longitude: -0.1, timestamp: 1000, accuracy: 10 });
    await tracker.pushPoint({ latitude: 51.5005, longitude: -0.1, timestamp: 5000, accuracy: 10 });
    await tracker.flush();

    expect(tracker.getFullRoute().coordinates.length).toBe(2);

    // Batch 2
    await tracker.pushPoint({ latitude: 51.501, longitude: -0.1, timestamp: 10000, accuracy: 10 });
    await tracker.pushPoint({ latitude: 51.5015, longitude: -0.1, timestamp: 15000, accuracy: 10 });
    await tracker.flush();

    expect(tracker.getFullRoute().coordinates.length).toBe(4);
    expect(tracker.getRawRoute().coordinates.length).toBe(4);
  });

  it('integrates with browser geolocation navigator.geolocation', async () => {
    let watchSuccessCb: ((pos: GeolocationPosition) => void) | null = null;
    const clearWatchMock = vi.fn();

    const mockGeolocation = {
      watchPosition: vi.fn().mockImplementation((success: (pos: GeolocationPosition) => void) => {
        watchSuccessCb = success;
        return 999;
      }),
      clearWatch: clearWatchMock,
      getCurrentPosition: vi.fn(),
    };

    vi.stubGlobal('navigator', {
      geolocation: mockGeolocation,
    });

    tracker = new RoadTracker({
      provider: mockProvider,
      autoFlush: false,
    });

    tracker.startBrowserTracking();
    expect(mockGeolocation.watchPosition).toHaveBeenCalled();

    // Simulate browser position update
    if (watchSuccessCb) {
      const mockPos = {
        coords: {
          latitude: 48.8566,
          longitude: 2.3522,
          accuracy: 8,
          speed: 5,
          heading: 45,
          altitude: 35,
        },
        timestamp: 1700000000000,
      } as unknown as GeolocationPosition;

      (watchSuccessCb as (pos: GeolocationPosition) => void)(mockPos);
    }

    const queue = await tracker.getQueue();
    expect(queue.length).toBe(1);
    expect(queue[0]?.latitude).toBe(48.8566);

    tracker.stopBrowserTracking();
    expect(clearWatchMock).toHaveBeenCalledWith(999);
  });
});
