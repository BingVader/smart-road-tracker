/**
 * @file geoMath.ts
 * Exact geospatial mathematics, geodesy formulas, and polyline utilities.
 * Zero external runtime dependencies.
 */

import {
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  GeoJSONLineString,
  GeoJSONPoint,
  GPSPoint,
} from '../types';

/** Earth mean radius in meters according to WGS-84 standard */
export const EARTH_RADIUS_METERS = 6371008.8;

/**
 * Converts degrees to radians.
 * @param degrees Angle in decimal degrees
 */
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180.0;
}

/**
 * Converts radians to degrees.
 * @param radians Angle in radians
 */
export function toDegrees(radians: number): number {
  return (radians * 180.0) / Math.PI;
}

/**
 * Validates whether latitude and longitude are valid WGS-84 coordinates.
 * @param lat Latitude (-90 to 90)
 * @param lon Longitude (-180 to 180)
 */
export function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Calculates the great-circle distance between two points on Earth using the Haversine formula.
 *
 * @param lat1 Latitude of first point in decimal degrees
 * @param lon1 Longitude of first point in decimal degrees
 * @param lat2 Latitude of second point in decimal degrees
 * @param lon2 Longitude of second point in decimal degrees
 * @returns Distance in meters
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (lat1 === lat2 && lon1 === lon2) {
    return 0;
  }

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lon2 - lon1);

  const sinHalfDeltaPhi = Math.sin(deltaPhi / 2.0);
  const sinHalfDeltaLambda = Math.sin(deltaLambda / 2.0);

  const a =
    sinHalfDeltaPhi * sinHalfDeltaPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinHalfDeltaLambda * sinHalfDeltaLambda;

  // Clamp 'a' to [0, 1] to prevent floating point domain errors in Math.asin / Math.atan2
  const clampedA = Math.max(0, Math.min(1, a));
  const c = 2.0 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1.0 - clampedA));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculates the initial bearing (forward azimuth) from point 1 to point 2 in degrees.
 * Output is normalized to the range [0, 360).
 * 0° = True North, 90° = East, 180° = South, 270° = West.
 *
 * @param lat1 Latitude of start point
 * @param lon1 Longitude of start point
 * @param lat2 Latitude of destination point
 * @param lon2 Longitude of destination point
 * @returns Initial bearing in degrees from 0 to 360
 */
export function initialBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  const degrees = toDegrees(theta);

  // Normalize to 0° - 360°
  return (degrees + 360.0) % 360.0;
}

/**
 * Calculates the minimal absolute angular difference between two bearings in degrees.
 * The result is always in the range [0, 180].
 *
 * @param bearing1 First bearing in degrees
 * @param bearing2 Second bearing in degrees
 * @returns Shortest angular difference in degrees [0, 180]
 */
export function bearingDelta(bearing1: number, bearing2: number): number {
  const diff = Math.abs((bearing1 % 360.0) - (bearing2 % 360.0)) % 360.0;
  return diff > 180.0 ? 360.0 - diff : diff;
}

/**
 * Decodes an encoded polyline string (e.g. Google Polyline or Polyline6)
 * into an array of GeoJSON coordinates [longitude, latitude].
 *
 * @param encoded The polyline string
 * @param precision Coordinate precision (5 for standard 1e-5, 6 for Polyline6 1e-6)
 * @returns Array of [longitude, latitude] coordinates
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = Math.pow(10, precision);

  while (index < encoded.length) {
    let byte: number;
    let shift = 0;
    let result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    // GeoJSON position is [longitude, latitude]
    coordinates.push([lng / factor, lat / factor]);
  }

  return coordinates;
}

/**
 * Encodes an array of GeoJSON coordinates [longitude, latitude] into an encoded polyline string.
 *
 * @param coordinates Array of [longitude, latitude]
 * @param precision Coordinate precision (5 for standard, 6 for Polyline6)
 */
export function encodePolyline(
  coordinates: [number, number][],
  precision = 5
): string {
  const factor = Math.pow(10, precision);
  let output = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lng, lat] of coordinates) {
    const latScaled = Math.round(lat * factor);
    const lngScaled = Math.round(lng * factor);

    const deltaLat = latScaled - prevLat;
    const deltaLng = lngScaled - prevLng;

    prevLat = latScaled;
    prevLng = lngScaled;

    output += encodeSignedNumber(deltaLat);
    output += encodeSignedNumber(deltaLng);
  }

  return output;
}

