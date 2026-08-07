/**
 * US Speed Limit Spatial Engine
 * Priority 1: Coordinator Manual Override
 * Priority 2: Real OpenStreetMap (OSM) Overpass API Query (maxspeed & highway type)
 * Priority 3: Fixed Default Zone (35 MPH)
 * 
 * CRITICAL RULE: Speed limit must NEVER depend on current vehicle speed!
 */

const osmCache = new Map();

/**
 * Queries OpenStreetMap Overpass API for real posted speed limit or road classification.
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<number|null>} Speed limit in MPH or null
 */
async function fetchOSMData(lat, lng) {
  if (!lat || !lng) return null;

  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = osmCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 30000)) {
    return cached.speedLimit;
  }

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
        // 1. Explicit maxspeed tag (e.g. "55 mph" -> 55)
        for (const el of data.elements) {
          if (el.tags && el.tags.maxspeed) {
            const raw = el.tags.maxspeed;
            const parsed = parseInt(raw.replace(/[^\d]/g, ''), 10);
            if (!isNaN(parsed) && parsed > 0) {
              osmCache.set(cacheKey, { speedLimit: parsed, timestamp: Date.now() });
              return parsed;
            }
          }
        }

        // 2. OSM Highway type classification
        for (const el of data.elements) {
          if (el.tags && el.tags.highway) {
            const htype = el.tags.highway;
            let resolvedLimit = null;
            if (htype === 'motorway' || htype === 'motorway_link') resolvedLimit = 65;
            else if (htype === 'trunk' || htype === 'trunk_link') resolvedLimit = 55;
            else if (htype === 'primary' || htype === 'primary_link') resolvedLimit = 45;
            else if (htype === 'secondary' || htype === 'secondary_link') resolvedLimit = 35;
            else if (htype === 'tertiary' || htype === 'residential' || htype === 'living_street') resolvedLimit = 25;

            if (resolvedLimit) {
              osmCache.set(cacheKey, { speedLimit: resolvedLimit, timestamp: Date.now() });
              return resolvedLimit;
            }
          }
        }
      }
    }
  } catch (err) {
    // Network / timeout error — fail to fallback
  }

  return null;
}

/**
 * Gets fixed fallback road limit (STRICTLY FIXED 35 MPH — NO SPEED GUESSTIMATE!)
 */
function getLocalUSRoadSpeedLimit(lat, lng, speed = 0, settings = null) {
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }
  return 35; // Fixed static default zone
}

/**
 * Async resolver:
 * 1. Coordinator Override (if set)
 * 2. Real OpenStreetMap API Road Lookup
 * 3. Fixed Default (35 MPH)
 */
async function getUSRoadSpeedLimitAsync(lat, lng, speed = 0, settings = null) {
  // 1. Coordinator Manual Override
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }

  // 2. Real OpenStreetMap API Query
  const osmSpeed = await fetchOSMData(lat, lng);
  if (osmSpeed !== null) {
    return osmSpeed;
  }

  // 3. Fixed Static Default (35 MPH) — NEVER changes based on vehicle speed!
  return 35;
}

module.exports = {
  getUSRoadSpeedLimit: getLocalUSRoadSpeedLimit,
  getUSRoadSpeedLimitAsync
};
