import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

async function fetchWeatherLayer(lat, lng) {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lng));
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,precipitation,cloud_cover');
    url.searchParams.set('hourly', 'soil_moisture_0_to_1cm,soil_moisture_1_to_3cm');
    url.searchParams.set('timezone', 'auto');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

    const data = await res.json();
    const current = data.current || {};
    const hourly = data.hourly || {};
    const soilRaw =
      Array.isArray(hourly.soil_moisture_0_to_1cm) && hourly.soil_moisture_0_to_1cm.length > 0
        ? hourly.soil_moisture_0_to_1cm[0]
        : null;

    return {
      weather_updated_at: current.time || new Date().toISOString(),
      cloud_cover_pct: typeof current.cloud_cover === 'number' ? current.cloud_cover : null,
      temperature_c: typeof current.temperature_2m === 'number' ? current.temperature_2m : null,
      humidity_pct: typeof current.relative_humidity_2m === 'number' ? current.relative_humidity_2m : null,
      precipitation_mm: typeof current.precipitation === 'number' ? current.precipitation : null,
      soil_moisture_pct: typeof soilRaw === 'number' ? Number((soilRaw * 100).toFixed(1)) : null,
      source: 'Open-Meteo'
    };
  } catch (err) {
    return {
      weather_updated_at: null,
      cloud_cover_pct: null,
      temperature_c: null,
      humidity_pct: null,
      precipitation_mm: null,
      soil_moisture_pct: null,
      source: `Open-Meteo gecici limit (${err.message})`
    };
  }
}

async function getCopernicusToken() {
  const clientId = process.env.COPERNICUS_CLIENT_ID;
  const clientSecret = process.env.COPERNICUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const res = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }
  );
  if (!res.ok) throw new Error(`Copernicus Auth HTTP ${res.status}`);
  const tokenData = await res.json();
  return tokenData.access_token || null;
}

