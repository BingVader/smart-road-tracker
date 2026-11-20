/**
 * @file tracker.ts
 * Core RoadTracker state machine, offline queueing, and map-matching coordinator.
 */

import { SpatialFilter } from './filters/spatialFilter';
import { createFallbackRoute } from './providers/matchingProvider';
import { MemoryStorage } from './storage/memoryStorage';
import {
  FilterResult,
  GeoJSONFeature,
  GeoJSONLineString,
  GPSPoint,
  MatchedRouteResult,
  MatchingProvider,
  StorageAdapter,
  TrackerConfig,
  TrackerEventMap,
  TrackerState,
  TripSummary,
} from './types';
import {
  calculateRouteDistance,
  calculateRouteDuration,
  pointsToLineString,
  routeToFeature,
  stitchLineStrings,
} from './utils/geoMath';

type Listener = (...args: unknown[]) => void;

/**
 * Lightweight, zero-dependency typed EventEmitter.
 */
class SimpleEventEmitter {
  private events: Map<string, Set<Listener>> = new Map();

  public on(event: string, listener: Listener): void {
    let listeners = this.events.get(event);
    if (!listeners) {
      listeners = new Set();
      this.events.set(event, listeners);
    }
    listeners.add(listener);
  }

  public off(event: string, listener: Listener): void {
    const listeners = this.events.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.events.delete(event);
      }
    }
  }

  public once(event: string, listener: Listener): void {
    const wrapper = (...args: unknown[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }

  public emit(event: string, ...args: unknown[]): boolean {
    const listeners = this.events.get(event);
    if (!listeners || listeners.size === 0) {
      return false;
    }
    // Clone to prevent modification during dispatch
    const list = Array.from(listeners);
    for (const fn of list) {
      try {
        fn(...args);
      } catch (err) {
        // Emit uncaught listener errors to console or error handler
        console.error(`Error in event listener for '${event}':`, err);
      }
    }
    return true;
  }

  public removeAllListeners(): void {
    this.events.clear();
  }
}

/**
 * RoadTracker provides continuous sparse GPS noise reduction, persistent queueing,
 * automatic batch synchronization, and road-snapping via pluggable map-matching providers.
 */
export class RoadTracker {
  private readonly provider: MatchingProvider;
  private readonly storage: StorageAdapter;
  private readonly filter: SpatialFilter;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly fallbackOnFailure: boolean;
  private readonly autoFlush: boolean;

  private emitter: SimpleEventEmitter = new SimpleEventEmitter();
  private state: TrackerState = 'idle';
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private browserWatchId: number | null = null;

  /** Cumulative stitched road-matched geometry */
  private cumulativeMatchedRoute: GeoJSONLineString = {
    type: 'LineString',
    coordinates: [],
  };

  /** Cumulative raw accepted GPS points */
  private cumulativeRawPoints: GPSPoint[] = [];

  constructor(config: TrackerConfig) {
    if (!config || !config.provider) {
      throw new Error('RoadTracker requires a valid MatchingProvider.');
    }

    this.provider = config.provider;
    this.storage = config.storage ?? new MemoryStorage();
    this.filter = new SpatialFilter(config.filterOptions);
    this.batchSize = config.batchSize ?? 10;
    this.flushIntervalMs = config.flushIntervalMs ?? 60000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffMs = config.retryBackoffMs ?? 1000;
    this.fallbackOnFailure = config.fallbackOnFailure ?? true;
    this.autoFlush = config.autoFlush ?? true;

    if (this.autoFlush) {
      this.startTimer();
    }
    this.state = 'tracking';
  }

  /**
   * Returns the current operational state of the tracker.
   */
  public getState(): TrackerState {
    return this.state;
  }

  /**
   * Registers a typed event listener.
   */
  public on<E extends keyof TrackerEventMap>(
    event: E,
    listener: TrackerEventMap[E]
  ): this {
    this.emitter.on(event, listener as Listener);
    return this;
  }

  /**
   * Unregisters an event listener.
   */
  public off<E extends keyof TrackerEventMap>(
    event: E,
    listener: TrackerEventMap[E]
  ): this {
    this.emitter.off(event, listener as Listener);
    return this;
  }

  /**
   * Registers a one-time event listener.
   */
  public once<E extends keyof TrackerEventMap>(
    event: E,
    listener: TrackerEventMap[E]
  ): this {
    this.emitter.once(event, listener as Listener);
    return this;
  }

  /**
   * Evaluates and pushes an incoming GPS point into the tracker.
   * Runs the point through the spatial filter, saves to storage if accepted,
   * and triggers an automatic flush if batchSize threshold is reached.
   *
   * @param point GPS coordinate and timestamp
   * @returns FilterResult detailing acceptance or reason for rejection
   */
  public async pushPoint(point: GPSPoint): Promise<FilterResult> {
    const result = this.filter.filter(point);

    if (result.accepted) {
      this.cumulativeRawPoints.push({ ...point });
      await this.storage.append(point);
      this.emitter.emit('pointAccepted', point, result);

      if (this.autoFlush) {
        const queueSize = await this.storage.size();
        if (queueSize >= this.batchSize && !this.isFlushing) {
          // Trigger asynchronous batch flush without blocking point ingestion
          void this.flush();
        }
      }
    } else {
      this.emitter.emit('pointDropped', point, result);
    }

    return result;
  }

  /**
   * Synchronizes the queued GPS points with the map-matching provider.
   * Snaps coordinates to the road network, updates cumulative route,
   * clears flushed items from storage, and emits 'routeMatched'.
   *
   * @returns MatchedRouteResult or null if queue is empty or flush skipped
   */
  public async flush(): Promise<MatchedRouteResult | null> {
    if (this.isFlushing) {
      return null;
    }

    const queue = await this.storage.getQueue();
    if (queue.length === 0) {
      return null;
    }

    // Require at least 2 points to perform a meaningful map-match
    if (queue.length === 1) {
      return null;
    }

    this.isFlushing = true;
    const prevState = this.state;
    this.state = 'flushing';

    this.emitter.emit('flushStarted', queue);

    let matchResult: MatchedRouteResult | null = null;
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      try {
        matchResult = await this.provider.match(queue);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        attempt++;

        if (attempt <= this.maxRetries) {
          const delay =
            this.retryBackoffMs * Math.pow(2, attempt - 1) +
            Math.floor(Math.random() * 100);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!matchResult) {
      if (this.fallbackOnFailure) {
        // Create fallback GeoJSON route from raw points
        matchResult = createFallbackRoute(queue);
        await this.storage.clear(queue.length);
        this.appendMatchedRoute(matchResult);
        this.emitter.emit('routeMatched', matchResult);
        this.emitter.emit('flushCompleted', matchResult);
      } else {
        // Retain points in storage queue for next sync cycle
        if (lastError) {
          this.emitter.emit('error', lastError);
        }
        this.emitter.emit('flushCompleted', null);
      }
    } else {
      // Successfully matched: remove processed points from queue
      await this.storage.clear(queue.length);
      this.appendMatchedRoute(matchResult);
      this.emitter.emit('routeMatched', matchResult);
      this.emitter.emit('flushCompleted', matchResult);
    }

    this.isFlushing = false;
    this.state = prevState === 'stopped' ? 'stopped' : 'tracking';

    return matchResult;
  }

  /**
   * Appends a matched route result's coordinates into the cumulative stitched geometry.
   */
  private appendMatchedRoute(result: MatchedRouteResult): void {
    if (this.cumulativeMatchedRoute.coordinates.length === 0) {
      this.cumulativeMatchedRoute = {
        type: 'LineString',
        coordinates: [...result.geometry.coordinates],
      };
    } else {
      this.cumulativeMatchedRoute = stitchLineStrings([
        this.cumulativeMatchedRoute,
        result.geometry,
      ]);
    }
  }

  /**
   * Returns the cumulative stitched GeoJSON LineString of all road-matched trajectories.
   */
  public getFullRoute(): GeoJSONLineString {
    return {
      type: 'LineString',
      coordinates: [...this.cumulativeMatchedRoute.coordinates],
    };
  }

  /**
   * Returns the cumulative road-matched route wrapped in a standard GeoJSON Feature.
   * Convenient for direct ingestion into Mapbox GL JS, Leaflet, or OpenLayers.
   *
   * @param properties Optional properties to include in the Feature
   */
  public getFullRouteFeature<P = Record<string, unknown>>(
    properties: P = {} as P
  ): GeoJSONFeature<GeoJSONLineString, P> {
    return routeToFeature(this.cumulativeMatchedRoute, properties);
  }

  /**
   * Returns the total road-matched route distance in meters.
   */
  public getTotalDistance(): number {
    return calculateRouteDistance(this.cumulativeMatchedRoute.coordinates);
  }

  /**
   * Returns the total raw GPS route distance in meters.
   */
  public getRawDistance(): number {
    return calculateRouteDistance(
      this.cumulativeRawPoints.map((p) => [p.longitude, p.latitude])
    );
  }

  /**
   * Returns a comprehensive statistical summary of the tracked trip,
   * including matched vs raw distance, duration, point count, and average speed.
   */
  public getTripSummary(): TripSummary {
    const totalPoints = this.cumulativeRawPoints.length;
    const matchedDist = this.getTotalDistance();
    const rawDist = this.getRawDistance();

    if (totalPoints === 0) {
      return {
        matchedDistanceMeters: 0,
        rawDistanceMeters: 0,
        totalPointsAccepted: 0,
      };
    }

    const startTimeMs = this.cumulativeRawPoints[0]?.timestamp;
    const endTimeMs = this.cumulativeRawPoints[totalPoints - 1]?.timestamp;
    const durationSeconds = calculateRouteDuration(this.cumulativeRawPoints);
    const averageSpeedMps =
      durationSeconds > 0
        ? (matchedDist > 0 ? matchedDist : rawDist) / durationSeconds
        : 0;

    return {
      matchedDistanceMeters: matchedDist,
      rawDistanceMeters: rawDist,
      totalPointsAccepted: totalPoints,
      startTimeMs,
      endTimeMs,
      durationSeconds,
      averageSpeedMps,
    };
  }

  /**
   * Returns the underlying SpatialFilter instance for inspection or runtime option updates.
   */
  public getFilter(): SpatialFilter {
    return this.filter;
  }

  /**
   * Returns the cumulative GeoJSON LineString of all accepted raw GPS coordinates.
   */
  public getRawRoute(): GeoJSONLineString {
    return pointsToLineString(this.cumulativeRawPoints);
  }

  /**
   * Returns the currently queued points that have not yet been flushed.
   */
  public async getQueue(): Promise<GPSPoint[]> {
    return this.storage.getQueue();
  }

  /**
   * Starts automatic periodic flush timer.
   */
  private startTimer(): void {
    this.stopTimer();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Stops automatic periodic flush timer.
   */
  private stopTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Activates browser geolocation tracking using navigator.geolocation.watchPosition.
   * Convenient built-in wrapper for web applications.
   *
   * @param geoOptions Optional standard Geolocation PositionOptions
   */
  public startBrowserTracking(geoOptions?: PositionOptions): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      throw new Error(
        'navigator.geolocation is not available in the current environment.'
      );
    }

    this.stopBrowserTracking();

    const options: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
      ...geoOptions,
    };

    this.browserWatchId = navigator.geolocation.watchPosition(
      (pos: GeolocationPosition) => {
        const point: GPSPoint = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          timestamp: pos.timestamp,
          accuracy: pos.coords.accuracy,
          speed:
            pos.coords.speed !== null && Number.isFinite(pos.coords.speed)
              ? pos.coords.speed
              : undefined,
          heading:
            pos.coords.heading !== null &&
            Number.isFinite(pos.coords.heading) &&
            !Number.isNaN(pos.coords.heading)
              ? pos.coords.heading
              : undefined,
          altitude:
            pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)
              ? pos.coords.altitude
              : undefined,
        };

        void this.pushPoint(point);
      },
      (err: GeolocationPositionError) => {
        this.emitter.emit(
          'error',
          new Error(`Geolocation error (${err.code}): ${err.message}`)
        );
      },
      options
    );
  }

  /**
   * Stops browser geolocation tracking if active.
   */
  public stopBrowserTracking(): void {
    if (
      this.browserWatchId !== null &&
      typeof navigator !== 'undefined' &&
      navigator.geolocation
    ) {
      navigator.geolocation.clearWatch(this.browserWatchId);
      this.browserWatchId = null;
    }
  }

  /**
   * Manually resumes or starts tracking lifecycle.
   */
  public start(): void {
    this.state = 'tracking';
    if (this.autoFlush && this.flushTimer === null) {
      this.startTimer();
    }
  }

  /**
   * Stops the tracker, clears timers, stops browser tracking,
   * and performs a final queue flush.
   */
  public async stop(): Promise<void> {
    this.stopBrowserTracking();
    this.stopTimer();
    this.state = 'stopped';
    await this.flush();
  }

  /**
   * Resets all tracker state, queues, filters, and cumulative routes.
   */
  public async reset(): Promise<void> {
    this.stopBrowserTracking();
    this.stopTimer();
    await this.storage.clear();
    this.filter.reset();
    this.cumulativeMatchedRoute = {
      type: 'LineString',
      coordinates: [],
    };
    this.cumulativeRawPoints = [];
    this.state = 'idle';
  }

  /**
   * Destroys the tracker instance and removes all event listeners.
   */
  public async destroy(): Promise<void> {
    await this.stop();
    this.emitter.removeAllListeners();
  }
}
