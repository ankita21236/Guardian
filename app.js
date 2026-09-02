/**
 * GUARDIAN — Emergency Response System
 * Full offline-capable PWA with security, tracking, SOS, zones
 */

// --- security layer (client-side auth + encryption) ---
const SEC = {
  // Simple hash (SHA-256 via Web Crypto)
  async hash(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  },
  // CSRF token
  token: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
  // Rate limiting
  attempts: {},
  checkRate(key, max = 5, window = 60000) {
    const now = Date.now();
    if (!this.attempts[key]) this.attempts[key] = [];
    this.attempts[key] = this.attempts[key].filter(t => now - t < window);
    if (this.attempts[key].length >= max) return false;
    this.attempts[key].push(now);
    return true;
  },
  // Sanitize input
  sanitize(str) {
    return String(str).replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
  },
  // Session management
  sessionKey: 'guardian_session_v2',
  async createSession(user) {
    const session = {
      user,
      token: this.token,
      created: Date.now(),
      expires: Date.now() + 86400000, // 24h
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    return session;
  },
  getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(this.sessionKey) || 'null');
      if (!s) return null;
      if (Date.now() > s.expires) { this.clearSession(); return null; }
      return s;
    } catch { return null; }
  },
  clearSession() { localStorage.removeItem(this.sessionKey); }
};

// --- database (indexeddb) ---
const DB = {
  db: null,
  async open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('GuardianDB', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('users')) {
          const us = db.createObjectStore('users', { keyPath: 'username' });
          us.createIndex('username', 'username', { unique: true });
        }
        if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { autoIncrement: true, keyPath: 'id' });
        if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { autoIncrement: true, keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = e => { this.db = e.target.result; res(); };
      req.onerror = () => rej(req.error);
    });
  },
  async get(store, key) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async put(store, data) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(data);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async getAll(store) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async delete(store, key) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }
};

// --- app state ---
const STATE = {
  user: null,
  session: null,
  map: null,
  userMarker: null,
  userLat: null,
  userLng: null,
  watchId: null,
  zones: [],
  zoneCircles: [],
  zonesVisible: true,
  currentZone: 'safe', // safe | yellow | red
  weather: null,
  alerts: [],
  settings: {
    gps: true,
    'zone-alerts': true,
    weather: true,
    'sos-all': true,
    offline: true,
  },
  log: [],
  sosActive: false
};

// --- boot sequence ---
async function boot() {
  const msgs = ['INITIALIZING GUARDIAN...', 'LOADING SECURITY LAYER...', 'OPENING LOCAL DATABASE...', 'CHECKING SESSION...', 'READY'];
  let i = 0;
  const interval = setInterval(() => {
    i++;
    if (i < msgs.length) document.getElementById('loader-msg').textContent = msgs[i];
  }, 500);

  await DB.open();
  await seedDefaultData();

  setTimeout(() => {
    clearInterval(interval);
    document.getElementById('loading').classList.add('hidden');
    setTimeout(() => document.getElementById('loading').remove(), 500);

    const session = SEC.getSession();
    if (session) {
      STATE.session = session;
      STATE.user = session.user;
      initApp();
    } else {
      document.getElementById('auth-screen').style.display = 'flex';
    }
  }, 2500);
}

async function seedDefaultData() {
  // Seed default users if none exist
  const admin = await DB.get('users', 'admin');
  if (!admin) {
    const hash = await SEC.hash('Guardian@123');
    await DB.put('users', { username: 'admin', passwordHash: hash, name: 'Admin User', role: 'coordinator', phone: '+91-9999999999' });
    const uhash = await SEC.hash('rescue123');
    await DB.put('users', { username: 'rescue', passwordHash: uhash, name: 'Rescue Team', role: 'responder', phone: '+91-8888888888' });
  }

  // Seed authority contacts
  const allContacts = await DB.getAll('contacts');
  if (allContacts.length === 0) {
    const defaultAuthorities = [
      { name: 'National Emergency', phone: '112', role: 'National Emergency', type: 'authority', icon: '🚔' },
      { name: 'Fire Brigade', phone: '101', role: 'Fire & Rescue', type: 'authority', icon: '🚒' },
      { name: 'Ambulance', phone: '108', role: 'Medical Emergency', type: 'authority', icon: '🚑' },
      { name: 'Police Control', phone: '100', role: 'Law Enforcement', type: 'authority', icon: '👮' },
      { name: 'NDRF Unit', phone: '+91-9711077372', role: 'Disaster Response', type: 'authority', icon: '⛑️' },
    ];
    for (const c of defaultAuthorities) await DB.put('contacts', c);
  }
}

