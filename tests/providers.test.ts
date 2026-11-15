import { describe, expect, it, vi } from 'vitest';
import { OSRMProvider } from '../src/providers/osrmProvider';
import { MapboxProvider } from '../src/providers/mapboxProvider';
import { CustomBackendProvider } from '../src/providers/customProvider';
import { GPSPoint } from '../src/types';

describe('Map-Matching Providers', () => {
  const samplePoints: GPSPoint[] = [
    { latitude: 52.517037, longitude: 13.38886, timestamp: 1700000000000, accuracy: 15 },
    { latitude: 52.517245, longitude: 13.38915, timestamp: 1700000010000, accuracy: 20 },
    { latitude: 52.51755, longitude: 13.38965, timestamp: 1700000020000, accuracy: 10 },
  ];

  describe('OSRMProvider', () => {
    it('constructs correct URL with coordinates, timestamps, and radiuses', () => {
      const provider = new OSRMProvider({
        baseUrl: 'https://router.project-osrm.org',
        profile: 'driving',
        minRadiusMeters: 5,
        maxRadiusMeters: 50,
      });

      const urlString = provider.buildUrl(samplePoints);
      const url = new URL(urlString);

      expect(url.origin).toBe('https://router.project-osrm.org');
      expect(url.pathname).toBe(
        '/match/v1/driving/13.388860,52.517037;13.389150,52.517245;13.389650,52.517550'
      );
      expect(url.searchParams.get('geometries')).toBe('geojson');
      expect(url.searchParams.get('overview')).toBe('full');
      expect(url.searchParams.get('timestamps')).toBe('1700000000;1700000010;1700000020');
      expect(url.searchParams.get('radiuses')).toBe('15;20;10');
    });

    it('returns fallback route without network request if fewer than 2 points', async () => {
      const mockFetch = vi.fn();
      const provider = new OSRMProvider({ customFetch: mockFetch as unknown as typeof fetch });

      const result = await provider.match([samplePoints[0]!]);
      expect(result.isFallback).toBe(true);
      expect(result.geometry.coordinates).toEqual([[13.38886, 52.517037]]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('parses valid OSRM match response successfully', async () => {
      const mockResponse = {
        code: 'Ok',
        matchings: [
          {
            confidence: 0.94,
            distance: 125.4,
            duration: 15.2,
            geometry: {
              type: 'LineString',
              coordinates: [
                [13.38886, 52.517037],
                [13.38915, 52.517245],
                [13.38965, 52.51755],
              ],
            },
          },
        ],
        tracepoints: [
          { location: [13.388862, 52.517039], name: 'Unter den Linden', matchings_index: 0, waypoint_index: 0 },
          { location: [13.389152, 52.517247], name: 'Unter den Linden', matchings_index: 0, waypoint_index: 1 },
          { location: [13.389651, 52.517552], name: 'Unter den Linden', matchings_index: 0, waypoint_index: 2 },
        ],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const provider = new OSRMProvider({ customFetch: mockFetch as unknown as typeof fetch });
      const result = await provider.match(samplePoints);

      expect(result.isFallback).toBe(false);
      expect(result.confidence).toBe(0.94);
      expect(result.distanceMeters).toBe(125.4);
      expect(result.durationSeconds).toBe(15.2);
      expect(result.geometry.coordinates.length).toBe(3);
      expect(result.matchedPoints?.length).toBe(3);
      expect(result.matchedPoints?.[0]?.roadName).toBe('Unter den Linden');
    });

    it('gracefully falls back on NoMatch when fallbackOnNoMatch is true', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 'NoMatch' }),
      });

      const provider = new OSRMProvider({
        fallbackOnNoMatch: true,
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await provider.match(samplePoints);
      expect(result.isFallback).toBe(true);
      expect(result.geometry.coordinates.length).toBe(3);
    });

    it('throws error on NoMatch when fallbackOnNoMatch is false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 'NoMatch' }),
      });

      const provider = new OSRMProvider({
        fallbackOnNoMatch: false,
        customFetch: mockFetch as unknown as typeof fetch,
      });

      await expect(provider.match(samplePoints)).rejects.toThrow(/NoMatch/);
    });
  });

  describe('MapboxProvider', () => {
    it('throws error if accessToken is omitted', () => {
      expect(() => new MapboxProvider({ accessToken: '' })).toThrow(/accessToken/);
    });

    it('constructs correct Mapbox API URL', () => {
      const provider = new MapboxProvider({
        accessToken: 'pk.mock_token_123',
        profile: 'driving-traffic',
      });

      const urlString = provider.buildUrl(samplePoints);
      const url = new URL(urlString);

      expect(url.origin).toBe('https://api.mapbox.com');
      expect(url.pathname).toContain('/matching/v5/mapbox/driving-traffic/');
      expect(url.searchParams.get('access_token')).toBe('pk.mock_token_123');
      expect(url.searchParams.get('geometries')).toBe('geojson');
    });

    it('parses valid Mapbox response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'Ok',
          matchings: [
            {
              confidence: 0.88,
              distance: 210,
              duration: 30,
              geometry: {
                type: 'LineString',
                coordinates: [
                  [13.38886, 52.517037],
                  [13.38965, 52.51755],
                ],
              },
            },
          ],
          tracepoints: [
            { location: [13.38886, 52.517037], name: 'Broadway', matchings_index: 0, waypoint_index: 0 },
            { location: [13.38965, 52.51755], name: 'Broadway', matchings_index: 0, waypoint_index: 1 },
          ],
        }),
      });

      const provider = new MapboxProvider({
        accessToken: 'pk.test',
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await provider.match(samplePoints);
      expect(result.isFallback).toBe(false);
      expect(result.confidence).toBe(0.88);
      expect(result.matchedPoints?.length).toBe(2);
    });
  });

  describe('CustomBackendProvider', () => {
    it('sends POST payload and parses standard LineString response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          type: 'LineString',
          coordinates: [
            [13.38886, 52.517037],
            [13.38965, 52.51755],
          ],
        }),
      });

      const provider = new CustomBackendProvider({
        endpointUrl: 'https://api.myrouting.com/v1/match',
        headers: { Authorization: 'Bearer test-jwt' },
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await provider.match(samplePoints);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.myrouting.com/v1/match',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt',
          }),
        })
      );

      expect(result.isFallback).toBe(false);
      expect(result.geometry.coordinates.length).toBe(2);
    });

    it('supports custom request and response transformers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          snappedPath: [
            [13.38886, 52.517037],
            [13.38965, 52.51755],
          ],
          score: 0.99,
        }),
      });

      const provider = new CustomBackendProvider({
        endpointUrl: 'https://api.custom.com/match',
        transformRequest: (points) => ({
          coords: points.map((p) => [p.latitude, p.longitude]),
        }),
        transformResponse: (data) => {
          const res = data as { snappedPath: [number, number][]; score: number };
          return {
            geometry: {
              type: 'LineString',
              coordinates: res.snappedPath,
            },
            confidence: res.score,
          };
        },
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await provider.match(samplePoints);
      expect(result.confidence).toBe(0.99);
      expect(result.geometry.coordinates.length).toBe(2);
    });
  });
});
