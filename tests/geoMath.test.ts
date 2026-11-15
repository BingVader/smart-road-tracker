import { describe, expect, it } from 'vitest';
import {
  bearingDelta,
  decodePolyline,
  EARTH_RADIUS_METERS,
  encodePolyline,
  haversineDistance,
  initialBearing,
  isValidCoordinate,
  pointsToLineString,
  stitchLineStrings,
  toDegrees,
  toRadians,
} from '../src/utils/geoMath';
import { GPSPoint } from '../src/types';

describe('geoMath utilities', () => {
  it('converts degrees to radians and vice versa', () => {
    expect(toRadians(0)).toBe(0);
    expect(toRadians(180)).toBeCloseTo(Math.PI);
    expect(toDegrees(Math.PI)).toBeCloseTo(180);
    expect(toDegrees(Math.PI / 2)).toBeCloseTo(90);
  });

  describe('isValidCoordinate', () => {
    it('returns true for valid coordinates', () => {
      expect(isValidCoordinate(0, 0)).toBe(true);
      expect(isValidCoordinate(51.5074, -0.1278)).toBe(true);
      expect(isValidCoordinate(90, 180)).toBe(true);
      expect(isValidCoordinate(-90, -180)).toBe(true);
    });

    it('returns false for invalid coordinates', () => {
      expect(isValidCoordinate(91, 0)).toBe(false);
      expect(isValidCoordinate(-91, 0)).toBe(false);
      expect(isValidCoordinate(0, 181)).toBe(false);
      expect(isValidCoordinate(0, -181)).toBe(false);
      expect(isValidCoordinate(NaN, 0)).toBe(false);
      expect(isValidCoordinate(0, Infinity)).toBe(false);
    });
  });

  describe('haversineDistance', () => {
    it('returns 0 for identical points', () => {
      const dist = haversineDistance(51.5074, -0.1278, 51.5074, -0.1278);
      expect(dist).toBe(0);
    });

    it('calculates accurate distance between London and Paris (~343 km)', () => {
      // London: 51.5074, -0.1278; Paris: 48.8566, 2.3522
      const dist = haversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
      expect(dist).toBeGreaterThan(340000);
      expect(dist).toBeLessThan(346000);
    });

    it('calculates short distances accurately (~111m per 0.001 deg lat at equator)', () => {
      const dist = haversineDistance(0, 0, 0.001, 0);
      expect(dist).toBeCloseTo((EARTH_RADIUS_METERS * Math.PI) / 180 / 1000, 0);
      expect(dist).toBeGreaterThan(110);
      expect(dist).toBeLessThan(112);
    });
  });

  describe('initialBearing', () => {
    it('returns 0° for point directly North', () => {
      const bearing = initialBearing(0, 0, 1, 0);
      expect(bearing).toBeCloseTo(0, 1);
    });

    it('returns 90° for point directly East on equator', () => {
      const bearing = initialBearing(0, 0, 0, 1);
      expect(bearing).toBeCloseTo(90, 1);
    });

    it('returns 180° for point directly South', () => {
      const bearing = initialBearing(1, 0, 0, 0);
      expect(bearing).toBeCloseTo(180, 1);
    });

    it('returns 270° for point directly West on equator', () => {
      const bearing = initialBearing(0, 1, 0, 0);
      expect(bearing).toBeCloseTo(270, 1);
    });
  });

  describe('bearingDelta', () => {
    it('calculates direct delta without wrap-around', () => {
      expect(bearingDelta(10, 30)).toBe(20);
      expect(bearingDelta(30, 10)).toBe(20);
      expect(bearingDelta(0, 180)).toBe(180);
    });

    it('calculates minimal delta across 0°/360° boundary', () => {
      expect(bearingDelta(350, 10)).toBe(20);
      expect(bearingDelta(10, 350)).toBe(20);
      expect(bearingDelta(355, 5)).toBe(10);
      expect(bearingDelta(1, 359)).toBe(2);
    });

    it('handles identical angles', () => {
      expect(bearingDelta(90, 90)).toBe(0);
      expect(bearingDelta(0, 360)).toBe(0);
    });
  });

  describe('decodePolyline & encodePolyline', () => {
    it('correctly decodes standard precision 5 polyline', () => {
      // Coordinates: [ [ -120.2, 38.5 ], [ -120.95, 40.7 ], [ -126.453, 43.252 ] ]
      const polyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
      const decoded = decodePolyline(polyline, 5);

      expect(decoded.length).toBe(3);
      expect(decoded[0]![0]).toBeCloseTo(-120.2, 5);
      expect(decoded[0]![1]).toBeCloseTo(38.5, 5);
      expect(decoded[1]![0]).toBeCloseTo(-120.95, 5);
      expect(decoded[1]![1]).toBeCloseTo(40.7, 5);
      expect(decoded[2]![0]).toBeCloseTo(-126.453, 5);
      expect(decoded[2]![1]).toBeCloseTo(43.252, 5);
    });

    it('encodes and decodes coordinates with round-trip fidelity', () => {
      const coords: [number, number][] = [
        [-73.98513, 40.748817],
        [-73.98412, 40.749912],
        [-73.98221, 40.75112],
      ];

      const encoded = encodePolyline(coords, 5);
      const decoded = decodePolyline(encoded, 5);

      expect(decoded.length).toBe(coords.length);
      for (let i = 0; i < coords.length; i++) {
        expect(decoded[i]![0]).toBeCloseTo(coords[i]![0], 4);
        expect(decoded[i]![1]).toBeCloseTo(coords[i]![1], 4);
      }
    });

    it('supports precision 6 (Polyline6)', () => {
      const coords: [number, number][] = [
        [13.38886, 52.517037],
        [13.38915, 52.517245],
      ];
      const encoded = encodePolyline(coords, 6);
      const decoded = decodePolyline(encoded, 6);

      expect(decoded.length).toBe(coords.length);
      expect(decoded[0]![0]).toBeCloseTo(coords[0]![0], 5);
      expect(decoded[0]![1]).toBeCloseTo(coords[0]![1], 5);
    });
  });

  describe('stitchLineStrings', () => {
    it('merges line strings without duplicate boundary vertices', () => {
      const ls1 = {
        type: 'LineString' as const,
        coordinates: [
          [-0.1, 51.5],
          [-0.2, 51.5],
        ] as [number, number][],
      };
      const ls2 = {
        type: 'LineString' as const,
        coordinates: [
          [-0.2, 51.5], // Identical junction point
          [-0.3, 51.5],
        ] as [number, number][],
      };

      const stitched = stitchLineStrings([ls1, ls2]);
      expect(stitched.coordinates.length).toBe(3);
      expect(stitched.coordinates).toEqual([
        [-0.1, 51.5],
        [-0.2, 51.5],
        [-0.3, 51.5],
      ]);
    });

    it('handles empty input gracefully', () => {
      const stitched = stitchLineStrings([]);
      expect(stitched.coordinates).toEqual([]);
    });
  });

  describe('pointsToLineString', () => {
    it('converts GPSPoint array to GeoJSON LineString [lon, lat]', () => {
      const points: GPSPoint[] = [
        { latitude: 51.5, longitude: -0.1, timestamp: 1000 },
        { latitude: 51.6, longitude: -0.2, timestamp: 2000 },
      ];
      const ls = pointsToLineString(points);
      expect(ls.type).toBe('LineString');
      expect(ls.coordinates).toEqual([
        [-0.1, 51.5],
        [-0.2, 51.6],
      ]);
    });
  });
});
