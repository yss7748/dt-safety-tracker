/**
 * US Speed Limit Engine
 * Priority 1: Coordinator Manual Override
 * Priority 2: Official US DOT (Department of Transportation / FHWA) GIS API
 * Priority 3: Real OpenStreetMap (OSM) Overpass API
 * Priority 4: Fixed Static Default (35 MPH)
 * 
 * CRITICAL RULE: Speed limit must NEVER depend on current vehicle speed!
 */

const speedCache = new Map();

/**
 * 1. Query Official US DOT (Department of Transportation) ArcGIS REST API
 */
async function fetchUSDOTSpeedLimit(lat, lng) {
  if (!lat || !lng) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    // Official US DOT FHWA GIS Endpoint with WGS84 4326 Spatial Reference
    const url = `https://services.gis.fhwa.dot.gov/arcgis/rest/services/Highway/HPMS_Speed_Limits/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=100&units=esriSRUnit_Meter&outFields=SPEED_LIMIT,SPEED_LIMIT_PASSENGER,SPEED_LIMIT_TRUCK&f=json`;

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.features && data.features.length > 0) {
        for (const feat of data.features) {
          const attrs = feat.attributes || {};
          const speed = attrs.SPEED_LIMIT || attrs.SPEED_LIMIT_PASSENGER || attrs.SPEED_LIMIT_TRUCK;
          const parsed = parseInt(speed, 10);
          if (!isNaN(parsed) && parsed > 0) {
            return parsed;
          }
        }
      }
    }
  } catch (e) {
    // US DOT service timeout or network error — failover to OSM
  }
  return null;
}

/**
 * 2. Query OpenStreetMap (OSM) Overpass API
 */
async function fetchOSMData(lat, lng) {
  if (!lat || !lng) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const query = `[out:json];way(around:100,${lat},${lng})[highway];out tags;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.elements && data.elements.length > 0) {
        // Explicit maxspeed tag (e.g. "55 mph" -> 55)
        for (const el of data.elements) {
          if (el.tags && el.tags.maxspeed) {
            const raw = el.tags.maxspeed;
            const parsed = parseInt(raw.replace(/[^\d]/g, ''), 10);
            if (!isNaN(parsed) && parsed > 0) {
              return parsed;
            }
          }
        }

        // OSM Highway type classification
        for (const el of data.elements) {
          if (el.tags && el.tags.highway) {
            const htype = el.tags.highway;
            if (htype === 'motorway' || htype === 'motorway_link') return 65;
            if (htype === 'trunk' || htype === 'trunk_link') return 55;
            if (htype === 'primary' || htype === 'primary_link') return 45;
            if (htype === 'secondary' || htype === 'secondary_link') return 35;
            if (htype === 'tertiary' || htype === 'residential' || htype === 'living_street') return 25;
          }
        }
      }
    }
  } catch (err) {
    // OSM network error — failover to default
  }

  return null;
}

/**
 * Synchronous local static fallback
 */
function getLocalUSRoadSpeedLimit(lat, lng, speed = 0, settings = null) {
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }
  return 35; // Fixed static default zone
}

/**
 * Multi-source Async Resolver:
 * 1. Coordinator Manual Override
 * 2. Official US DOT (FHWA) GIS API Query
 * 3. OpenStreetMap (OSM) API Query
 * 4. Fixed Default (35 MPH)
 */
async function getUSRoadSpeedLimitAsync(lat, lng, speed = 0, settings = null) {
  // 1. Coordinator Manual Override
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }

  const cacheKey = `${lat ? lat.toFixed(4) : 0},${lng ? lng.toFixed(4) : 0}`;
  const cached = speedCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 30000)) {
    return cached.speedLimit;
  }

  // 2. Query Official US DOT API First!
  const dotSpeed = await fetchUSDOTSpeedLimit(lat, lng);
  if (dotSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: dotSpeed, timestamp: Date.now() });
    return dotSpeed;
  }

  // 3. Query OpenStreetMap API Fallback
  const osmSpeed = await fetchOSMData(lat, lng);
  if (osmSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: osmSpeed, timestamp: Date.now() });
    return osmSpeed;
  }

  // 4. Fixed Static Default (35 MPH) — NEVER changes based on vehicle speed!
  return 35;
}

module.exports = {
  getUSRoadSpeedLimit: getLocalUSRoadSpeedLimit,
  getUSRoadSpeedLimitAsync
};
