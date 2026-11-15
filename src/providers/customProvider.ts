/**
 * @file customProvider.ts
 * Generic REST endpoint adapter for custom backend map-matching services.
 */

import {
  GeoJSONLineString,
  GPSPoint,
  MatchedPoint,
  MatchedRouteResult,
  MatchingProvider,
} from '../types';
import { pointsToLineString } from '../utils/geoMath';
import { createFallbackRoute } from './matchingProvider';

export interface CustomBackendProviderOptions {
  /** Target backend URL endpoint */
  endpointUrl: string;
  /** HTTP method: defaults to 'POST' */
  method?: 'POST' | 'PUT';
  /** Optional custom headers (e.g. Authorization, X-API-Key) */
  headers?: Record<string, string>;
  /** Optional request transformer function to customize payload structure */
  transformRequest?: (points: GPSPoint[]) => unknown;
  /** Optional response transformer to handle proprietary backend schemas */
  transformResponse?: (
    responseData: unknown,
    rawPoints: GPSPoint[]
  ) => Partial<MatchedRouteResult> | GeoJSONLineString;
  /** Automatically return fallback raw points on failure instead of throwing */
  fallbackOnError?: boolean;
  /** Custom fetch function */
  customFetch?: typeof fetch;
}

export class CustomBackendProvider implements MatchingProvider {
  public readonly name = 'custom-backend';
  private readonly endpointUrl: string;
  private readonly method: 'POST' | 'PUT';
  private readonly headers: Record<string, string>;
  private readonly transformRequest?: (points: GPSPoint[]) => unknown;
  private readonly transformResponse?: (
    responseData: unknown,
    rawPoints: GPSPoint[]
  ) => Partial<MatchedRouteResult> | GeoJSONLineString;
  private readonly fallbackOnError: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: CustomBackendProviderOptions) {
    if (!options || !options.endpointUrl) {
      throw new Error('CustomBackendProvider requires endpointUrl.');
    }
    this.endpointUrl = options.endpointUrl;
    this.method = options.method ?? 'POST';
    this.headers = options.headers ?? {};
    this.transformRequest = options.transformRequest;
    this.transformResponse = options.transformResponse;
    this.fallbackOnError = options.fallbackOnError ?? false;
    this.fetchFn = options.customFetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Sends GPS points to custom backend and parses standard GeoJSON result.
   * @param points Array of GPS points
   */
  public async match(points: GPSPoint[]): Promise<MatchedRouteResult> {
    if (points.length < 2) {
      return createFallbackRoute(points);
    }

    try {
      const payload = this.transformRequest
        ? this.transformRequest(points)
        : { points };

      const response = await this.fetchFn(this.endpointUrl, {
        method: this.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(
          `Custom backend request failed with HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as unknown;

      // Handle custom response transformer if provided
      if (this.transformResponse) {
        const transformed = this.transformResponse(data, points);
        if ('type' in transformed && transformed.type === 'LineString') {
          return {
            geometry: transformed as GeoJSONLineString,
            isFallback: false,
            rawPoints: points.map((p) => ({ ...p })),
          };
        }
        const partialResult = transformed as Partial<MatchedRouteResult>;
        return {
          geometry: partialResult.geometry ?? pointsToLineString(points),
          confidence: partialResult.confidence,
          distanceMeters: partialResult.distanceMeters,
          durationSeconds: partialResult.durationSeconds,
          matchedPoints: partialResult.matchedPoints,
          isFallback: partialResult.isFallback ?? false,
          rawPoints: points.map((p) => ({ ...p })),
        };
      }

      // Default parser: inspect common JSON response formats
      const record = data as Record<string, unknown>;

      // Format A: Direct GeoJSON LineString: { type: 'LineString', coordinates: [...] }
      if (
        record &&
        record['type'] === 'LineString' &&
        Array.isArray(record['coordinates'])
      ) {
        return {
          geometry: record as unknown as GeoJSONLineString,
          isFallback: false,
          rawPoints: points.map((p) => ({ ...p })),
        };
      }

      // Format B: GeoJSON Feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [...] } }
      if (
        record &&
        record['type'] === 'Feature' &&
        record['geometry'] &&
        typeof record['geometry'] === 'object' &&
        (record['geometry'] as Record<string, unknown>)['type'] === 'LineString'
      ) {
        return {
          geometry: (record['geometry'] as Record<string, unknown>) as unknown as GeoJSONLineString,
          isFallback: false,
          rawPoints: points.map((p) => ({ ...p })),
        };
      }

      // Format C: Standard result wrapper: { geometry: { type: 'LineString', ... }, confidence?: ... }
      if (
        record &&
        record['geometry'] &&
        typeof record['geometry'] === 'object' &&
        (record['geometry'] as Record<string, unknown>)['type'] === 'LineString'
      ) {
        return {
          geometry: (record['geometry'] as Record<string, unknown>) as unknown as GeoJSONLineString,
          confidence:
            typeof record['confidence'] === 'number'
              ? record['confidence']
              : undefined,
          distanceMeters:
            typeof record['distanceMeters'] === 'number'
              ? record['distanceMeters']
              : typeof record['distance'] === 'number'
              ? record['distance']
              : undefined,
          durationSeconds:
            typeof record['durationSeconds'] === 'number'
              ? record['durationSeconds']
              : typeof record['duration'] === 'number'
              ? record['duration']
              : undefined,
          matchedPoints: Array.isArray(record['matchedPoints'])
            ? (record['matchedPoints'] as MatchedPoint[])
            : undefined,
          isFallback: Boolean(record['isFallback'] ?? false),
          rawPoints: points.map((p) => ({ ...p })),
        };
      }

      throw new Error(
        'Custom backend response did not contain a valid GeoJSON LineString or geometry structure.'
      );
    } catch (err) {
      if (this.fallbackOnError) {
        return createFallbackRoute(points);
      }
      throw err;
    }
  }
}