function encodeSignedNumber(num: number): string {
  let sgnNum = num < 0 ? ~(num << 1) : num << 1;
  let encoded = '';

  while (sgnNum >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  encoded += String.fromCharCode(sgnNum + 63);
  return encoded;
}

/**
 * Stitches multiple GeoJSON LineStrings together into one continuous line,
 * avoiding duplicate points when the end of one geometry connects to the start of the next.
 *
 * @param lineStrings Array of GeoJSON LineString objects
 * @returns Single unified GeoJSON LineString
 */
export function stitchLineStrings(lineStrings: GeoJSONLineString[]): GeoJSONLineString {
  const combinedCoordinates: [number, number][] = [];

  for (const ls of lineStrings) {
    for (const coord of ls.coordinates) {
      if (combinedCoordinates.length === 0) {
        combinedCoordinates.push([coord[0], coord[1]]);
      } else {
        const last = combinedCoordinates[combinedCoordinates.length - 1];
        if (last) {
          // If the point is identical or within sub-millimeter precision, avoid duplicate vertex
          const isIdentical =
            Math.abs(last[0] - coord[0]) < 1e-7 &&
            Math.abs(last[1] - coord[1]) < 1e-7;

          if (!isIdentical) {
            combinedCoordinates.push([coord[0], coord[1]]);
          }
        }
      }
    }
  }

  return {
    type: 'LineString',
    coordinates: combinedCoordinates,
  };
}

/**
 * Converts an array of GPSPoint objects into a standard GeoJSON LineString.
 *
 * @param points Array of GPS points
 * @returns GeoJSON LineString [longitude, latitude]
 */
export function pointsToLineString(points: GPSPoint[]): GeoJSONLineString {
  return {
    type: 'LineString',
    coordinates: points.map((p) => [p.longitude, p.latitude]),
  };
}

/**
 * Calculates total cumulative distance in meters along a polyline / coordinate path.
 *
 * @param coordinates Array of GeoJSON [longitude, latitude] coordinates
 * @returns Total distance in meters
 */
export function calculateRouteDistance(coordinates: [number, number][]): number {
  if (coordinates.length < 2) {
    return 0;
  }

  let totalDistance = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const prev = coordinates[i - 1];
    const curr = coordinates[i];
    if (prev && curr) {
      totalDistance += haversineDistance(prev[1], prev[0], curr[1], curr[0]);
    }
  }

  return totalDistance;
}

/**
 * Calculates the total elapsed duration in seconds between the first and last point.
 *
 * @param points Array of GPS points
 * @returns Duration in seconds (or 0 if fewer than 2 points)
 */
export function calculateRouteDuration(points: GPSPoint[]): number {
  if (points.length < 2) {
    return 0;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return 0;
  }
  const elapsedMs = Math.max(0, last.timestamp - first.timestamp);
  return elapsedMs / 1000;
}

/**
 * Calculates the average speed in meters per second across a set of GPS points.
 *
 * @param points Array of GPS points
 * @param distanceMeters Optional distance override (e.g. matched distance). If not provided, computed from raw points.
 * @returns Average speed in meters per second (m/s)
 */
export function calculateAverageSpeed(
  points: GPSPoint[],
  distanceMeters?: number
): number {
  const durationSec = calculateRouteDuration(points);
  if (durationSec <= 0) {
    return 0;
  }
  const dist =
    distanceMeters !== undefined
      ? distanceMeters
      : calculateRouteDistance(points.map((p) => [p.longitude, p.latitude]));

  return dist / durationSec;
}

/**
 * Wraps a GeoJSON LineString geometry in a standard GeoJSON Feature object.
 *
 * @param lineString The GeoJSON LineString geometry
 * @param properties Optional properties object
 * @returns GeoJSON Feature object
 */
export function routeToFeature<P = Record<string, unknown>>(
  lineString: GeoJSONLineString,
  properties: P = {} as P
): GeoJSONFeature<GeoJSONLineString, P> {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [...lineString.coordinates],
    },
    properties,
  };
}

/**
 * Converts an array of GPSPoint objects into a GeoJSON FeatureCollection of Point features,
 * retaining point properties such as timestamp, accuracy, speed, heading, and altitude.
 *
 * @param points Array of GPS points
 * @returns GeoJSON FeatureCollection of Points
 */
export function pointsToFeatureCollection(
  points: GPSPoint[]
): GeoJSONFeatureCollection<GeoJSONPoint, Record<string, unknown>> {
  return {
    type: 'FeatureCollection',
    features: points.map((p, index) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          p.longitude,
          p.latitude,
          ...(p.altitude !== undefined ? [p.altitude] : []),
        ] as [number, number] | [number, number, number],
      },
      properties: {
        index,
        timestamp: p.timestamp,
        accuracy: p.accuracy,
        speed: p.speed,
        heading: p.heading,
        altitude: p.altitude,
      },
    })),
  };
}