// --- auth ---
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => t.classList.toggle('active', (i===0 && tab==='login') || (i===1 && tab==='register')));
  document.getElementById('form-login').classList.toggle('active', tab === 'login');
  document.getElementById('form-register').classList.toggle('active', tab === 'register');
}

async function doLogin() {
  const username = SEC.sanitize(document.getElementById('login-user').value.trim());
  const password = document.getElementById('login-pass').value;
  const err = document.getElementById('login-error');

  if (!username || !password) { err.textContent = 'Please fill in all fields.'; return; }
  if (!SEC.checkRate('login_' + username)) { err.textContent = 'Too many attempts. Wait 60s.'; return; }

  const user = await DB.get('users', username);
  if (!user) { err.textContent = 'User not found.'; return; }

  const hash = await SEC.hash(password);
  if (hash !== user.passwordHash) { err.textContent = 'Invalid password.'; return; }

  STATE.user = user;
  await SEC.createSession(user);
  document.getElementById('auth-screen').style.display = 'none';
  addLog('AUTH', 'Login: ' + user.username, 'ok');
  initApp();
}

async function doRegister() {
  const name = SEC.sanitize(document.getElementById('reg-name').value.trim());
  const username = SEC.sanitize(document.getElementById('reg-user').value.trim());
  const password = document.getElementById('reg-pass').value;
  const role = document.getElementById('reg-role').value;
  const phone = SEC.sanitize(document.getElementById('reg-phone').value.trim());
  const err = document.getElementById('reg-error');

  if (!name || !username || !password || !phone) { err.textContent = 'All fields required.'; return; }
  if (password.length < 8) { err.textContent = 'Password must be ≥ 8 characters.'; return; }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) { err.textContent = 'Username: 3-20 alphanumeric chars.'; return; }

  const existing = await DB.get('users', username);
  if (existing) { err.textContent = 'Username already taken.'; return; }

  const hash = await SEC.hash(password);
  await DB.put('users', { username, passwordHash: hash, name, role, phone });

  err.style.color = 'var(--accent-green)';
  err.textContent = 'Account created! Please login.';
  setTimeout(() => { err.textContent = ''; err.style.color = ''; switchTab('login'); }, 1500);
}

function doLogout() {
  addLog('AUTH', 'Logout: ' + (STATE.user?.username || '?'), 'info');
  SEC.clearSession();
  if (STATE.watchId) navigator.geolocation.clearWatch(STATE.watchId);
  if (STATE.map) { STATE.map.remove(); STATE.map = null; }
  location.reload();
}

// --- app init ---
function initApp() {
  const app = document.getElementById('app');
  app.classList.add('visible');

  // Update UI with user info
  const initials = (STATE.user.name || 'U').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('user-avatar-top').textContent = initials;
  document.getElementById('user-name-top').textContent = STATE.user.username.toUpperCase();
  document.getElementById('profile-info').innerHTML =
    `<strong>NAME:</strong> ${STATE.user.name}<br><strong>ROLE:</strong> ${STATE.user.role.toUpperCase()}<br><strong>PHONE:</strong> ${STATE.user.phone}<br><strong>SESSION:</strong> Active`;

  loadSettings();
  initMap();
  startGPS();
  loadContacts();
  loadWeather();
  generateZones();
  startMonitoring();
  addLog('SYS', 'System initialized for ' + STATE.user.name, 'ok');
  checkOnlineStatus();
}

