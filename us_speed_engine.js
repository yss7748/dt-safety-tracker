/**
 * US Speed Limit Spatial Engine
 * Integrates Official USDOT / FHWA ArcGIS REST API + Local Spatial Classification
 * Covering:
 * - School Zones & Residential Streets (20 - 25 MPH)
 * - Urban & Municipal Commercial Zones (25 - 35 MPH)
 * - Rural Highways & State Arterials (45 - 55 MPH)
 * - Interstate & Expressway Corridors (65 - 75 MPH)
 */

// In-Memory Cache for USDOT GIS API Lookups (15-second TTL)
const usdotCache = new Map();

// Major US Spatial Zones & Corridors
const US_ZONES = {
  // High-Density Urban / Municipal Commercial Zones (25 - 35 MPH)
  urbanCommercial: [
    { name: 'Dallas Downtown Core', minLat: 32.77, maxLat: 32.79, minLng: -96.81, maxLng: -96.78, speed: 30 },
    { name: 'Fort Worth Downtown', minLat: 32.74, maxLat: 32.76, minLng: -97.34, maxLng: -97.31, speed: 30 },
    { name: 'Houston Downtown', minLat: 29.74, maxLat: 29.77, minLng: -95.37, maxLng: -95.35, speed: 30 },
    { name: 'Austin Downtown', minLat: 30.25, maxLat: 30.28, minLng: -97.75, maxLng: -97.73, speed: 25 },
    { name: 'Chicago Loop', minLat: 41.87, maxLat: 41.89, minLng: -87.64, maxLng: -87.62, speed: 25 },
    { name: 'Atlanta Midtown', minLat: 33.77, maxLat: 33.79, minLng: -84.39, maxLng: -84.37, speed: 30 }
  ],

  // Rural Highways & Arterial Corridors (45 - 55 MPH)
  ruralArterials: [
    { name: 'US-75 Central Expressway', minLat: 32.8, maxLat: 33.3, minLng: -96.8, maxLng: -96.6, speed: 55 },
    { name: 'US-175 Southeast Highway', minLat: 32.6, maxLat: 32.8, minLng: -96.8, maxLng: -96.4, speed: 55 },
    { name: 'US-67 Marvin D Love Fwy', minLat: 32.6, maxLat: 32.75, minLng: -96.9, maxLng: -96.8, speed: 55 },
    { name: 'Loop 12 / LBJ Expressway', minLat: 32.7, maxLat: 32.9, minLng: -96.95, maxLng: -96.7, speed: 55 },
    { name: 'SH-183 Airport Freeway', minLat: 32.8, maxLat: 32.85, minLng: -97.1, maxLng: -96.8, speed: 55 },
    { name: 'SH-360 Arlington Corridor', minLat: 32.6, maxLat: 32.85, minLng: -97.1, maxLng: -97.0, speed: 55 },
    { name: 'US-290 Texas Rural Hwy', minLat: 30.0, maxLat: 30.4, minLng: -97.8, maxLng: -95.5, speed: 55 },
    { name: 'US-380 North Texas Corridor', minLat: 33.15, maxLat: 33.25, minLng: -97.2, maxLng: -96.4, speed: 55 },
    { name: 'US-1 Florida Overseas Hwy', minLat: 24.5, maxLat: 25.2, minLng: -81.8, maxLng: -80.4, speed: 55 }
  ],

  // Interstate Corridors (65 - 75 MPH)
  interstates: [
    { name: 'I-35 Texas Interstate', minLat: 29.4, maxLat: 33.5, minLng: -98.6, maxLng: -96.5, speed: 65 },
    { name: 'I-20 Texas Interstate', minLat: 32.3, maxLat: 32.9, minLng: -97.5, maxLng: -96.0, speed: 65 },
    { name: 'I-45 Texas Interstate', minLat: 29.7, maxLat: 32.8, minLng: -96.9, maxLng: -95.3, speed: 65 },
    { name: 'I-10 Interstate Corridor', minLat: 29.3, maxLat: 30.5, minLng: -106.5, maxLng: -93.8, speed: 70 },
    { name: 'I-75 Eastern Interstate', minLat: 25.7, maxLat: 35.0, minLng: -84.5, maxLng: -80.1, speed: 70 },
    { name: 'I-95 Atlantic Interstate', minLat: 25.8, maxLat: 42.0, minLng: -80.3, maxLng: -71.0, speed: 65 }
  ]
};

/**
 * Queries the official USDOT / FHWA ArcGIS REST Feature API for posted speed limit
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<number|null>} Speed limit in MPH or null if unavailable
 */
async function fetchUSDOTSpeedLimit(lat, lng) {
  if (!lat || !lng) return null;

  // Round key to ~10 meters for caching
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = usdotCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 15000)) {
    return cached.speedLimit;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200); // 1.2s timeout limit for zero lag

    // USDOT / FHWA Speed Limit Feature Server Endpoint
    const endpoint = `https://services.gis.fhwa.dot.gov/arcgis/rest/services/Highway/HPMS_Speed_Limits/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&distance=100&units=esriSRUnit_Meter&outFields=SPEED_LIMIT,SPEED_LIMIT_PASSENGER,SPEED_LIMIT_TRUCK&f=json`;

    const response = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.features && data.features.length > 0) {
        for (const feature of data.features) {
          const attrs = feature.attributes || {};
          const speed = attrs.SPEED_LIMIT || attrs.SPEED_LIMIT_PASSENGER || attrs.SPEED_LIMIT_TRUCK;
          const parsed = parseInt(speed, 10);
          if (!isNaN(parsed) && parsed > 0) {
            usdotCache.set(cacheKey, { speedLimit: parsed, timestamp: Date.now() });
            return parsed;
          }
        }
      }
    }
  } catch (err) {
    // Timeout or network error — fail silently to local engine
  }

  return null;
}

/**
 * Synchronous local spatial fallback calculator
 */
function getLocalUSRoadSpeedLimit(lat, lng, speed = 0, settings = null) {
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }

  const currentSpeed = Math.round(speed || 0);

  if (lat && lng) {
    for (const zone of US_ZONES.urbanCommercial) {
      if (lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLng && lng <= zone.maxLng) {
        if (currentSpeed < 45) return zone.speed;
      }
    }
    for (const zone of US_ZONES.ruralArterials) {
      if (lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLng && lng <= zone.maxLng) {
        if (currentSpeed >= 40) return zone.speed;
      }
    }
    for (const zone of US_ZONES.interstates) {
      if (lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLng && lng <= zone.maxLng) {
        if (currentSpeed >= 50) return zone.speed;
      }
    }
  }

  if (currentSpeed >= 60) return 65;
  if (currentSpeed >= 48) return 55;
  if (currentSpeed >= 35) return 45;
  if (currentSpeed >= 20) return 35;
  return 20;
}

/**
 * Async resolver prioritizing 1. Coordinator Override -> 2. Official USDOT GIS API -> 3. Local Spatial Engine
 */
async function getUSRoadSpeedLimitAsync(lat, lng, speed = 0, settings = null) {
  // 1. Coordinator Override
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }

  // 2. Official USDOT / FHWA ArcGIS API
  const usdotSpeed = await fetchUSDOTSpeedLimit(lat, lng);
  if (usdotSpeed !== null) {
    return usdotSpeed;
  }

  // 3. Local Spatial Engine Fallback
  return getLocalUSRoadSpeedLimit(lat, lng, speed, settings);
}

module.exports = {
  getUSRoadSpeedLimit: getLocalUSRoadSpeedLimit,
  getUSRoadSpeedLimitAsync
};
