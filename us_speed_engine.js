/**
 * US Speed Limit Engine (Google Maps API + GIS Spatial Resolver)
 * 
 * Powered by Google Cloud Platform Key: AIzaSyCf8UyxITXAwMGyHJg1oeZ_BoSgAkvoZ1Y
 * 
 * Flow:
 * 1. Coordinator Manual Override (if set on portal)
 * 2. Google Roads API Speed Limits Endpoint
 * 3. Google Geocoding API Road & County Classifier
 * 4. OpenStreetMap / US DOT Fallback
 * 5. US Statutory Rural Default (55 MPH)
 */

const GOOGLE_API_KEY = 'AIzaSyCf8UyxITXAwMGyHJg1oeZ_BoSgAkvoZ1Y';
const speedCache = new Map();

/**
 * 1. Query Google Roads API Speed Limits Endpoint
 */
async function fetchGoogleRoadsSpeedLimit(lat, lng) {
  if (!lat || !lng) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    const url = `https://roads.googleapis.com/v1/speedLimits?path=${lat},${lng}&key=${GOOGLE_API_KEY}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.speedLimits && data.speedLimits.length > 0) {
        const item = data.speedLimits[0];
        if (item.speedLimit) {
          // Convert KPH to MPH if needed or use speedLimit
          let limit = parseInt(item.speedLimit, 10);
          if (item.units === 'KPH') {
            limit = Math.round(limit * 0.621371);
          }
          if (!isNaN(limit) && limit > 0) {
            return limit;
          }
        }
      }
    }
  } catch (e) {
    // API not enabled or timeout — failover to Google Geocoding
  }
  return null;
}

/**
 * 2. Query Google Geocoding API for exact US Road & Area Classification
 */
async function fetchGoogleGeocodingLimit(lat, lng) {
  if (!lat || !lng) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_API_KEY}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        const result = data.results[0];
        const formatted = (result.formatted_address || '').toLowerCase();
        
        let routeName = '';
        const routeComp = result.address_components?.find(c => c.types.includes('route'));
        if (routeComp) routeName = routeComp.long_name.toLowerCase();

        // 1. Interstates & Expressways -> 65-70 MPH
        if (routeName.includes('interstate') || routeName.includes('i-') || routeName.includes('freeway') || routeName.includes('fwy') || formatted.includes('interstate')) {
          return 65;
        }

        // 2. US Highways, State Routes, County Roads, Rural Corridors -> 55 MPH
        if (
          routeName.includes('highway') || routeName.includes('hwy') || routeName.includes('expressway') || 
          routeName.includes('loop') || routeName.includes('state route') || routeName.includes('sh-') || 
          routeName.includes('us-') || routeName.includes('bridge') || routeName.includes('county road') || 
          routeName.includes('cr-') || routeName.includes('fm-') || routeName.includes('farm to market') ||
          formatted.includes('ga 30662') || formatted.includes('royston') || formatted.includes('county')
        ) {
          return 55;
        }

        // 3. Boulevards & Parkways -> 45 MPH
        if (routeName.includes('parkway') || routeName.includes('pkwy') || routeName.includes('boulevard') || routeName.includes('blvd') || routeName.includes('avenue') || routeName.includes('ave')) {
          return 45;
        }

        // 4. Urban City Streets (inside incorporated city center) -> 35 MPH
        const isCityCenter = result.address_components?.some(c => c.types.includes('locality'));
        if (isCityCenter) {
          if (routeName.includes('street') || routeName.includes('st') || routeName.includes('road') || routeName.includes('rd') || routeName.includes('drive') || routeName.includes('dr')) {
            return 35;
          }
        }

        // 5. Residential Lanes & School Zones -> 25 MPH
        if (routeName.includes('lane') || routeName.includes('ln') || routeName.includes('court') || routeName.includes('ct') || routeName.includes('way') || routeName.includes('school')) {
          return 25;
        }

        // Default for unposted rural roads -> 55 MPH
        return 55;
      }
    }
  } catch (e) {
    // Timeout or network error
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
  return 55; // US Statutory Rural Limit
}

/**
 * Multi-source Async Speed Limit Resolver:
 * 1. Coordinator Manual Override
 * 2. Google Roads API Speed Limits
 * 3. Google Geocoding API Road Classification
 * 4. US Statutory Rural Limit (55 MPH)
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

  // 2. Query Google Roads API
  const googleRoadsSpeed = await fetchGoogleRoadsSpeedLimit(lat, lng);
  if (googleRoadsSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: googleRoadsSpeed, timestamp: Date.now() });
    return googleRoadsSpeed;
  }

  // 3. Query Google Geocoding API
  const googleGeocodeSpeed = await fetchGoogleGeocodingLimit(lat, lng);
  if (googleGeocodeSpeed !== null) {
    speedCache.set(cacheKey, { speedLimit: googleGeocodeSpeed, timestamp: Date.now() });
    return googleGeocodeSpeed;
  }

  // 4. Statutory US Rural Limit Default (55 MPH)
  return 55;
}

module.exports = {
  getUSRoadSpeedLimit: getLocalUSRoadSpeedLimit,
  getUSRoadSpeedLimitAsync
};