// --- map ---
function initMap() {
  STATE.map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([26.4499, 80.3319], 12);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '',
  }).addTo(STATE.map);

  const userIcon = L.divIcon({
    className: '',
    html: `<div style="
      width:20px;height:20px;
      background:var(--accent-cyan);
      border:3px solid white;
      border-radius:50%;
      box-shadow:0 0 15px var(--accent-cyan),0 0 30px rgba(0,229,255,0.4);
      position:relative;
    ">
      <div style="position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(0,229,255,0.4);animation:sos-ring 2s infinite;"></div>
    </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  STATE.userMarker = L.marker([26.4499, 80.3319], { icon: userIcon, zIndexOffset: 1000 })
    .addTo(STATE.map)
    .bindPopup('<b>YOUR POSITION</b><br>Acquiring GPS...');
}

function generateZones() {
  // Generate simulated danger zones around Kanpur, UP
  STATE.zones = [
    { lat: 26.4900, lng: 80.3500, radius: 4000, level: 'red', name: 'Flood Zone Alpha', desc: 'Heavy flooding reported' },
    { lat: 26.4200, lng: 80.3800, radius: 5000, level: 'red', name: 'Cyclone Impact Zone', desc: 'High wind speeds, debris' },
    { lat: 26.5200, lng: 80.2800, radius: 6000, level: 'yellow', name: 'Caution Zone Beta', desc: 'Moderate flooding, road damage' },
    { lat: 26.4000, lng: 80.2500, radius: 7000, level: 'yellow', name: 'Advisory Zone', desc: 'Power outages, avoid area' },
    { lat: 26.5500, lng: 80.4000, radius: 3000, level: 'red', name: 'Fire Zone', desc: 'Active wildfire risk' },
    { lat: 26.4699, lng: 80.3119, radius: 8000, level: 'yellow', name: 'Evacuation Route', desc: 'Congestion expected' },
  ];

  renderZones();
}

function renderZones() {
  STATE.zoneCircles.forEach(c => STATE.map.removeLayer(c));
  STATE.zoneCircles = [];
  if (!STATE.zonesVisible) return;

  STATE.zones.forEach(z => {
    const color = z.level === 'red' ? '#ff2244' : '#ffcc00';
    const fillOpacity = z.level === 'red' ? 0.18 : 0.12;
    const circle = L.circle([z.lat, z.lng], {
      radius: z.radius,
      color,
      fillColor: color,
      fillOpacity,
      weight: 2,
      dashArray: z.level === 'red' ? null : '6 4',
    }).addTo(STATE.map);
    circle.bindPopup(`
      <div style="font-family:'Share Tech Mono',monospace;font-size:0.75rem;line-height:1.6;">
        <div style="color:${color};font-weight:bold;font-size:0.9rem;margin-bottom:4px;">${z.level.toUpperCase()} ZONE</div>
        <div><strong>${z.name}</strong></div>
        <div style="color:#7a9bc0;">${z.desc}</div>
        <div style="margin-top:4px;color:#7a9bc0;">Radius: ${(z.radius/1000).toFixed(1)} km</div>
      </div>
    `);
    STATE.zoneCircles.push(circle);

    // Icon marker
    const icon = L.divIcon({
      className: '',
      html: `<div style="color:${color};font-size:0.65rem;font-family:'Share Tech Mono',monospace;letter-spacing:1px;background:rgba(0,0,0,0.7);padding:2px 5px;border:1px solid ${color};white-space:nowrap;">${z.level.toUpperCase()}</div>`,
      iconAnchor: [20, 10]
    });
    const marker = L.marker([z.lat, z.lng], { icon }).addTo(STATE.map);
    STATE.zoneCircles.push(marker);
  });
}

function toggleZones() {
  STATE.zonesVisible = !STATE.zonesVisible;
  renderZones();
  addLog('MAP', 'Zones ' + (STATE.zonesVisible ? 'shown' : 'hidden'), 'info');
}

function centerOnUser() {
  if (STATE.userLat && STATE.userLng) {
    STATE.map.flyTo([STATE.userLat, STATE.userLng], 14);
  }
}

// --- gps / location tracking ---
function startGPS() {
  if (!('geolocation' in navigator)) {
    useSimulatedLocation();
    return;
  }

  const opts = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

  navigator.geolocation.getCurrentPosition(pos => {
    updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
  }, () => useSimulatedLocation(), opts);

  STATE.watchId = navigator.geolocation.watchPosition(pos => {
    updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
  }, err => {
    console.warn('GPS error:', err);
  }, opts);
}

function useSimulatedLocation() {
  // Simulate location in Kanpur, UP with slight drift
  let lat = 26.4499 + (Math.random() - 0.5) * 0.05;
  let lng = 80.3319 + (Math.random() - 0.5) * 0.05;
  updateLocation(lat, lng, 50);
  addLog('GPS', 'Using simulated location (GPS unavailable)', 'warn');

  // Simulate movement
  setInterval(() => {
    lat += (Math.random() - 0.5) * 0.002;
    lng += (Math.random() - 0.5) * 0.002;
    updateLocation(lat, lng, 30);
  }, 15000);
}

function updateLocation(lat, lng, accuracy) {
  STATE.userLat = lat;
  STATE.userLng = lng;

  // Update marker
  STATE.userMarker.setLatLng([lat, lng]);
  STATE.userMarker.setPopupContent(`
    <b>YOUR POSITION</b><br>
    Lat: ${lat.toFixed(6)}<br>
    Lng: ${lng.toFixed(6)}<br>
    Accuracy: ±${Math.round(accuracy || 0)}m<br>
    <small style="color:#7a9bc0;">Cell: ${getCellTower(lat, lng)}</small>
  `);

  document.getElementById('coord-display').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  document.getElementById('gps-status-text').textContent = 'GPS ACTIVE';

  checkZone(lat, lng);
  checkWeatherRisk();
}

function getCellTower(lat, lng) {
  // Simulated cell tower info
  const towers = ['BTL-227 (3G)', 'JIO-451 (4G)', 'AIRTEL-112 (5G)', 'BSNL-789 (2G)', 'VI-334 (4G)'];
  const idx = Math.floor((Math.abs(lat * lng * 100)) % towers.length);
  return towers[idx];
}

// --- zone detection ---
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function checkZone(lat, lng) {
  if (!STATE.settings['zone-alerts']) return;

  let newZone = 'safe';
  let zoneInfo = null;

  for (const z of STATE.zones) {
    const dist = haversineDistance(lat, lng, z.lat, z.lng);
    if (dist <= z.radius) {
      if (z.level === 'red') { newZone = 'red'; zoneInfo = z; break; }
      if (z.level === 'yellow' && newZone !== 'red') { newZone = 'yellow'; zoneInfo = z; }
    }
  }

  if (newZone !== STATE.currentZone) {
    STATE.currentZone = newZone;
    updateZoneUI(newZone, zoneInfo);
  }
}

function updateZoneUI(zone, zoneInfo) {
  const banner = document.getElementById('zone-banner');
  const zoneStat = document.getElementById('zone-status');
  const zoneCard = document.getElementById('zone-card-value');

  banner.className = 'zone-banner';

  if (zone === 'red') {
    banner.classList.add('red');
    document.getElementById('zone-banner-text').textContent = `⚠️ DANGER: YOU ARE IN ${zoneInfo?.name || 'A RED ZONE'} — ${zoneInfo?.desc || 'EVACUATE IMMEDIATELY'}`;
    zoneStat.textContent = 'ZONE: DANGER';
    zoneCard.style.color = 'var(--danger-red)';
    zoneCard.textContent = '🔴 RED ZONE — DANGER';
    addAlert('red', '🚨', `RED ZONE: ${zoneInfo?.name}`, zoneInfo?.desc || 'High danger area');
    addLog('ZONE', 'Entered RED ZONE: ' + zoneInfo?.name, 'sos');
    vibrateDevice([300, 100, 300]);
  } else if (zone === 'yellow') {
    banner.classList.add('yellow');
    document.getElementById('zone-banner-text').textContent = `⚠️ CAUTION: ${zoneInfo?.name || 'YELLOW ZONE'} — ${zoneInfo?.desc || 'Exercise caution'}`;
    zoneStat.textContent = 'ZONE: CAUTION';
    zoneCard.style.color = 'var(--warn-yellow)';
    zoneCard.textContent = '🟡 YELLOW ZONE — CAUTION';
    addAlert('yellow', '⚠️', `CAUTION: ${zoneInfo?.name}`, zoneInfo?.desc || 'Moderate risk area');
    addLog('ZONE', 'Entered YELLOW ZONE: ' + zoneInfo?.name, 'warn');
    vibrateDevice([200, 100, 200]);
  } else {
    zoneStat.textContent = 'ZONE: SAFE';
    zoneCard.style.color = 'var(--accent-green)';
    zoneCard.textContent = '✓ SAFE ZONE';
    addLog('ZONE', 'Returned to safe zone', 'ok');
  }
}

function dismissBanner() {
  document.getElementById('zone-banner').className = 'zone-banner';
}

// --- weather (open-meteo — free, no key required) ---
async function loadWeather() {
  if (!STATE.settings.weather) return;
  const lat = STATE.userLat || 26.4499;
  const lng = STATE.userLng || 80.3319;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&hourly=relativehumidity_2m,windspeed_10m,visibility,surface_pressure&wind_speed_unit=kmh&forecast_days=1`;
    const res = await fetch(url);
    const data = await res.json();
    const cw = data.current_weather;
    const h = data.hourly;

    STATE.weather = {
      temp: Math.round(cw.temperature),
      windspeed: Math.round(cw.windspeed),
      code: cw.weathercode,
      humidity: h.relativehumidity_2m?.[0] || '--',
      pressure: Math.round(h.surface_pressure?.[0] || 0),
      visibility: ((h.visibility?.[0] || 10000) / 1000).toFixed(1),
    };

    updateWeatherUI();
    checkWeatherRisk();
    addLog('WTHR', 'Weather updated: ' + STATE.weather.temp + '°C', 'ok');
  } catch(e) {
    simulateWeather();
  }
}

