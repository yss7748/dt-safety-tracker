const express = require('express');
const cors = require('cors');
const { getUSRoadSpeedLimit, getUSRoadSpeedLimitAsync } = require('./us_speed_engine');

const app = express();
const PORT = process.env.PORT || 5050;

app.use(cors({ origin: '*' }));
app.use(express.json());

// In-Memory Database
const db = {
  active_drivers_list: [],
  violation_logs: [],
  drivers: {} // imei -> driver JSON object
};

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({ status: 'running', driversCount: db.active_drivers_list.length });
});

// GET /api/drivers
app.get('/api/drivers', async (req, res) => {
  const drivers = [];
  const updatedList = [];
  let listUpdated = false;

  for (const imei of db.active_drivers_list) {
    const val = db.drivers[imei];
    if (val) {
      // Delete drivers offline for more than 5 minutes (or 1 hour if stationary)
      const maxOfflineTime = (val.speed > 0) ? 300000 : 3600000;
      if (Date.now() - val.lastTelemetryTime > maxOfflineTime) {
        delete db.drivers[imei];
        listUpdated = true;
      } else {
        const lastSeenSecondsAgo = Math.max(0, Math.floor((Date.now() - val.lastTelemetryTime) / 1000));

        if (val.extension && val.extension.status === 'approved' && val.extension.approvedTime) {
          const elapsed = (Date.now() - val.extension.approvedTime) / 1000;
          const totalDuration = (val.extension.approvedDuration || 15) * 60;
          val.extension.remainingSeconds = Math.max(0, Math.floor(totalDuration - elapsed));
          if (val.extension.remainingSeconds <= 0) {
            val.extension.status = 'expired';
          }
        }

        // Calculate US Road Speed Limit via USDOT API & Spatial Engine
        val.roadSpeedLimit = await getUSRoadSpeedLimitAsync(val.lat, val.lng, val.speed, val.settings);

        drivers.push({
          ...val,
          lastSeenSecondsAgo
        });
        updatedList.push(imei);
      }
    } else {
      listUpdated = true;
    }
  }

  if (listUpdated) {
    db.active_drivers_list = updatedList;
  }

  res.json(drivers);
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  res.json(db.violation_logs);
});

// POST /api/register
app.post('/api/register', (req, res) => {
  const { imei, name, region, kitNo } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = {
    imei,
    name,
    region,
    kitNo,
    lat: req.body.lat || 32.7767,
    lng: req.body.lng || -96.7970,
    speed: req.body.speed || 0,
    heading: req.body.heading || 0,
    lastBrakeTime: null,
    extension: null,
    status: 'active',
    violations: {
      hardBrakingCount: 0,
      overspeedingCount: 0,
      skippedLunch: false
    },
    settings: {
      speedLimit: 70,
      lunchStartHour: 12,
      lunchStartMinute: 0,
      lunchDeadlineHour: 12,
      lunchDeadlineMinute: 30,
      periodicBreakMinutes: 120
    },
    coordinatorAlert: null,
    lastTelemetryTime: Date.now()
  };

  db.drivers[imei] = driver;

  if (!db.active_drivers_list.includes(imei)) {
    db.active_drivers_list.push(imei);
  }

  res.json({ success: true, driver });
});

// POST /api/telemetry
app.post('/api/telemetry', async (req, res) => {
  const { imei, lat, lng, speed, heading, status, networkStatus, violations, lastBrakeTime, testDelayReason, breakInfo } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) {
    return res.status(404).json({ error: 'Driver not registered' });
  }

  driver.lat = lat;
  driver.lng = lng;
  driver.speed = speed;
  driver.heading = heading;
  if (testDelayReason !== undefined) {
    driver.testDelayReason = testDelayReason;
  }
  if (breakInfo !== undefined) {
    driver.breakInfo = breakInfo;
  }

  // Heavy-duty GPS Jitter Deadband Filter: If speed is 6 MPH or less, vehicle is stopped!
  if (speed >= 7) {
    driver.status = status === 'violation' ? 'violation' : 'active';
  } else {
    driver.speed = 0;
    // Suppress stationary status during active break
    if (breakInfo && (breakInfo.lunchRemaining > 0 || breakInfo.periodicRemaining > 0)) {
      driver.status = 'break';
    } else {
      driver.status = status === 'traffic_stop' ? 'traffic_stop' : 'break';
    }
  }

  driver.networkStatus = networkStatus || '4g';
  driver.lastTelemetryTime = Date.now();

  // Calculate Road Speed Limit using official USDOT GIS API & Spatial Engine
  driver.roadSpeedLimit = await getUSRoadSpeedLimitAsync(lat, lng, speed, driver.settings);

  if (violations) {
    driver.violations = {
      ...driver.violations,
      ...violations
    };
  }

  if (lastBrakeTime) {
    driver.lastBrakeTime = lastBrakeTime;
  }

  if (driver.extension && driver.extension.status === 'approved' && driver.extension.approvedTime) {
    const elapsed = (Date.now() - driver.extension.approvedTime) / 1000;
    const totalDuration = (driver.extension.approvedDuration || 15) * 60;
    driver.extension.remainingSeconds = Math.max(0, Math.floor(totalDuration - elapsed));
    if (driver.extension.remainingSeconds <= 0) {
      driver.extension.status = 'expired';
    }
  }

  res.json({ success: true, driver });
});

