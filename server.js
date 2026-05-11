'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const dgram = require('dgram');

const CONFIG_PATH = path.join(__dirname, 'config.json');
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = CONFIG.port || 3000;
const { lat, lon, name: cityName } = CONFIG.location;

// ── WiZ UDP ──────────────────────────────────────────────────────────────────

const WIZ_PORT = 38899;

function wizSend(ip, payload) {
  return new Promise((resolve, reject) => {
    const sock  = dgram.createSocket('udp4');
    const msg   = Buffer.from(JSON.stringify(payload));
    const timer = setTimeout(() => { try { sock.close(); } catch (_) {} reject(new Error('timeout')); }, 2000);
    sock.on('message', buf => {
      clearTimeout(timer); try { sock.close(); } catch (_) {}
      try { resolve(JSON.parse(buf.toString())); } catch (e) { reject(e); }
    });
    sock.on('error', err => { clearTimeout(timer); try { sock.close(); } catch (_) {} reject(err); });
    sock.send(msg, WIZ_PORT, ip, err => {
      if (err) { clearTimeout(timer); try { sock.close(); } catch (_) {} reject(err); }
    });
  });
}

async function getPilot(ip) {
  try { return (await wizSend(ip, { method: 'getPilot', params: {} })).result || null; }
  catch (_) { return null; }
}
async function setPilot(ip, params) {
  try { await wizSend(ip, { method: 'setPilot', params }); return true; }
  catch (e) { console.error(`setPilot ${ip}: ${e.message}`); return false; }
}
async function getSystemConfig(ip) {
  try { return (await wizSend(ip, { method: 'getSystemConfig', params: {} })).result || null; }
  catch (_) { return null; }
}

// ── State cache ───────────────────────────────────────────────────────────────

const stateCache = {};

async function pollAll() {
  for (const dev of CONFIG.devices) {
    const p = await getPilot(dev.ip);
    if (p) stateCache[dev.mac] = { on: !!p.state, dimming: p.dimming || 100, temp: p.temp || null };
  }
}
pollAll();
setInterval(pollAll, 30000);

async function discoverNames() {
  let changed = false;
  for (const dev of CONFIG.devices) {
    if (dev.room !== 'TBD') continue;
    const sys = await getSystemConfig(dev.ip);
    if (sys && sys.moduleName) {
      dev.name = sys.moduleName;
      if (sys.env && sys.env !== 'TBD') dev.room = sys.env;
      changed = true;
      console.log(`Discovered ${dev.ip}: "${dev.name}" / "${dev.room}"`);
    }
  }
  if (changed) saveConfig();
}
discoverNames();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
}

// ── Weather ───────────────────────────────────────────────────────────────────

const WMO = {
  0:'Clear', 1:'Mostly Clear', 2:'Partly Cloudy', 3:'Overcast',
  45:'Foggy', 48:'Icy Fog',
  51:'Light Drizzle', 53:'Drizzle', 55:'Heavy Drizzle',
  61:'Light Rain', 63:'Rain', 65:'Heavy Rain',
  71:'Light Snow', 73:'Snow', 75:'Heavy Snow',
  80:'Showers', 81:'Rain Showers', 82:'Heavy Showers',
  95:'Thunderstorm', 99:'Severe Thunderstorm',
};

let wx = null, wxAt = 0;