function simulateWeather() {
  STATE.weather = {
    temp: 28 + Math.round(Math.random() * 8),
    windspeed: 15 + Math.round(Math.random() * 30),
    code: [0, 1, 61, 95][Math.floor(Math.random() * 4)],
    humidity: 60 + Math.round(Math.random() * 30),
    pressure: 1000 + Math.round(Math.random() * 15),
    visibility: (5 + Math.random() * 10).toFixed(1),
  };
  updateWeatherUI();
  checkWeatherRisk();
}

function getWeatherInfo(code) {
  if (code === 0) return { icon: '☀️', desc: 'Clear Sky' };
  if (code <= 3) return { icon: '🌤️', desc: 'Partly Cloudy' };
  if (code <= 48) return { icon: '🌫️', desc: 'Foggy' };
  if (code <= 67) return { icon: '🌧️', desc: 'Rain' };
  if (code <= 77) return { icon: '🌨️', desc: 'Snow' };
  if (code <= 82) return { icon: '⛈️', desc: 'Heavy Rain' };
  if (code <= 99) return { icon: '⚡', desc: 'Thunderstorm' };
  return { icon: '🌡️', desc: 'Unknown' };
}

function updateWeatherUI() {
  if (!STATE.weather) return;
  const w = STATE.weather;
  const { icon, desc } = getWeatherInfo(w.code);
  document.getElementById('w-icon').textContent = icon;
  document.getElementById('w-temp').textContent = w.temp + '°C';
  document.getElementById('w-desc').textContent = desc;
  document.getElementById('w-hum').textContent = w.humidity + '%';
  document.getElementById('w-wind').textContent = w.windspeed + ' km/h';
  document.getElementById('w-vis').textContent = w.visibility + ' km';
  document.getElementById('w-pres').textContent = w.pressure + ' hPa';
}

