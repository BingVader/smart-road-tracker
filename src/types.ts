/**
 * @file types.ts
 * Strict TypeScript types and interfaces for the smart-road-tracker SDK.
 */

/**
 * Standard GPS coordinate point used across filters, storage, and matching providers.
 */
export interface GPSPoint {
  /** Latitude in decimal degrees (-90 to 90) */
  latitude: number;
  /** Longitude in decimal degrees (-180 to 180) */
  longitude: number;
  /** Timestamp in milliseconds since Unix epoch */
  timestamp: number;
  /** Horizontal accuracy radius in meters (optional) */
  accuracy?: number;
  /** Instantaneous speed in meters per second (optional) */
  speed?: number;
  /** Compass heading / course in degrees from true North (0 to 360) (optional) */
  heading?: number;
  /** Altitude in meters above WGS84 ellipsoid (optional) */
  altitude?: number;
}

/**
 * GeoJSON 2D/3D coordinate position [longitude, latitude, optional altitude].
 */
export type GeoJSONPosition = [number, number] | [number, number, number];

/**
 * GeoJSON Point geometry representation.
 */
export interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number] | [number, number, number];
}

/**
 * GeoJSON LineString geometry representation.
 */
export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: [number, number][];
}

/**
 * GeoJSON Feature representation.
 */
export interface GeoJSONFeature<G = GeoJSONLineString, P = Record<string, unknown>> {
  type: 'Feature';
  geometry: G;
  properties: P;
}

/**
 * GeoJSON FeatureCollection representation.
 */
export interface GeoJSONFeatureCollection<G = GeoJSONLineString, P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoJSONFeature<G, P>[];
}

/**
 * Summary metrics of a tracked trip or trajectory.
 */
export interface TripSummary {
  /** Total road-matched cumulative distance in meters */
  matchedDistanceMeters: number;
  /** Total raw GPS distance in meters */
  rawDistanceMeters: number;
  /** Total count of accepted GPS points */
  totalPointsAccepted: number;
  /** Timestamp of first accepted point in milliseconds, or undefined if empty */
  startTimeMs?: number;
  /** Timestamp of last accepted point in milliseconds, or undefined if empty */
  endTimeMs?: number;
  /** Total duration of the trip in seconds, or undefined if empty */
  durationSeconds?: number;
  /** Average speed across the trip in meters per second (based on matched distance), or undefined */
  averageSpeedMps?: number;
}

/**
 * Configuration options for the spatial noise filter.
 */
export interface FilterOptions {
  /** Maximum acceptable accuracy radius in meters (default: 50) */
  maxAccuracyMeters: number;
  /** Minimum distance required from last accepted point in meters (default: 25) */
  minDistanceMeters: number;
  /** Minimum heading/bearing delta required to accept a point below distance threshold in degrees (default: 20) */
  minHeadingDeltaDegrees: number;
  /** Maximum idle interval in milliseconds before forcing a point capture (default: 120000 = 2 min) */
  maxIdleIntervalMs: number;
  /** Maximum allowable implied speed in meters per second (default: 65 m/s ~ 234 km/h) */
  maxSpeedMps: number;
}

/**
 * Reason for dropping a GPS point.
 */
export type FilterRejectReason =
  | 'INVALID_COORDINATES'
  | 'ACCURACY_TOO_LOW'
  | 'BELOW_SPATIAL_THRESHOLD'
  | 'SPEED_EXCEEDS_MAX'
  | 'NON_CHRONOLOGICAL_TIMESTAMP';

/**
 * Diagnostic metadata returned by filter evaluation.
 */
export interface FilterMetadata {
  /** Distance in meters from previous accepted point */
  distanceMeters?: number;
  /** Change in heading or bearing from previous point in degrees */
  headingDeltaDegrees?: number;
  /** Calculated speed in m/s between previous and current point */
  impliedSpeedMps?: number;
  /** Time elapsed in milliseconds since last accepted point */
  elapsedMs?: number;
}

/**
 * Result of evaluating a GPS point through the spatial filter.
 */
export interface FilterResult {
  /** True if the point met all spatial criteria and was accepted */
  accepted: boolean;
  /** The original point evaluated */
  point: GPSPoint;
  /** Reason for rejection if accepted is false */
  reason?: FilterRejectReason;
  /** Human-readable explanation of filter decision */
  message?: string;
  /** Metric calculations computed during filter evaluation */
  metadata?: FilterMetadata;
}