async function fetchSatelliteStats(token, bbox, fromDate, now) {
  if (!token) {
    return {
      ndvi_index: null,
      lai_index: null,
      satellite_observation_date: null,
      status: 'Veri Bekleniyor (COPERNICUS_CLIENT_ID / SECRET tanimli degil)'
    };
  }

  try {
    const evalscript = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  const invalid = [3, 8, 9, 10].includes(samples.SCL) || samples.dataMask === 0;
  if (invalid || (samples.B08 + samples.B04) === 0) {
    return { ndvi: [NaN], dataMask: [0] };
  }
  const ndvi = (samples.B08 - samples.B04) / (samples.B08 + samples.B04);
  return { ndvi: [ndvi], dataMask: [1] };
}`;

    const res = await fetch('https://sh.dataspace.copernicus.eu/api/v1/statistics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { bounds: { bbox }, data: [{ type: 'sentinel-2-l2a' }] },
        aggregation: {
          timeRange: { from: fromDate.toISOString(), to: now.toISOString() },
          aggregationInterval: { of: 'P14D' },
          evalscript
        }
      })
    });

    if (!res.ok) throw new Error(`Sentinel Hub Statistical HTTP ${res.status}`);
    const stats = await res.json();
    const entry = Array.isArray(stats.data) ? stats.data[stats.data.length - 1] : null;
    const ndviMean = entry?.outputs?.ndvi?.bands?.B0?.stats?.mean;

    if (typeof ndviMean !== 'number' || Number.isNaN(ndviMean)) {
      return {
        ndvi_index: null,
        lai_index: null,
        satellite_observation_date: entry?.interval?.to || null,
        status: 'Bulut ortusu nedeniyle gecerli uydu gozlemi alinamadi'
      };
    }

    const ndvi = Number(ndviMean.toFixed(3));
    const lai = Number(Math.max(0, 3.618 * ndvi - 0.118).toFixed(2));
    return {
      ndvi_index: ndvi,
      lai_index: lai,
      satellite_observation_date: entry?.interval?.to || now.toISOString(),
      status: 'Sentinel-2 L2A (Copernicus Data Space)'
    };
  } catch (err) {
    return {
      ndvi_index: null,
      lai_index: null,
      satellite_observation_date: null,
      status: `Uydu istatistik hatasi: ${err.message}`
    };
  }
}

async function fetchHeatmapPng(token, bbox, fromDate, now, evalscript) {
  const res = await fetch('https://sh.dataspace.copernicus.eu/api/v1/process', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'image/png'
    },
    body: JSON.stringify({
      input: {
        bounds: { bbox },
        data: [{
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: { from: fromDate.toISOString(), to: now.toISOString() },
            mosaickingOrder: 'leastCC'
          }
        }]
      },
      output: { width: 512, height: 512, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
      evalscript
    })
  });
  if (!res.ok) throw new Error(`Sentinel Hub Processing HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function fetchVisualLayers(token, bbox, fromDate, now) {
  if (!token) {
    return {
      bbox,
      soil_moisture_map_base64: null,
      lai_map_base64: null,
      mineral_map_base64: null,
      status: 'Veri Bekleniyor (COPERNICUS_CLIENT_ID / SECRET tanimli degil)'
    };
  }

  try {
    const moistureScript = `//VERSION=3
function setup() { return { input: ["B08", "B11", "SCL", "dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  if ([3, 8, 9, 10].includes(s.SCL) || s.dataMask === 0) return [0, 0, 0, 0];
  const ndmi = (s.B08 - s.B11) / (s.B08 + s.B11 + 1e-6);
  if (ndmi < -0.1) return [0.85, 0.2, 0.15, 0.85];
  if (ndmi < 0.1) return [0.95, 0.8, 0.2, 0.85];
  if (ndmi < 0.3) return [0.2, 0.75, 0.55, 0.85];
  return [0.1, 0.4, 0.9, 0.85];
}`;

    const laiScript = `//VERSION=3
function setup() { return { input: ["B04", "B08", "SCL", "dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  if ([3, 8, 9, 10].includes(s.SCL) || s.dataMask === 0) return [0, 0, 0, 0];
  const ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 1e-6);
  if (ndvi < 0.2) return [0.8, 0.25, 0.15, 0.85];
  if (ndvi < 0.45) return [0.95, 0.85, 0.25, 0.85];
  if (ndvi < 0.65) return [0.45, 0.8, 0.25, 0.85];
  return [0.1, 0.55, 0.2, 0.85];
}`;

    const mineralScript = `//VERSION=3
function setup() { return { input: ["B05", "B8A", "SCL", "dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  if ([3, 8, 9, 10].includes(s.SCL) || s.dataMask === 0) return [0, 0, 0, 0];
  const ndre = (s.B8A - s.B05) / (s.B8A + s.B05 + 1e-6);
  if (ndre < 0.15) return [0.35, 0.1, 0.45, 0.85];
  if (ndre < 0.3) return [0.75, 0.25, 0.55, 0.85];
  if (ndre < 0.45) return [0.95, 0.55, 0.2, 0.85];
  return [0.98, 0.85, 0.25, 0.85];
}`;

    const [soilMap, laiMap, mineralMap] = await Promise.all([
      fetchHeatmapPng(token, bbox, fromDate, now, moistureScript),
      fetchHeatmapPng(token, bbox, fromDate, now, laiScript),
      fetchHeatmapPng(token, bbox, fromDate, now, mineralScript)
    ]);

    return {
      bbox,
      soil_moisture_map_base64: soilMap,
      lai_map_base64: laiMap,
      mineral_map_base64: mineralMap,
      status: 'Sentinel-2 L2A Processing API (Gercek uydu goruntu katmanlari)'
    };
  } catch (err) {
    return {
      bbox,
      soil_moisture_map_base64: null,
      lai_map_base64: null,
      mineral_map_base64: null,
      status: `Uydu gorsel hatasi: ${err.message}`
    };
  }
}

async function fetchNvidiaInference({ lat, lng, cropType, weather, satellite }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    const ndviPart = satellite.ndvi_index !== null ? `NDVI ${satellite.ndvi_index}, LAI ${satellite.lai_index} olculdu.` : 'Uydu gozlemi alinamadi.';
    return {
      minerals: { nitrogen_n: null, phosphorus_p: null, potassium_k: null },
      crop_height_cm: null,
      estimated_yield_change_pct: null,
      optimal_harvest_window_days: null,
      harman_summary: `${ndviPart} NVIDIA API anahtari eklendiginde mineral ve verim cikarimi da aktif olacaktir.`,
      status: 'Veri Bekleniyor (NVIDIA_API_KEY tanimli degil)'
    };
  }

  if (satellite.ndvi_index === null) {
    return {
      minerals: { nitrogen_n: null, phosphorus_p: null, potassium_k: null },
      crop_height_cm: null,
      estimated_yield_change_pct: null,
      optimal_harvest_window_days: null,
      harman_summary: 'Veri bekleniyor: Uydu olcumu eksik oldugu icin cikarim yapilmadi.',
      status: 'Veri Bekleniyor (Uydu verisi eksik)'
    };
  }

  const model = process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct';
  const prompt = `Tarim Turkiye Harman yapay zekasi olarak koordinat (${lat}, ${lng}) ve urun "${cropType || 'Genel Tarla'}" icin SADECE verilen olcumlere dayanarak JSON uret.
Olcumler: NDVI=${satellite.ndvi_index}, LAI=${satellite.lai_index}, Toprak Nemi=%${weather.soil_moisture_pct}, Sicaklik=${weather.temperature_c}C.
Sadece su JSON yapisini dondur:
{"nitrogen_n": number|null, "phosphorus_p": number|null, "potassium_k": number|null, "crop_height_cm": number|null, "estimated_yield_change_pct": number|null, "optimal_harvest_window_days": number|null, "harman_summary": string}`;

  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.1, max_tokens: 350, messages: [{ role: 'user', content: prompt }] })
  });

  if (!res.ok) throw new Error(`NVIDIA API HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  return {
    minerals: {
      nitrogen_n: parsed.nitrogen_n ?? null,
      phosphorus_p: parsed.phosphorus_p ?? null,
      potassium_k: parsed.potassium_k ?? null
    },
    crop_height_cm: parsed.crop_height_cm ?? null,
    estimated_yield_change_pct: parsed.estimated_yield_change_pct ?? null,
    optimal_harvest_window_days: parsed.optimal_harvest_window_days ?? null,
    harman_summary: parsed.harman_summary || 'Olcumler alindi.',
    status: `NVIDIA NIM (${model}) - Uydu + Hava Cikarimi`
  };
}

async function computeLandValues({ lat, lng, cropType }) {
  const cacheKey = `${lat.toFixed(4)}:${lng.toFixed(4)}:${(cropType || '').toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.payload, cached: true };
  }

  const delta = 0.0025;
  const bbox = [lng - delta, lat - delta, lng + delta, lat + delta];
  const now = new Date();
  const fromDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  let token = null;
  let tokenErr = null;
  try {
    token = await getCopernicusToken();
  } catch (err) {
    tokenErr = err.message;
  }

  const [weather, satellite, visualLayers] = await Promise.all([
    fetchWeatherLayer(lat, lng),
    tokenErr ? Promise.resolve({ ndvi_index: null, lai_index: null, satellite_observation_date: null, status: tokenErr }) : fetchSatelliteStats(token, bbox, fromDate, now),
    tokenErr ? Promise.resolve({ bbox, soil_moisture_map_base64: null, lai_map_base64: null, mineral_map_base64: null, status: tokenErr }) : fetchVisualLayers(token, bbox, fromDate, now)
  ]);

  const nvidia = await fetchNvidiaInference({ lat, lng, cropType, weather, satellite });

  const payload = {
    report_generated: false,
    coordinates: {
      lat,
      lng,
      satellite_observation_date: satellite.satellite_observation_date,
      weather_updated_at: weather.weather_updated_at,
      cloud_cover_pct: weather.cloud_cover_pct
    },
    values: {
      ndvi_index: satellite.ndvi_index,
      soil_moisture_pct: weather.soil_moisture_pct,
      lai_index: satellite.lai_index,
      minerals: nvidia.minerals,
      crop_height_cm: nvidia.crop_height_cm,
      estimated_yield_change_pct: nvidia.estimated_yield_change_pct,
      optimal_harvest_window_days: nvidia.optimal_harvest_window_days
    },
    visual_layers: visualLayers,
    harman_summary: nvidia.harman_summary,
    field_status: {
      ndvi_index: satellite.status,
      lai_index: satellite.status,
      soil_moisture_pct: weather.source,
      visual_layers: visualLayers.status,
      minerals_and_yield: nvidia.status
    }
  };

  if (satellite.ndvi_index !== null) {
    cache.set(cacheKey, { ts: Date.now(), payload });
  }
  return payload;
}

function validateCoordinates(body) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, cropType: body?.crop_type || body?.cropType || null };
}

app.get('/health', (_req, res) => res.json({ ok: true, report_generated: false }));

app.post('/api/v1/land-values', async (req, res) => {
  const coords = validateCoordinates(req.body);
  if (!coords) return res.status(400).json({ error: 'Gecerli lat ve lng koordinati gerekli.' });
  try {
    return res.json(await computeLandValues(coords));
  } catch (err) {
    return res.status(502).json({ report_generated: false, error: 'Dis API katmanindan veri alinamadi.', detail: err.message });
  }
});

app.post('/api/v1/webhooks/harman-land', async (req, res) => {
  const expectedSecret = process.env.HARMAN_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-harman-secret'] !== expectedSecret) {
    return res.status(401).json({ error: 'Yetkisiz webhook istegi.' });
  }
  const coords = validateCoordinates(req.body);
  if (!coords) return res.status(400).json({ error: 'Gecerli lat ve lng koordinati gerekli.' });
  try {
    return res.json(await computeLandValues(coords));
  } catch (err) {
    return res.status(502).json({ report_generated: false, error: 'Harman webhook veri isleme hatasi.', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Tarim Turkiye ara katman servisi ${PORT} portunda calisiyor.`));