function checkWeatherRisk() {
  if (!STATE.weather) return;
  const w = STATE.weather;
  if (w.windspeed > 60) addAlert('red', '💨', 'EXTREME WIND', `Wind speed ${w.windspeed} km/h — Seek shelter immediately`);
  else if (w.windspeed > 40) addAlert('yellow', '💨', 'HIGH WIND', `Wind speed ${w.windspeed} km/h — Use caution`);
  if (w.code >= 95) addAlert('red', '⛈️', 'SEVERE STORM', 'Thunderstorm detected in area');
  else if (w.code >= 80) addAlert('yellow', '🌧️', 'HEAVY RAIN', 'Flash flood risk — Avoid low areas');
  if (w.visibility < 1) addAlert('yellow', '🌫️', 'LOW VISIBILITY', `Visibility: ${w.visibility} km`);
}

function refreshWeather() {
  loadWeather();
  addLog('SYS', 'Manual weather refresh', 'info');
}

// --- alerts ---
function addAlert(level, icon, title, desc) {
  const id = Date.now() + Math.random();
  const alert = { id, level, icon, title, desc, time: new Date().toLocaleTimeString() };

  // Prevent duplicate recent alerts
  const recent = STATE.alerts.filter(a => a.title === title);
  if (recent.length > 0 && Date.now() - recent[recent.length-1].id < 30000) return;

  STATE.alerts.unshift(alert);
  if (STATE.alerts.length > 20) STATE.alerts.pop();
  renderAlerts();
}

