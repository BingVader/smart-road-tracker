# smart-road-tracker

> **Production-ready, zero-dependency (runtime) TypeScript SDK for sparse GPS noise filtering, offline queueing, and road-snapping via pluggable map-matching providers (OSRM, Mapbox, custom backends).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org/)
[![Runtime Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![Dual ESM / CJS](https://img.shields.io/badge/module-ESM%20%7C%20CJS-orange)](#)

---

## 🎯 The Problem

Mobile geolocation apps face an expensive trade-off:
1. **High-frequency GPS polling (1–5s):** Produces smooth curves following roads, but rapidly drains battery and burns through user data plans.
2. **Low-frequency / sparse polling (30–60s):** Saves battery, but produces ugly straight-line cuts through buildings, water bodies, and off-road terrain.
3. **Stationary jitter & teleportation spikes:** Weak satellite fixes create multi-meter drift while stationary at red lights or sudden 500m "jumps".

**`smart-road-tracker`** solves this by:
- Filtering noisy, stationary, and teleported coordinates using spatial thresholds (Haversine distance, bearing delta, accuracy, and kinematic speed limits).
- Persisting filtered fixes offline across app restarts using pluggable storage adapters (`MemoryStorage`, `LocalStorageAdapter`, or React Native `AsyncStorage`).
- Batching points and snapping them to actual road networks via pluggable map-matching providers (**OSRM**, **Mapbox**, or **custom backend endpoints**).
- Maintaining a cumulative stitched GeoJSON `LineString` for continuous trip rendering on Mapbox, Leaflet, Google Maps, or MapLibre.

---

## 🏗️ Architecture

```text
       Incoming Coordinates (Web Geolocation / React Native / Capacitor / Background Stream)
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │       Spatial Noise Filter      │
                         │   (accuracy, distance, bearing, │
                         │    kinematic speed, idle timer) │
                         └────────────────┬────────────────┘
                                          │
                    [Dropped]             │ [Accepted]
              (Stationary Jitter /        ▼
               Teleport Spikes)    ┌──────────────────────────────┐
                                   │   Pluggable Storage Queue    │
                                   │ (Memory / LocalStorage / RN) │
                                   └──────────────┬───────────────┘
                                                  │
                                                  │ Flush Condition:
                                                  │ • queue.length >= batchSize OR
                                                  │ • flushIntervalMs elapsed OR
                                                  │ • tracker.flush() / tracker.stop()
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │    Map-Matching Provider     │
                                   │  (OSRM / Mapbox / Custom)    │
                                   └──────────────┬───────────────┘
                                                  │
                                    ┌─────────────┴─────────────┐
                                    │ (Retry w/ Exponential     │
                                    │  Backoff on Network Fail) │
                                    ▼                           ▼
                        [Snapped Road Segments]         [Graceful Fallback]
                                    │                           │
                                    └─────────────┬─────────────┘
                                                  │
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │     Stitched GeoJSON Route   │
                                   │    (Cumulative LineString)   │
                                   └──────────────────────────────┘
```

---

## 📦 Installation

### From GitHub Packages:

Add to your project's `.npmrc`:
```ini
@bingvader:registry=https://npm.pkg.github.com
```

Install via your package manager:
```bash
npm install @bingvader/smart-road-tracker
# or
pnpm add @bingvader/smart-road-tracker
# or
yarn add @bingvader/smart-road-tracker
```

Dual ESM/CJS is supported out of the box with complete TypeScript type declarations (`.d.ts` and `.d.mts`).

---

## 🚀 Quick Start (Web Browser)

```typescript
import { RoadTracker, OSRMProvider, LocalStorageAdapter } from 'smart-road-tracker';

// 1. Initialize tracker with OSRM (public router demo or self-hosted)
const tracker = new RoadTracker({
  provider: new OSRMProvider({
    baseUrl: 'https://router.project-osrm.org', // Zero-config testing
    profile: 'driving',
  }),
  storage: new LocalStorageAdapter({ storageKey: 'trip_offline_queue' }),
  batchSize: 10,             // Auto-flush every 10 points
  flushIntervalMs: 60000,    // Or at least once per minute
  fallbackOnFailure: true,   // Gracefully fallback to raw coordinates if offline
});

// 2. Listen to route snap events
tracker.on('routeMatched', (result) => {
  console.log(`Matched ${result.geometry.coordinates.length} road coordinates!`);
  console.log(`Confidence: ${result.confidence}, Distance: ${result.distanceMeters}m`);

  // Update your map layer (e.g. Mapbox GL JS / Leaflet)
  const fullGeoJSON = tracker.getFullRoute();
  map.getSource('my-route').setData(fullGeoJSON);
});

tracker.on('pointAccepted', (pt) => console.log('Accepted fix:', pt));
tracker.on('pointDropped', (pt, res) => console.log('Dropped fix:', res.reason));

// 3. Start native browser tracking
tracker.startBrowserTracking({
  enableHighAccuracy: true,
  maximumAge: 5000,
});

// 4. When the user finishes the trip
// tracker.stop();
```

---

## 📱 React Native Example (`AsyncStorage` Adapter)

`smart-road-tracker` has **zero runtime dependencies** and runs anywhere JavaScript runs: Web, React Native, Node.js, Capacitor, and Electron.

To persist offline points across app restarts or background kills in React Native, simply implement the `StorageAdapter` interface:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RoadTracker, OSRMProvider, StorageAdapter, GPSPoint } from 'smart-road-tracker';

class ReactNativeStorageAdapter implements StorageAdapter {
  private key = 'MY_APP_GPS_QUEUE';

  async getQueue(): Promise<GPSPoint[]> {
    const raw = await AsyncStorage.getItem(this.key);
    return raw ? JSON.parse(raw) : [];
  }

  async append(points: GPSPoint | GPSPoint[]): Promise<void> {
    const queue = await this.getQueue();
    const toAdd = Array.isArray(points) ? points : [points];
    queue.push(...toAdd);
    await AsyncStorage.setItem(this.key, JSON.stringify(queue));
  }

  async clear(count?: number): Promise<void> {
    const queue = await this.getQueue();
    if (count === undefined || count >= queue.length) {
      await AsyncStorage.removeItem(this.key);
    } else {
      queue.splice(0, count);
      await AsyncStorage.setItem(this.key, JSON.stringify(queue));
    }
  }

  async size(): Promise<number> {
    const queue = await this.getQueue();
    return queue.length;
  }
}

// Instantiate tracker in React Native
export const tracker = new RoadTracker({
  provider: new OSRMProvider({
    baseUrl: 'https://router.project-osrm.org',
  }),
  storage: new ReactNativeStorageAdapter(),
  batchSize: 8,
});

// Feed location updates from react-native-geolocation-service or Expo Location:
// tracker.pushPoint({
//   latitude: location.coords.latitude,
//   longitude: location.coords.longitude,
//   timestamp: location.timestamp,
//   accuracy: location.coords.accuracy,
//   heading: location.coords.heading,
//   speed: location.coords.speed,
// });
```

---

## 🗺️ Pluggable Map-Matching Providers

### 1. OSRM Provider (`OSRMProvider`)
Snaps coordinates against the Open Source Routing Machine Match API v1:

```typescript
import { OSRMProvider } from 'smart-road-tracker';

const osrm = new OSRMProvider({
  baseUrl: 'https://router.project-osrm.org', // or your self-hosted OSRM URL
  profile: 'driving',                          // 'driving' | 'car' | 'bike' | 'foot'
  defaultRadiusMeters: 25,
  minRadiusMeters: 5,
  maxRadiusMeters: 50,
  includeTimestamps: true,
  fallbackOnNoMatch: true,
});
```

### 2. Mapbox Provider (`MapboxProvider`)
Snaps coordinates using Mapbox Map Matching API v5:

```typescript
import { MapboxProvider } from 'smart-road-tracker';

const mapbox = new MapboxProvider({
  accessToken: 'pk.your_mapbox_access_token',
  profile: 'driving', // 'driving' | 'driving-traffic' | 'walking' | 'cycling'
  fallbackOnNoMatch: true,
});
```

### 3. Custom Backend Provider (`CustomBackendProvider`)
For proprietary routing engines, GraphHopper, Valhalla, or custom microservices:

```typescript
import { CustomBackendProvider } from 'smart-road-tracker';

const customProvider = new CustomBackendProvider({
  endpointUrl: 'https://api.yourdomain.com/v1/map-match',
  method: 'POST',
  headers: {
    Authorization: 'Bearer secret-token',
  },
  // Optionally transform request payload:
  transformRequest: (points) => ({
    coordinates: points.map((p) => [p.longitude, p.latitude]),
    timestamps: points.map((p) => p.timestamp),
  }),
  // Automatically handles standard GeoJSON LineString responses:
  fallbackOnError: true,
});
```

---

## ⚙️ Spatial Noise Filtering Logic

Every incoming point submitted to `pushPoint` is evaluated against strict spatial thresholds:

1. **Accuracy Threshold:** If `point.accuracy > maxAccuracyMeters` (default: `50m`), the point is discarded (`ACCURACY_TOO_LOW`).
2. **Redundant & Stationary Jitter:** Discarded with `BELOW_SPATIAL_THRESHOLD` if:
   - `distance < minDistanceMeters` (default: `25m`), **AND**
   - `headingDelta < minHeadingDeltaDegrees` (default: `20°`), **AND**
   - `elapsedMs < maxIdleIntervalMs` (default: `120000ms` / 2 minutes).
   > *Note:* Sharp turns (`headingDelta >= 20°`) or long stops (`elapsed >= 2 min`) trigger immediate point capture even over very short distances!
3. **Teleportation Spikes:** If implied speed `distance / elapsedSeconds > maxSpeedMps` (default: `65 m/s` ~234 km/h), the point is discarded (`SPEED_EXCEEDS_MAX`).

```typescript
const tracker = new RoadTracker({
  provider: osrm,
  filterOptions: {
    maxAccuracyMeters: 40,
    minDistanceMeters: 20,
    minHeadingDeltaDegrees: 15,
    maxIdleIntervalMs: 90000,
    maxSpeedMps: 50,
  },
});
```

---

## 🐳 Self-Hosted OSRM Setup (Docker)

To run a high-throughput, private map-matching service on your own server:

```bash
# 1. Download OpenStreetMap extract (e.g. Berlin or California)
wget http://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf

# 2. Extract and pre-process graph
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/berlin-latest.osm.pbf
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/berlin-latest.osrm
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/berlin-latest.osrm

# 3. Launch OSRM routing server on port 5000
docker run -t -i -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/berlin-latest.osrm
```

Then configure the SDK:
```typescript
const tracker = new RoadTracker({
  provider: new OSRMProvider({
    baseUrl: 'http://localhost:5000',
  }),
});
```

---

## 📖 API Reference

### `RoadTracker`

| Method | Returns | Description |
|---|---|---|
| `pushPoint(point: GPSPoint)` | `Promise<FilterResult>` | Ingests a GPS point, filters noise, enqueues, and checks batch trigger |
| `startBrowserTracking(geoOptions?)` | `void` | Convenience wrapper around `navigator.geolocation.watchPosition` |
| `stopBrowserTracking()` | `void` | Clears active browser geolocation watcher |
| `flush()` | `Promise<MatchedRouteResult \| null>` | Manually flushes queued points to provider and updates cumulative route |
| `getFullRoute()` | `GeoJSONLineString` | Returns cumulative stitched road-snapped GeoJSON LineString |
| `getFullRouteFeature(properties?)` | `GeoJSONFeature<GeoJSONLineString>` | Returns cumulative road-matched route wrapped as a GeoJSON Feature |
| `getRawRoute()` | `GeoJSONLineString` | Returns raw accepted coordinates as GeoJSON LineString |
| `getTotalDistance()` | `number` | Returns total road-matched cumulative distance in meters |
| `getRawDistance()` | `number` | Returns total raw GPS distance in meters |
| `getTripSummary()` | `TripSummary` | Returns statistical metrics (distance, duration, point count, average speed) |
| `getFilter()` | `SpatialFilter` | Accesses active spatial noise filter for inspection or dynamic configuration |
| `getQueue()` | `Promise<GPSPoint[]>` | Returns points currently waiting in offline queue |
| `start()` | `void` | Starts tracker and enables periodic sync timer |
| `stop()` | `Promise<void>` | Stops timers, stops browser tracking, and flushes remaining queue |
| `reset()` | `Promise<void>` | Resets queue, filter state, and cumulative geometries |
| `destroy()` | `Promise<void>` | Stops tracker and removes all event listeners |

### Events

```typescript
tracker.on('routeMatched', (result: MatchedRouteResult) => {});
tracker.on('pointAccepted', (point: GPSPoint, result: FilterResult) => {});
tracker.on('pointDropped', (point: GPSPoint, result: FilterResult) => {});
tracker.on('flushStarted', (points: GPSPoint[]) => {});
tracker.on('flushCompleted', (result: MatchedRouteResult | null) => {});
tracker.on('error', (err: Error) => {});
```

### Utilities (`geoMath`)

Pure zero-dependency geodesy functions exported directly:
- `haversineDistance(lat1, lon1, lat2, lon2): number`
- `initialBearing(lat1, lon1, lat2, lon2): number`
- `bearingDelta(bearing1, bearing2): number`
- `decodePolyline(encoded, precision?): [lon, lat][]`
- `encodePolyline(coordinates, precision?): string`
- `stitchLineStrings(geometries: GeoJSONLineString[]): GeoJSONLineString`
- `pointsToLineString(points: GPSPoint[]): GeoJSONLineString`
- `calculateRouteDistance(coordinates: [lon, lat][]): number`
- `calculateRouteDuration(points: GPSPoint[]): number`
- `calculateAverageSpeed(points: GPSPoint[], distanceMeters?): number`
- `routeToFeature(lineString, properties?): GeoJSONFeature`
- `pointsToFeatureCollection(points: GPSPoint[]): GeoJSONFeatureCollection`

---

## 🧪 Testing & Build

```bash
# Run unit test suite
npm test

# Run TypeScript strict type-check
npm run lint

# Build dual ESM/CJS and .d.ts artifacts with tsup
npm run build
```

---

## 📄 License

MIT © [BingVader](https://github.com/BingVader)