async function fetchWeather() {
  if (wx && Date.now() - wxAt < 10 * 60 * 1000) return wx;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weathercode,relative_humidity_2m,precipitation_probability,wind_speed_10m,uv_index` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,uv_index_max` +
      `&timezone=auto&forecast_days=7`;
    const d = await (await fetch(url)).json();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const forecast = d.daily.time.map((t, i) => ({
      day:       days[new Date(t).getDay()],
      code:      d.daily.weathercode[i],
      condition: WMO[d.daily.weathercode[i]] || 'Unknown',
      high:      Math.round(d.daily.temperature_2m_max[i]),
      low:       Math.round(d.daily.temperature_2m_min[i]),
      precip:    d.daily.precipitation_probability_max[i] || 0,
      wind:      Math.round(d.daily.wind_speed_10m_max[i] || 0),
    }));
    wx = {
      temp:      Math.round(d.current.temperature_2m),
      code:      d.current.weathercode,
      condition: WMO[d.current.weathercode] || 'Unknown',
      humidity:  d.current.relative_humidity_2m,
      precip:    d.current.precipitation_probability || 0,
      wind:      Math.round(d.current.wind_speed_10m || 0),
      uv:        Math.round(d.current.uv_index || 0),
      high:      Math.round(d.daily.temperature_2m_max[0]),
      low:       Math.round(d.daily.temperature_2m_min[0]),
      city:      cityName,
      forecast,
    };
    wxAt = Date.now();
  } catch (_) {
    if (!wx) wx = { temp:'--', code:3, condition:'Unavailable', humidity:'--', precip:0,
                    wind:'--', uv:'--', high:'--', low:'--', city: cityName, forecast:[] };
  }
  return wx;
}
fetchWeather();
setInterval(fetchWeather, 10 * 60 * 1000);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type':'application/json',
                           'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let s = '', len = 0;
    req.on('data', c => {
      len += c.length;
      if (len > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      s += c;
    });
    req.on('end', () => resolve(s));
  });
}

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json' };

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/api/state' && req.method === 'GET') {
    return sendJSON(res, { tzOffset: new Date().getTimezoneOffset(), weather: await fetchWeather(), devices: stateCache,
                           config: { devices: CONFIG.devices, scenes: CONFIG.scenes } });
  }

  if (p.startsWith('/api/device/') && req.method === 'POST') {
    let mac;
    try { mac = decodeURIComponent(p.split('/')[3]); } catch (_) { return sendJSON(res, { error:'bad request' }, 400); }
    const dev = CONFIG.devices.find(d => d.mac === mac);
    if (!dev) return sendJSON(res, { error:'not found' }, 404);
    let params;
    try { params = JSON.parse(await readBody(req)); } catch (_) { return sendJSON(res, { error:'bad request' }, 400); }
    await setPilot(dev.ip, params);
    const s = stateCache[mac] || {};
    stateCache[mac] = {
      on:      params.state   !== undefined ? params.state   : s.on,
      dimming: params.dimming !== undefined ? params.dimming : s.dimming,
      temp:    params.temp    !== undefined ? params.temp    : s.temp,
    };
    return sendJSON(res, { ok:true });
  }

  if (p.startsWith('/api/scene/') && req.method === 'POST') {
    const scene = CONFIG.scenes[parseInt(p.split('/')[3])];
    if (!scene) return sendJSON(res, { error:'not found' }, 404);
    for (const cmd of scene.commands) {
      const targets = cmd.all  ? CONFIG.devices
                    : cmd.room ? CONFIG.devices.filter(d => d.room === cmd.room)
                    :            CONFIG.devices.filter(d => d.mac  === cmd.mac);
      const params = {};
      if (cmd.state   !== undefined) params.state   = cmd.state;
      if (cmd.dimming !== undefined) params.dimming = cmd.dimming;
      if (cmd.temp    !== undefined) params.temp    = cmd.temp;
      if (cmd.r       !== undefined) params.r       = cmd.r;
      if (cmd.g       !== undefined) params.g       = cmd.g;
      if (cmd.b       !== undefined) params.b       = cmd.b;
      for (const dev of targets) {
        await setPilot(dev.ip, params);
        const s = stateCache[dev.mac] || {};
        stateCache[dev.mac] = {
          on:      params.state   !== undefined ? params.state   : s.on,
          dimming: params.dimming !== undefined ? params.dimming : s.dimming,
          temp:    params.temp    !== undefined ? params.temp    : s.temp,
        };
      }
    }
    return sendJSON(res, { ok:true });
  }

  // Admin: save full config
  if (p === '/api/admin/config' && req.method === 'POST') {
    try {
      const incoming = JSON.parse(await readBody(req));
      CONFIG.devices = incoming.devices;
      CONFIG.scenes  = incoming.scenes;
      saveConfig();
      return sendJSON(res, { ok:true });
    } catch (e) { return sendJSON(res, { error: e.message }, 400); }
  }

  // Static files
  let file = path.join(PUBLIC, p === '/' ? '/index.html' : p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Dashboard → http://localhost:${PORT}`));