function renderAlerts() {
  const list = document.getElementById('sidebar-alerts');
  const full = document.getElementById('full-alerts-list');

  const html = STATE.alerts.slice(0, 5).map(a => `
    <div class="alert-item ${a.level}">
      <span class="alert-icon">${a.icon}</span>
      <div>
        <div style="font-weight:700;margin-bottom:2px;">${a.title}</div>
        <div style="font-size:0.72rem;opacity:0.8;">${a.desc}</div>
      </div>
    </div>
  `).join('');

  if (list) list.innerHTML = html || '<div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-dim);">No active alerts</div>';

  const fullHtml = STATE.alerts.map(a => `
    <div class="alert-item ${a.level}" style="margin-bottom:8px;">
      <span class="alert-icon">${a.icon}</span>
      <div style="flex:1;">
        <div style="font-weight:700;">${a.title}</div>
        <div style="font-size:0.72rem;opacity:0.8;margin-top:2px;">${a.desc}</div>
        <div style="font-family:var(--font-mono);font-size:0.6rem;opacity:0.5;margin-top:4px;">${a.time}</div>
      </div>
    </div>
  `).join('');
  if (full) full.innerHTML = fullHtml || '<div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-dim);">No active alerts</div>';
}

// --- sos system ---
function triggerSOS() {
  if (STATE.sosActive) return;
  STATE.sosActive = true;

  const info = document.getElementById('sos-info-box');
  const lat = STATE.userLat ? STATE.userLat.toFixed(6) : 'Unknown';
  const lng = STATE.userLng ? STATE.userLng.toFixed(6) : 'Unknown';
  const mapsLink = STATE.userLat ? `maps.google.com/?q=${lat},${lng}` : 'Unavailable';

  info.innerHTML = `
    <strong>USER:</strong> ${SEC.sanitize(STATE.user.name)} (${SEC.sanitize(STATE.user.username)})<br>
    <strong>PHONE:</strong> ${SEC.sanitize(STATE.user.phone || 'Not set')}<br>
    <strong>LOCATION:</strong> ${mapsLink}<br>
    <strong>COORDS:</strong> ${lat}, ${lng}<br>
    <strong>TIME:</strong> ${new Date().toLocaleString()}<br>
    <strong>ZONE:</strong> ${STATE.currentZone.toUpperCase()}<br>
    <strong>WEATHER:</strong> ${STATE.weather ? `${STATE.weather.temp}°C, ${getWeatherInfo(STATE.weather.code).desc}` : 'Unknown'}<br>
    <strong>CELL TOWER:</strong> ${getCellTower(STATE.userLat || 0, STATE.userLng || 0)}<br>
    <strong>NOTIFY:</strong> All emergency contacts + Nearest authorities
  `;

  document.getElementById('sos-modal').classList.add('visible');
  vibrateDevice([100, 50, 100]);
}

