/**
 * @file index.ts
 * Main package entry point for smart-road-tracker.
 */

// Core state machine
export { RoadTracker } from './tracker';

// Types
export type {
  GPSPoint,
  GeoJSONPosition,
  GeoJSONLineString,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  FilterOptions,
  FilterRejectReason,
  FilterMetadata,
  FilterResult,
  MatchedPoint,
  MatchedRouteResult,
  MatchingProvider,
  StorageAdapter,
  TrackerConfig,
  TrackerEventMap,
  TrackerState,
} from './types';

// Spatial Filter
export {
  SpatialFilter,
  DEFAULT_FILTER_OPTIONS,
} from './filters/spatialFilter';

// Storage Adapters
export type { StorageAdapter as IStorageAdapter } from './storage/storageAdapter';
export { MemoryStorage } from './storage/memoryStorage';
export {
  WebStorageAdapter,
  LocalStorageAdapter,
  type WebStorageOptions,
} from './storage/webStorage';

// Map-Matching Providers
export {
  createFallbackRoute,
} from './providers/matchingProvider';
export {
  OSRMProvider,
  type OSRMProviderOptions,
} from './providers/osrmProvider';
export {
  MapboxProvider,
  type MapboxProviderOptions,
} from './providers/mapboxProvider';
export {
  CustomBackendProvider,
  type CustomBackendProviderOptions,
} from './providers/customProvider';

// Geospatial Math & Polyline Utilities
export {
  EARTH_RADIUS_METERS,
  toRadians,
  toDegrees,
  isValidCoordinate,
  haversineDistance,
  initialBearing,
  bearingDelta,
  decodePolyline,
  encodePolyline,
  stitchLineStrings,
  pointsToLineString,
} from './utils/geoMath';
