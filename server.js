const express = require('express');
const cors = require('cors');

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
app.get('/api/drivers', (req, res) => {
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
        drivers.push(val);
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
app.post('/api/telemetry', (req, res) => {
  const { imei, lat, lng, speed, heading, status, networkStatus, violations, lastBrakeTime } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) {
    return res.status(404).json({ error: 'Driver not registered' });
  }

  driver.lat = lat;
  driver.lng = lng;
  driver.speed = speed;
  driver.heading = heading;
  driver.status = status;
  driver.networkStatus = networkStatus || '4g';
  driver.lastTelemetryTime = Date.now();

  if (violations) {
    driver.violations = {
      ...driver.violations,
      ...violations
    };
  }

  if (lastBrakeTime) {
    driver.lastBrakeTime = lastBrakeTime;
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
    timestamp: new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago' }),
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
  const { imei, status } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver || !driver.extension) return res.status(404).json({ error: 'No pending extension found' });

  driver.extension.status = status;
  driver.extension.responseTime = Date.now();

  if (status === 'approved') {
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
  const { imei, speedLimit, lunchStartHour, lunchStartMinute, lunchDeadlineHour, lunchDeadlineMinute, periodicBreakMinutes } = req.body;
  if (!imei) return res.status(400).json({ error: 'Missing IMEI' });

  const driver = db.drivers[imei];
  if (!driver) return res.status(404).json({ error: 'Driver not registered' });

  driver.settings = {
    speedLimit: parseInt(speedLimit) || 70,
    lunchStartHour: parseInt(lunchStartHour) || 12,
    lunchStartMinute: parseInt(lunchStartMinute) || 0,
    lunchDeadlineHour: parseInt(lunchDeadlineHour) || 12,
    lunchDeadlineMinute: parseInt(lunchDeadlineMinute) || 30,
    periodicBreakMinutes: parseInt(periodicBreakMinutes) || 120
  };

  res.json({ success: true, driver });
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

  res.json({ success: true, driver });
});

// POST /api/clear-logs
app.post('/api/clear-logs', (req, res) => {
  db.violation_logs = [];
  res.json({ success: true, message: 'Logs cleared successfully.' });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