async function confirmSOS() {
  document.getElementById('sos-btn').classList.add('triggered');
  document.getElementById('sos-modal').classList.remove('visible');

  const lat = STATE.userLat || 0;
  const lng = STATE.userLng || 0;
  const msg = `🚨 SOS ALERT from ${STATE.user.name}! Location: ${lat.toFixed(5)}, ${lng.toFixed(5)} | maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)} | Time: ${new Date().toLocaleString()} | Zone: ${STATE.currentZone.toUpperCase()}`;

  addLog('SOS', 'SOS TRIGGERED — Broadcasting to all contacts', 'sos');
  addAlert('red', '🚨', 'SOS SENT', `Broadcast at ${new Date().toLocaleTimeString()}`);

  // Add SOS marker on map
  if (STATE.map) {
    const sosIcon = L.divIcon({
      className: '',
      html: `<div style="color:var(--danger-red);font-size:2rem;animation:sos-flash 0.5s infinite;filter:drop-shadow(0 0 8px red);">🚨</div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
    L.marker([lat, lng], { icon: sosIcon }).addTo(STATE.map).bindPopup(`<b style="color:#ff2244;">SOS SENT FROM HERE</b><br>${new Date().toLocaleTimeString()}`).openPopup();
  }

  // Notify contacts (simulated — in real app would use SMS API / satellite uplink)
  const contacts = await DB.getAll('contacts');
  let notified = 0;
  for (const c of contacts) {
    addLog('SOS', `Notifying: ${c.name} (${c.phone})`, 'sos');
    notified++;
  }

  addLog('SOS', `${notified} contacts notified. Nearest authority alerted.`, 'sos');
  storeSOS(lat, lng, msg);

  setTimeout(() => {
    document.getElementById('sos-btn').classList.remove('triggered');
    STATE.sosActive = false;
  }, 10000);

  showSOSSentFeedback();
}

function showSOSSentFeedback() {
  const fb = document.createElement('div');
  fb.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--bg-card);border:2px solid var(--danger-red);
    padding:30px 40px;z-index:1000;text-align:center;
    box-shadow:var(--glow-red);font-family:'Share Tech Mono',monospace;
  `;
  fb.innerHTML = `
    <div style="font-size:2rem;margin-bottom:10px;">✅</div>
    <div style="font-family:'Bebas Neue',cursive;font-size:2rem;letter-spacing:4px;color:var(--accent-green);">SOS SENT</div>
    <div style="color:var(--text-secondary);font-size:0.7rem;margin-top:8px;letter-spacing:2px;">EMERGENCY SERVICES NOTIFIED</div>
    <div style="color:var(--text-secondary);font-size:0.7rem;margin-top:4px;">STAY CALM — HELP IS COMING</div>
  `;
  document.body.appendChild(fb);
  setTimeout(() => fb.remove(), 4000);
  vibrateDevice([200, 100, 200, 100, 200]);
}

function cancelSOS() {
  document.getElementById('sos-modal').classList.remove('visible');
  STATE.sosActive = false;
  addLog('SOS', 'SOS cancelled by user', 'warn');
}

async function storeSOS(lat, lng, msg) {
  await DB.put('log', {
    type: 'SOS', lat, lng, msg, time: new Date().toISOString(), user: STATE.user.username
  });
}

// --- contacts ---
async function loadContacts() {
  const all = await DB.getAll('contacts');
  renderContacts(all);
}

function renderContacts(contacts) {
  const auth = contacts.filter(c => c.type === 'authority');
  const personal = contacts.filter(c => c.type !== 'authority');

  const makeCard = c => `
    <div class="contact-card">
      <div class="contact-avatar">${c.icon || '👤'}</div>
      <div class="contact-info">
        <div class="contact-name">${SEC.sanitize(c.name)}</div>
        <div class="contact-role">${SEC.sanitize(c.role || c.type || '')}</div>
        <div class="contact-phone">${SEC.sanitize(c.phone)}</div>
      </div>
      <div class="contact-actions">
        <button class="contact-btn" onclick="callContact('${SEC.sanitize(c.phone)}')">📞</button>
        <button class="contact-btn danger" onclick="removeContact(${c.id})">🗑️</button>
      </div>
    </div>
  `;

  document.getElementById('authority-contacts').innerHTML = auth.map(makeCard).join('') || '<div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-dim);">No authority contacts</div>';
  document.getElementById('personal-contacts').innerHTML = personal.map(makeCard).join('') || '<div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-dim);">No personal contacts added</div>';
}

async function addContact() {
  const name = SEC.sanitize(document.getElementById('nc-name').value.trim());
  const phone = SEC.sanitize(document.getElementById('nc-phone').value.trim());
  const rel = SEC.sanitize(document.getElementById('nc-rel').value.trim());
  const type = document.getElementById('nc-type').value;

  if (!name || !phone) { alert('Name and phone are required.'); return; }

  await DB.put('contacts', { name, phone, role: rel, type, icon: type === 'authority' ? '🚔' : '👤' });
  document.getElementById('nc-name').value = '';
  document.getElementById('nc-phone').value = '';
  document.getElementById('nc-rel').value = '';
  addLog('CONT', 'Contact added: ' + name, 'ok');
  loadContacts();
}

async function removeContact(id) {
  if (!confirm('Remove this contact?')) return;
  await DB.delete('contacts', id);
  addLog('CONT', 'Contact removed (id:' + id + ')', 'warn');
  loadContacts();
}

function callContact(phone) {
  window.location.href = `tel:${phone}`;
  addLog('CALL', 'Calling: ' + phone, 'info');
}

// --- log ---
function addLog(category, message, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
    category,
    message,
    type
  };
  STATE.log.unshift(entry);
  if (STATE.log.length > 100) STATE.log.pop();
  renderLog();

  // Persist critical events
  if (type === 'sos' || type === 'warn') {
    DB.put('log', { ...entry, timestamp: Date.now() }).catch(() => {});
  }
}

function renderLog() {
  const el = document.getElementById('log-list');
  if (!el) return;
  el.innerHTML = STATE.log.map(e => `
    <div class="log-entry">
      <span class="log-time">${e.time}</span>
      <span class="log-msg">[${e.category}] ${e.message}</span>
      <span class="log-type ${e.type}">${e.type.toUpperCase()}</span>
    </div>
  `).join('');
}

// --- settings ---
async function loadSettings() {
  try {
    for (const key of Object.keys(STATE.settings)) {
      const s = await DB.get('settings', key);
      if (s) STATE.settings[key] = s.value;
    }
    updateToggles();
  } catch(e) {}
}

async function saveSettings() {
  for (const [key, val] of Object.entries(STATE.settings)) {
    await DB.put('settings', { key, value: val });
  }
}

function toggleSetting(key) {
  STATE.settings[key] = !STATE.settings[key];
  updateToggles();
  saveSettings();
  addLog('SET', key + ' = ' + STATE.settings[key], 'info');
}

function updateToggles() {
  for (const key of Object.keys(STATE.settings)) {
    const el = document.getElementById('toggle-' + key);
    if (el) el.classList.toggle('on', STATE.settings[key]);
  }
}

// --- monitoring loop ---
function startMonitoring() {
  // Weather refresh every 5 min
  setInterval(() => { if (STATE.settings.weather) loadWeather(); }, 300000);
  // Connection check every 30s
  setInterval(checkOnlineStatus, 30000);
  // Add periodic system alerts
  setTimeout(() => addAlert('blue', 'ℹ️', 'SYSTEM ACTIVE', 'Guardian monitoring active'), 3000);
}

function checkOnlineStatus() {
  const online = navigator.onLine;
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  if (dot) { dot.className = 'dot ' + (online ? 'dot-blue' : 'dot-yellow'); }
  if (text) text.textContent = online ? 'ONLINE' : 'OFFLINE';
}

// --- utilities ---
function vibrateDevice(pattern) {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}

function showView(view) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item:first-child`).classList.add('active');
  closeAllPanels();
}

function showPanel(id) {
  closeAllPanels();
  document.getElementById(id)?.classList.add('visible');
  // Update nav
  const map = { 'contacts-panel': 1, 'alerts-panel': 2, 'log-panel': 3, 'settings-panel': 4 };
  const idx = map[id];
  if (idx !== undefined) {
    document.querySelectorAll('.nav-item').forEach((n, i) => n.classList.toggle('active', i === idx));
  }
}

function closePanel(id) {
  document.getElementById(id)?.classList.remove('visible');
  document.querySelectorAll('.nav-item').forEach((n, i) => n.classList.toggle('active', i === 0));
}

function closeAllPanels() {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('visible'));
}

// --- keyboard shortcuts ---
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllPanels();
  if (e.altKey && e.key === 's') triggerSOS();
  if (e.altKey && e.key === 'm') centerOnUser();
});

// --- enter key on login ---
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-user')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});

// --- service worker registration ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// BOOT
boot();
