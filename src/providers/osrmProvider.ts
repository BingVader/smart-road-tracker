/**
 * @file osrmProvider.ts
 * Open Source Routing Machine (OSRM) Match API v1 adapter.
 */

import {
  GPSPoint,
  MatchedPoint,
  MatchedRouteResult,
  MatchingProvider,
} from '../types';
import { stitchLineStrings } from '../utils/geoMath';
import { createFallbackRoute } from './matchingProvider';

export interface OSRMProviderOptions {
  /**
   * Base URL of the OSRM server.
   * Defaults to public demo server: 'https://router.project-osrm.org'
   */
  baseUrl?: string;
  /**
   * Routing profile (e.g., 'driving', 'car', 'bike', 'foot').
   * Defaults to 'driving'.
   */
  profile?: string;
  /**
   * Default search radius in meters when GPS accuracy is missing.
   * Defaults to 25.
   */
  defaultRadiusMeters?: number;
  /**
   * Minimum search radius in meters to clamp point accuracy.
   * Defaults to 5.
   */
  minRadiusMeters?: number;
  /**
   * Maximum search radius in meters to clamp point accuracy.
   * Defaults to 50.
   */
  maxRadiusMeters?: number;
  /**
   * Whether to include timestamps in the request.
   * Defaults to true.
   */
  includeTimestamps?: boolean;
  /**
   * Whether to include search radiuses in the request.
   * Defaults to true.
   */
  includeRadiuses?: boolean;
  /**
   * Automatically fall back to raw coordinates when OSRM returns 'NoMatch'.
   * Defaults to true.
   */
  fallbackOnNoMatch?: boolean;
  /**
   * Custom fetch function (useful for Node testing or proxies).
   */
  customFetch?: typeof fetch;
}

interface OSRMMatching {
  confidence: number;
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
  distance: number;
  duration: number;
}

interface OSRMTracepoint {
  matchings_index: number;
  waypoint_index: number;
  name: string;
  location: [number, number];
}

interface OSRMMatchResponse {
  code: string;
  message?: string;
  matchings?: OSRMMatching[];
  tracepoints?: (OSRMTracepoint | null)[];
}

export class OSRMProvider implements MatchingProvider {
  public readonly name = 'osrm';
  private readonly baseUrl: string;
  private readonly profile: string;
  private readonly defaultRadiusMeters: number;
  private readonly minRadiusMeters: number;
  private readonly maxRadiusMeters: number;
  private readonly includeTimestamps: boolean;
  private readonly includeRadiuses: boolean;
  private readonly fallbackOnNoMatch: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options?: OSRMProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? 'https://router.project-osrm.org').replace(
      /\/+$/,
      ''
    );
    this.profile = options?.profile ?? 'driving';
    this.defaultRadiusMeters = options?.defaultRadiusMeters ?? 25;
    this.minRadiusMeters = options?.minRadiusMeters ?? 5;
    this.maxRadiusMeters = options?.maxRadiusMeters ?? 50;
    this.includeTimestamps = options?.includeTimestamps ?? true;
    this.includeRadiuses = options?.includeRadiuses ?? true;
    this.fallbackOnNoMatch = options?.fallbackOnNoMatch ?? true;
    this.fetchFn = options?.customFetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Builds the formatted OSRM Match API URL for the given points.
   * @param points Array of GPS points
   */
  public buildUrl(points: GPSPoint[]): string {
    const coordinates = points
      .map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`)
      .join(';');

    const url = new URL(
      `${this.baseUrl}/match/v1/${this.profile}/${coordinates}`
    );

    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('overview', 'full');

    if (this.includeTimestamps) {
      const timestamps = points
        .map((p) => Math.floor(p.timestamp / 1000))
        .join(';');
      url.searchParams.set('timestamps', timestamps);
    }

    if (this.includeRadiuses) {
      const radiuses = points
        .map((p) => {
          const acc = p.accuracy ?? this.defaultRadiusMeters;
          const clamped = Math.max(
            this.minRadiusMeters,
            Math.min(this.maxRadiusMeters, Math.round(acc))
          );
          return clamped.toString();
        })
        .join(';');
      url.searchParams.set('radiuses', radiuses);
    }

    return url.toString();
  }

  /**
   * Matches raw GPS points to road segments via OSRM Match API.
   * @param points Array of GPS points
   */
  public async match(points: GPSPoint[]): Promise<MatchedRouteResult> {
    if (points.length < 2) {
      return createFallbackRoute(points);
    }

    const requestUrl = this.buildUrl(points);

    const response = await this.fetchFn(requestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `OSRM request failed with HTTP ${response.status}: ${response.statusText}`
      );
    }

    const data = (await response.json()) as OSRMMatchResponse;

    if (data.code === 'NoMatch') {
      if (this.fallbackOnNoMatch) {
        return createFallbackRoute(points);
      }
      throw new Error('OSRM Match API returned NoMatch: no matching road segment found.');
    }

    if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
      throw new Error(
        `OSRM Match API returned error code ${data.code}${data.message ? `: ${data.message}` : ''}`
      );
    }

    // Stitch geometries if multiple matching sub-traces are returned
    const geometry =
      data.matchings.length === 1 && data.matchings[0]
        ? data.matchings[0].geometry
        : stitchLineStrings(data.matchings.map((m) => m.geometry));

    let totalDistance = 0;
    let totalDuration = 0;
    let totalConfidence = 0;

    for (const m of data.matchings) {
      totalDistance += m.distance ?? 0;
      totalDuration += m.duration ?? 0;
      totalConfidence += m.confidence ?? 0;
    }

    const averageConfidence = totalConfidence / data.matchings.length;

    const matchedPoints: MatchedPoint[] = [];
    if (data.tracepoints) {
      for (let i = 0; i < data.tracepoints.length; i++) {
        const tp = data.tracepoints[i];
        if (tp) {
          matchedPoints.push({
            originalIndex: i,
            location: tp.location,
            roadName: tp.name || undefined,
          });
        }
      }
    }

    return {
      geometry,
      confidence: averageConfidence,
      distanceMeters: totalDistance,
      durationSeconds: totalDuration,
      matchedPoints,
      isFallback: false,
      rawPoints: points.map((p) => ({ ...p })),
    };
  }
}
