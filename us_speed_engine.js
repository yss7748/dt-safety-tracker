/**
 * US Speed Limit Engine (Multi-source GIS Resolver)
 * Sources:
 * 1. Coordinator Manual Zone Override
 * 2. Nominatim Reverse Geocoder (Extracts official road name: Highway/Freeway/Expressway/Avenue/Street)
 * 3. OpenStreetMap Overpass API (maxspeed tag & highway classification)
 * 4. Official US DOT (FHWA) GIS Feature API
 * 5. Static Default Zone
 */

const speedCache = new Map();

/**
 * 1. Query Nominatim Reverse Geocoder for exact road name classification
 */
async function fetchNominatimRoadLimit(lat, lng) {
  if (!lat || !lng) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=17`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DTSafetyTracker/2.0' }
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      const roadName = (data.address && (data.address.road || data.address.highway || data.name)) || '';
      const lower = roadName.toLowerCase();

      if (lower.includes('interstate') || lower.includes('i-') || lower.includes('freeway') || lower.includes('fwy') || lower.includes('turnpike')) {
        return 65;
      }
      if (lower.includes('highway') || lower.includes('hwy') || lower.includes('expressway') || lower.includes('loop') || lower.includes('state route') || lower.includes('sh-') || lower.includes('us-')) {
        return 55;
      }
      if (lower.includes('parkway') || lower.includes('pkwy') || lower.includes('boulevard') || lower.includes('blvd') || lower.includes('avenue') || lower.includes('ave')) {
        return 45;
      }
      if (lower.includes('street') || lower.includes('st') || lower.includes('road') || lower.includes('rd') || lower.includes('drive') || lower.includes('dr')) {
        return 35;
      }
      if (lower.includes('lane') || lower.includes('ln') || lower.includes('court') || lower.includes('ct') || lower.includes('way') || lower.includes('school')) {
        return 25;
      }
    }
  } catch (e) {
    // Timeout or network error
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
    const timeout = setTimeout(() => controller.abort(), 1800);

    const query = `[out:json];way(around:200,${lat},${lng})[highway];out tags;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.elements && data.elements.length > 0) {
        for (const el of data.elements) {
          if (el.tags && el.tags.maxspeed) {
            const raw = el.tags.maxspeed;
            const parsed = parseInt(raw.replace(/[^\d]/g, ''), 10);
            if (!isNaN(parsed) && parsed > 0) {
              return parsed;
            }
          }
        }
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
  } catch (err) {}
  return null;
}

/**
 * 3. Query Official US DOT GIS Endpoint
 */
async function fetchUSDOTSpeedLimit(lat, lng) {
  if (!lat || !lng) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

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
  } catch (e) {}
  return null;
}

/**
 * Synchronous local static fallback
 */
function getLocalUSRoadSpeedLimit(lat, lng, speed = 0, settings = null) {
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }
  return 35;
}

/**
 * Multi-source Async Speed Limit Resolver:
 * 1. Coordinator Manual Override (highest priority)
 * 2. Nominatim Reverse Geocoder Road Classification
 * 3. OpenStreetMap Overpass Tag Query
 * 4. Official US DOT GIS API
 * 5. Static Default Zone (35 MPH)
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

  // 2. Query Nominatim Road Name Classification
  const nomSpeed = await fetchNominatimRoadLimit(lat, lng);
  if (nomSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: nomSpeed, timestamp: Date.now() });
    return nomSpeed;
  }

  // 3. Query OpenStreetMap Tag Engine
  const osmSpeed = await fetchOSMData(lat, lng);
  if (osmSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: osmSpeed, timestamp: Date.now() });
    return osmSpeed;
  }

  // 4. Query Official US DOT API
  const dotSpeed = await fetchUSDOTSpeedLimit(lat, lng);
  if (dotSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: dotSpeed, timestamp: Date.now() });
    return dotSpeed;
  }

  // 5. Default Zone
  return 35;
}

module.exports = {
  getUSRoadSpeedLimit: getLocalUSRoadSpeedLimit,
  getUSRoadSpeedLimitAsync
};
