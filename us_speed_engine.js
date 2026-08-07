/**
 * US Speed Limit Engine (Multi-source GIS Resolver)
 * 
 * Statutory US Speed Limits:
 * - Rural Roads, County Roads, Unposted Highways (GA / TX / US): 55 MPH
 * - Interstate Freeways: 65 - 70 MPH
 * - Urban Commercial / City Centers: 30 - 35 MPH
 * - School / Residential Streets: 20 - 25 MPH
 */

const speedCache = new Map();

/**
 * 1. Query Nominatim Reverse Geocoder for exact road name & area classification
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
      const addr = data.address || {};
      const roadName = (addr.road || addr.highway || data.name || '').toLowerCase();
      const display = (data.display_name || '').toLowerCase();

      // 1. Interstates & Expressways -> 65 MPH
      if (roadName.includes('interstate') || roadName.includes('i-') || roadName.includes('freeway') || roadName.includes('fwy') || roadName.includes('turnpike')) {
        return 65;
      }

      // 2. State Routes, Highways, County Roads, Rural Corridors -> 55 MPH
      if (
        roadName.includes('highway') || roadName.includes('hwy') || roadName.includes('expressway') || 
        roadName.includes('loop') || roadName.includes('sh-') || roadName.includes('us-') || 
        roadName.includes('bridge') || roadName.includes('county road') || roadName.includes('cr-') || 
        roadName.includes('fm-') || roadName.includes('route') || roadName.includes('plantations') ||
        addr.county || addr.hamlet || addr.village
      ) {
        return 55; // Georgia & US Statutory Rural / County Road Limit
      }

      // 3. Urban Boulevards & Parkways -> 45 MPH
      if (roadName.includes('parkway') || roadName.includes('pkwy') || roadName.includes('boulevard') || roadName.includes('blvd') || roadName.includes('avenue') || roadName.includes('ave')) {
        return 45;
      }

      // 4. Urban City Streets -> 35 MPH
      if (addr.city || addr.town) {
        if (roadName.includes('street') || roadName.includes('st') || roadName.includes('road') || roadName.includes('rd') || roadName.includes('drive') || roadName.includes('dr')) {
          return 35;
        }
      }

      // 5. Residential Lanes & School Zones -> 25 MPH
      if (roadName.includes('lane') || roadName.includes('ln') || roadName.includes('court') || roadName.includes('ct') || roadName.includes('way') || roadName.includes('school')) {
        return 25;
      }

      // Default for rural / unposted area -> 55 MPH
      return 55;
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

    const query = `[out:json];way(around:300,${lat},${lng})[highway];out tags;`;
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
            if (htype === 'primary' || htype === 'primary_link' || htype === 'secondary' || htype === 'secondary_link' || htype === 'unclassified') return 55;
            if (htype === 'tertiary') return 45;
            if (htype === 'residential' || htype === 'living_street') return 25;
          }
        }
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Synchronous local static fallback (Defaults to 55 MPH rural statutory limit)
 */
function getLocalUSRoadSpeedLimit(lat, lng, speed = 0, settings = null) {
  if (settings && settings.roadSpeedLimitOverride && settings.roadSpeedLimitOverride > 0) {
    return settings.roadSpeedLimitOverride;
  }
  return 55; // US Statutory Rural Road Limit
}

/**
 * Multi-source Async Speed Limit Resolver:
 * 1. Coordinator / Tablet Manual Override (highest priority)
 * 2. Nominatim Reverse Geocoder Road Classification
 * 3. OpenStreetMap Overpass Tag Query
 * 4. Rural Statutory Default (55 MPH)
 */
async function getUSRoadSpeedLimitAsync(lat, lng, speed = 0, settings = null) {
  // 1. Coordinator / Tablet Manual Override
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

  // 4. US Statutory Rural Limit Default (55 MPH)
  return 55;
}

module.exports = {
  getUSRoadSpeedLimit: getLocalUSRoadSpeedLimit,
  getUSRoadSpeedLimitAsync
};
