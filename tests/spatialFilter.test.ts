import { describe, expect, it, beforeEach } from 'vitest';
import { SpatialFilter, DEFAULT_FILTER_OPTIONS } from '../src/filters/spatialFilter';
import { GPSPoint } from '../src/types';

describe('SpatialFilter', () => {
  let filter: SpatialFilter;

  beforeEach(() => {
    filter = new SpatialFilter();
  });

  it('initializes with default options', () => {
    expect(filter.getOptions()).toEqual(DEFAULT_FILTER_OPTIONS);
  });

  it('accepts initial valid GPS point unconditionally', () => {
    const point: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 10,
    };

    const res = filter.filter(point);
    expect(res.accepted).toBe(true);
    expect(filter.getLastAcceptedPoint()).toEqual(point);
  });

  it('rejects points with invalid coordinates', () => {
    const res = filter.filter({
      latitude: 105,
      longitude: 0,
      timestamp: 1000,
    });

    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('INVALID_COORDINATES');
  });

  it('rejects points where accuracy exceeds maxAccuracyMeters (default: 50m)', () => {
    const res = filter.filter({
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 65, // > 50m
    });

    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('ACCURACY_TOO_LOW');
  });

  it('drops stationary jitter points (distance < 25m, heading change < 20°, elapsed < 120s)', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 10,
      heading: 0,
    };
    filter.filter(p1);

    // Drifts 5 meters North 5 seconds later with identical heading
    // 1 deg lat is ~111,320m, so 5m is ~0.000045 deg
    const p2: GPSPoint = {
      latitude: 51.5074 + 0.000045,
      longitude: -0.1278,
      timestamp: 1000000 + 5000,
      accuracy: 10,
      heading: 0,
    };

    const res = filter.filter(p2);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('BELOW_SPATIAL_THRESHOLD');
    expect(res.metadata?.distanceMeters).toBeLessThan(25);
    expect(res.metadata?.headingDeltaDegrees).toBeLessThan(20);
  });

  it('accepts points after moving past minDistanceMeters (default: 25m)', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 10,
    };
    filter.filter(p1);

    // Moves ~50 meters North over 5 seconds (speed = 10 m/s < 65 m/s)
    const p2: GPSPoint = {
      latitude: 51.5074 + 0.00045,
      longitude: -0.1278,
      timestamp: 1000000 + 5000,
      accuracy: 10,
    };

    const res = filter.filter(p2);
    expect(res.accepted).toBe(true);
    expect(res.metadata?.distanceMeters).toBeGreaterThan(25);
  });

  it('sharp turns trigger point capture even over short distances (< 25m)', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 10,
      heading: 0, // Heading North
    };
    filter.filter(p1);

    // Moved only 10 meters, but turned 90° East
    const p2: GPSPoint = {
      latitude: 51.5074 + 0.00009,
      longitude: -0.1278,
      timestamp: 1000000 + 3000,
      accuracy: 10,
      heading: 90, // Heading East: delta = 90° >= 20°
    };

    const res = filter.filter(p2);
    expect(res.accepted).toBe(true);
    expect(res.metadata?.headingDeltaDegrees).toBe(90);
    expect(res.metadata?.distanceMeters).toBeLessThan(25);
  });

  it('captures point after maxIdleIntervalMs (120s) even with stationary jitter', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 10,
      heading: 0,
    };
    filter.filter(p1);

    // 130 seconds later (idle heartbeat), minimal drift 3m
    const p2: GPSPoint = {
      latitude: 51.5074 + 0.000027,
      longitude: -0.1278,
      timestamp: 1000000 + 130000,
      accuracy: 10,
      heading: 0,
    };

    const res = filter.filter(p2);
    expect(res.accepted).toBe(true);
  });

  it('rejects GPS teleportation spikes exceeding maxSpeedMps (default: 65 m/s ~ 234 km/h)', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000000,
      accuracy: 10,
    };
    filter.filter(p1);

    // Glitch teleportation: 1000 meters in 1 second (1000 m/s > 65 m/s)
    const p2: GPSPoint = {
      latitude: 51.5074 + 0.009,
      longitude: -0.1278,
      timestamp: 1000000 + 1000,
      accuracy: 10,
    };

    const res = filter.filter(p2);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('SPEED_EXCEEDS_MAX');
    expect(res.metadata?.impliedSpeedMps).toBeGreaterThan(65);
  });

  it('rejects points with non-chronological timestamps', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 5000,
      accuracy: 10,
    };
    filter.filter(p1);

    const p2: GPSPoint = {
      latitude: 51.5074 + 0.0005,
      longitude: -0.1278,
      timestamp: 4000, // Earlier than 5000
      accuracy: 10,
    };

    const res = filter.filter(p2);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('NON_CHRONOLOGICAL_TIMESTAMP');
  });

  it('supports resetting and manual state restoration', () => {
    const p1: GPSPoint = {
      latitude: 51.5074,
      longitude: -0.1278,
      timestamp: 1000,
      accuracy: 10,
    };
    filter.filter(p1);
    expect(filter.getLastAcceptedPoint()).not.toBeNull();

    filter.reset();
    expect(filter.getLastAcceptedPoint()).toBeNull();

    filter.setLastAcceptedPoint(p1);
    expect(filter.getLastAcceptedPoint()?.latitude).toBe(p1.latitude);
  });
});