// POST /api/violation
app.post('/api/violation', (req, res) => {
  const { imei, type, details } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  const driverName = driver ? `${driver.name} (${driver.kitNo})` : `IMEI: ${imei}`;

  const newLog = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
    imei,
    driverName,
    type,
    details
  };

  db.violation_logs.unshift(newLog);
  if (db.violation_logs.length > 100) db.violation_logs.pop();

  if (driver) {
    if (type === 'HARD_BRAKE') driver.violations.hardBrakingCount++;
    if (type === 'OVERSPEEDING') driver.violations.overspeedingCount++;
    if (type === 'LUNCH_VIOLATION') driver.violations.skippedLunch = true;
  }

  res.json({ success: true, log: newLog });
});

// POST /api/extension/request
app.post('/api/extension/request', (req, res) => {
  const { imei, duration, reason } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) return res.status(404).json({ error: 'Driver not registered' });

  driver.extension = {
    duration,
    reason,
    status: 'pending',
    requestTime: Date.now()
  };

  res.json({ success: true, driver });
});

// POST /api/extension/respond
app.post('/api/extension/respond', (req, res) => {
  const { imei, status, approvedDuration } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) return res.status(404).json({ error: 'Driver not registered' });

  if (status === 'exempt') {
    driver.extension = {
      status: 'exempt',
      duration: 0,
      reason: 'Exempted from breaks by coordinator',
      responseTime: Date.now()
    };
    driver.status = 'active';
    driver.violations.skippedLunch = false;
    return res.json({ success: true, driver });
  }

  if (!driver.extension) return res.status(404).json({ error: 'No pending extension found' });

  driver.extension.status = status;
  driver.extension.responseTime = Date.now();

  if (status === 'approved') {
    driver.extension.approvedDuration = approvedDuration !== undefined ? approvedDuration : (driver.extension.duration || 15);
    driver.extension.approvedTime = Date.now();
    driver.status = 'active';
    driver.violations.skippedLunch = false;
  }

  res.json({ success: true, driver });
});

// POST /api/reset
app.post('/api/reset', (req, res) => {
  db.active_drivers_list = [];
  db.violation_logs = [];
  db.drivers = {};
  res.json({ success: true, message: 'All system data reset.' });
});

// POST /api/settings
app.post('/api/settings', (req, res) => {
  const { imei, speedLimit, lunchStartHour, lunchStartMinute, lunchDeadlineHour, lunchDeadlineMinute, periodicBreakMinutes, roadSpeedLimitOverride } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) return res.status(404).json({ error: 'Driver not registered' });

  driver.settings = {
    speedLimit: parseInt(speedLimit) || 70,
    lunchStartHour: parseInt(lunchStartHour) || 12,
    lunchStartMinute: parseInt(lunchStartMinute) || 0,
    lunchDeadlineHour: parseInt(lunchDeadlineHour) || 12,
    lunchDeadlineMinute: parseInt(lunchDeadlineMinute) || 30,
    periodicBreakMinutes: parseInt(periodicBreakMinutes) || 120,
    roadSpeedLimitOverride: roadSpeedLimitOverride ? parseInt(roadSpeedLimitOverride) : 0
  };

  if (roadSpeedLimitOverride) {
    driver.roadSpeedLimit = parseInt(roadSpeedLimitOverride);
  }

  res.json({ success: true, settings: driver.settings });
});

// POST /api/alert-driver
app.post('/api/alert-driver', (req, res) => {
  const { imei, alertType, alertMessage } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) return res.status(404).json({ error: 'Driver not registered' });

  driver.coordinatorAlert = {
    timestamp: Date.now(),
    type: alertType || 'beep',
    message: alertMessage || ''
  };

  res.json({ success: true, coordinatorAlert: driver.coordinatorAlert });
});

// POST /api/fleet-break (Trigger fleet-wide break command for all drivers)
app.post('/api/fleet-break', (req, res) => {
  const { breakDurationMinutes } = req.body;
  const duration = parseInt(breakDurationMinutes) || 30;

  Object.keys(db.drivers).forEach(imei => {
    const driver = db.drivers[imei];
    driver.coordinatorAlert = {
      timestamp: Date.now(),
      type: 'break',
      message: `Coordinator has initiated a mandatory ${duration}-minute fleet break. Please pull over safely.`
    };
    driver.extension = {
      status: 'approved',
      approvedDuration: duration,
      approvedTime: Date.now(),
      remainingSeconds: duration * 60
    };
  });

  res.json({ success: true, count: Object.keys(db.drivers).length, duration });
});

// POST /api/clear-logs
app.post('/api/clear-logs', (req, res) => {
  db.violation_logs = [];
  res.json({ success: true, message: 'Logs cleared successfully.' });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
