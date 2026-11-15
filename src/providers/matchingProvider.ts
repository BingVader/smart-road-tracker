/**
 * @file matchingProvider.ts
 * Base interface and helper types for map-matching providers.
 */

import { GPSPoint, MatchedRouteResult, MatchingProvider } from '../types';
import { pointsToLineString } from '../utils/geoMath';

export type { MatchingProvider };

/**
 * Creates a fallback route from raw GPS coordinates when map-matching is unavailable or fails.
 *
 * @param points Raw filtered GPS points
 * @param reason Optional explanation for fallback
 * @returns MatchedRouteResult with isFallback set to true
 */
export function createFallbackRoute(points: GPSPoint[]): MatchedRouteResult {
  return {
    geometry: pointsToLineString(points),
    confidence: 0,
    distanceMeters: undefined,
    durationSeconds: undefined,
    matchedPoints: points.map((p, index) => ({
      originalIndex: index,
      location: [p.longitude, p.latitude],
    })),
    isFallback: true,
    rawPoints: points.map((p) => ({ ...p })),
  };
}
