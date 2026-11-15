/**
 * @file spatialFilter.ts
 * Spatial and noise filter implementation for sparse GPS tracking.
 * Eliminates GPS teleportation, stationary jitter, and inaccurate fixes.
 */

import {
  FilterMetadata,
  FilterOptions,
  FilterResult,
  GPSPoint,
} from '../types';
import {
  bearingDelta,
  haversineDistance,
  initialBearing,
  isValidCoordinate,
} from '../utils/geoMath';

/** Default filter thresholds */
export const DEFAULT_FILTER_OPTIONS: FilterOptions = {
  maxAccuracyMeters: 50,
  minDistanceMeters: 25,
  minHeadingDeltaDegrees: 20,
  maxIdleIntervalMs: 120000, // 2 minutes
  maxSpeedMps: 65, // ~234 km/h
};

/**
 * SpatialFilter evaluates incoming GPS points against spatial, temporal, and kinematic constraints.
 */
export class SpatialFilter {
  private options: FilterOptions;
  private lastAcceptedPoint: GPSPoint | null = null;
  private lastBearing: number | null = null;

  /**
   * Creates an instance of SpatialFilter.
   * @param options Partial configuration options to override defaults.
   */
  constructor(options?: Partial<FilterOptions>) {
    this.options = { ...DEFAULT_FILTER_OPTIONS, ...options };
  }

  /**
   * Returns current active filter options.
   */
  public getOptions(): FilterOptions {
    return { ...this.options };
  }

  /**
   * Updates filter options dynamically.
   * @param options Partial options to apply.
   */
  public updateOptions(options: Partial<FilterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Returns the most recently accepted GPS point.
   */
  public getLastAcceptedPoint(): GPSPoint | null {
    return this.lastAcceptedPoint ? { ...this.lastAcceptedPoint } : null;
  }

  /**
   * Explicitly sets or restores the last accepted GPS point.
   * Useful when restoring tracker state from persisted storage.
   * @param point GPSPoint or null to clear.
   */
  public setLastAcceptedPoint(point: GPSPoint | null): void {
    this.lastAcceptedPoint = point ? { ...point } : null;
    this.lastBearing = point?.heading ?? null;
  }

  /**
   * Resets the filter state to clean slate.
   */
  public reset(): void {
    this.lastAcceptedPoint = null;
    this.lastBearing = null;
  }

  /**
   * Evaluates an incoming GPS point against noise and spatial thresholds.
   *
   * @param point The GPSPoint to evaluate
   * @returns FilterResult detailing acceptance or reason for rejection
   */
  public filter(point: GPSPoint): FilterResult {
    // 0. Coordinate validity check
    if (!isValidCoordinate(point.latitude, point.longitude)) {
      return {
        accepted: false,
        point,
        reason: 'INVALID_COORDINATES',
        message: `Coordinates (${point.latitude}, ${point.longitude}) are out of valid WGS-84 bounds.`,
      };
    }

    // 1. Horizontal accuracy threshold check
    if (
      point.accuracy !== undefined &&
      Number.isFinite(point.accuracy) &&
      point.accuracy > this.options.maxAccuracyMeters
    ) {
      return {
        accepted: false,
        point,
        reason: 'ACCURACY_TOO_LOW',
        message: `Accuracy (${point.accuracy}m) exceeds max allowed (${this.options.maxAccuracyMeters}m).`,
        metadata: {
          distanceMeters: 0,
        },
      };
    }

    // If this is the initial point, accept it unconditionally
    if (!this.lastAcceptedPoint) {
      this.lastAcceptedPoint = { ...point };
      if (point.heading !== undefined && Number.isFinite(point.heading)) {
        this.lastBearing = (point.heading + 360.0) % 360.0;
      }
      return {
        accepted: true,
        point,
        message: 'Initial point accepted.',
      };
    }

    // Check chronological order of timestamps
    const elapsedMs = point.timestamp - this.lastAcceptedPoint.timestamp;
    if (elapsedMs < 0) {
      return {
        accepted: false,
        point,
        reason: 'NON_CHRONOLOGICAL_TIMESTAMP',
        message: `Timestamp (${point.timestamp}) is earlier than previous point (${this.lastAcceptedPoint.timestamp}).`,
        metadata: { elapsedMs },
      };
    }

    // Compute Haversine distance from previous accepted point
    const distanceMeters = haversineDistance(
      this.lastAcceptedPoint.latitude,
      this.lastAcceptedPoint.longitude,
      point.latitude,
      point.longitude
    );

    // 3. Implied speed teleportation check
    const elapsedSeconds = elapsedMs / 1000.0;
    const impliedSpeedMps =
      elapsedSeconds > 0 ? distanceMeters / elapsedSeconds : 0;

    if (
      elapsedSeconds > 0 &&
      impliedSpeedMps > this.options.maxSpeedMps
    ) {
      return {
        accepted: false,
        point,
        reason: 'SPEED_EXCEEDS_MAX',
        message: `Implied speed (${impliedSpeedMps.toFixed(1)} m/s) exceeds max threshold (${this.options.maxSpeedMps} m/s). Possible GPS teleportation spike.`,
        metadata: {
          distanceMeters,
          elapsedMs,
          impliedSpeedMps,
        },
      };
    }

    // Determine current bearing and heading delta
    let currentBearing: number | null = null;
    let headingDeltaDegrees = 0;

    // If point provides a valid compass heading, use it
    if (point.heading !== undefined && Number.isFinite(point.heading)) {
      currentBearing = (point.heading + 360.0) % 360.0;
    } else if (distanceMeters >= 1.0) {
      // Calculate bearing from previous position if there is meaningful displacement
      currentBearing = initialBearing(
        this.lastAcceptedPoint.latitude,
        this.lastAcceptedPoint.longitude,
        point.latitude,
        point.longitude
      );
    }

    if (currentBearing !== null && this.lastBearing !== null) {
      headingDeltaDegrees = bearingDelta(this.lastBearing, currentBearing);
    }

    const metadata: FilterMetadata = {
      distanceMeters,
      headingDeltaDegrees,
      impliedSpeedMps,
      elapsedMs,
    };

    // 2. Spatial threshold:
    // Reject if distance < minDistanceMeters AND heading change < minHeadingDeltaDegrees AND elapsed < maxIdleIntervalMs
    const isBelowDistance = distanceMeters < this.options.minDistanceMeters;
    const isBelowHeadingDelta =
      headingDeltaDegrees < this.options.minHeadingDeltaDegrees;
    const isWithinIdleInterval = elapsedMs < this.options.maxIdleIntervalMs;

    if (isBelowDistance && isBelowHeadingDelta && isWithinIdleInterval) {
      return {
        accepted: false,
        point,
        reason: 'BELOW_SPATIAL_THRESHOLD',
        message: `Point dropped as redundant/stationary jitter (dist: ${distanceMeters.toFixed(1)}m < ${this.options.minDistanceMeters}m, heading delta: ${headingDeltaDegrees.toFixed(1)}° < ${this.options.minHeadingDeltaDegrees}°, elapsed: ${elapsedMs}ms < ${this.options.maxIdleIntervalMs}ms).`,
        metadata,
      };
    }

    // Point accepted: update state
    this.lastAcceptedPoint = { ...point };
    if (currentBearing !== null) {
      this.lastBearing = currentBearing;
    }

    return {
      accepted: true,
      point,
      message: 'Point accepted.',
      metadata,
    };
  }
}