/**
 * Individual point matched against a road network.
 */
export interface MatchedPoint {
  /** Index in the original input points array */
  originalIndex?: number;
  /** Matched coordinate [longitude, latitude] */
  location: [number, number];
  /** Name of the street or road segment (if provided by provider) */
  roadName?: string;
}

/**
 * Result returned by a map-matching provider.
 */
export interface MatchedRouteResult {
  /** GeoJSON LineString representing the road-snapped trajectory */
  geometry: GeoJSONLineString;
  /** Provider match confidence score between 0.0 and 1.0 (if available) */
  confidence?: number;
  /** Total route distance in meters (if calculated) */
  distanceMeters?: number;
  /** Estimated route duration in seconds (if calculated) */
  durationSeconds?: number;
  /** Detailed snapped points */
  matchedPoints?: MatchedPoint[];
  /** True if the provider failed or was bypassed and raw filtered points are returned */
  isFallback: boolean;
  /** The original raw points submitted for this match operation */
  rawPoints: GPSPoint[];
}

/**
 * Base interface for all pluggable map-matching providers.
 */
export interface MatchingProvider {
  /** Name identifier of the provider */
  readonly name: string;
  /**
   * Matches an array of filtered GPS points to a road network.
   * @param points Array of ordered GPS points.
   * @returns Promise resolving to the matched route result.
   */
  match(points: GPSPoint[]): Promise<MatchedRouteResult>;
}

/**
 * Pluggable persistent storage adapter interface.
 */
export interface StorageAdapter {
  /**
   * Retrieves all points currently in the queue in chronological order.
   */
  getQueue(): Promise<GPSPoint[]>;

  /**
   * Appends one or multiple points to the end of the queue.
   * @param points Single point or array of points.
   */
  append(points: GPSPoint | GPSPoint[]): Promise<void>;

  /**
   * Removes points from the beginning of the queue.
   * @param count Number of points to remove from the head. If omitted or >= queue size, clears the queue.
   */
  clear(count?: number): Promise<void>;

  /**
   * Returns the number of points currently in the queue.
   */
  size(): Promise<number>;
}

/**
 * Configuration options for the RoadTracker instance.
 */
export interface TrackerConfig {
  /** Map matching provider instance (e.g., OSRMProvider, MapboxProvider, CustomBackendProvider) */
  provider: MatchingProvider;
  /** Storage adapter instance (defaults to MemoryStorage) */
  storage?: StorageAdapter;
  /** Custom filter threshold overrides */
  filterOptions?: Partial<FilterOptions>;
  /** Number of accepted points that trigger an automatic sync flush (default: 10) */
  batchSize?: number;
  /** Maximum interval in milliseconds between automatic sync flushes (default: 60000 = 1 min) */
  flushIntervalMs?: number;
  /** Maximum retry attempts for failed network flushes before applying fallback (default: 3) */
  maxRetries?: number;
  /** Initial exponential backoff delay in milliseconds (default: 1000) */
  retryBackoffMs?: number;
  /** Fall back to raw coordinates when provider fails or returns NoMatch (default: true) */
  fallbackOnFailure?: boolean;
  /** Enable automatic timer and batchSize-driven flushing (default: true) */
  autoFlush?: boolean;
}

/**
 * Type-safe map of event listener signatures emitted by RoadTracker.
 */
export interface TrackerEventMap {
  /** Fired when a batch of points has been snapped to roads (or fallback generated) */
  routeMatched: (result: MatchedRouteResult) => void;
  /** Fired when an incoming GPS point passes the spatial filter and enters the queue */
  pointAccepted: (point: GPSPoint, result: FilterResult) => void;
  /** Fired when an incoming GPS point is discarded by the spatial filter */
  pointDropped: (point: GPSPoint, result: FilterResult) => void;
  /** Fired when a queue flush cycle starts */
  flushStarted: (points: GPSPoint[]) => void;
  /** Fired when a queue flush cycle finishes */
  flushCompleted: (result: MatchedRouteResult | null) => void;
  /** Fired when an error occurs during tracking, storage, or map matching */
  error: (error: Error) => void;
}

/**
 * State machine status of RoadTracker.
 */
export type TrackerState = 'idle' | 'tracking' | 'flushing' | 'stopped';
