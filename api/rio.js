const RIO_BASE = 'https://raider.io/api/v1';
const EXPANSION_ID = 11;
const CACHE_TTL_MS = 10 * 60 * 1000;

let seasonCache = new Map();
let cutoffCache = new Map();

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function normalizeRegion(value) {
  const region = String(value || 'eu').trim().toLowerCase();
  return region === 'us' ? 'us' : region === 'eu' ? 'eu' : null;
}

function normalizeRealm(value) {
  return String(value || '')
    .trim()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ApoWow-RaiderIO-Chatbot/1.0',
      'Accept': 'application/json',
    },
  });

  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    const err = new Error('RATE_LIMIT');
    err.retryAfter = retry;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`HTTP_${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

function getCurrentSeason(seasons, region) {
  if (!Array.isArray(seasons)) return null;

  const now = Date.now();
  const main = seasons.filter((s) => s && s.is_main_season);

  const active = main
    .filter((s) => {
      const start = Date.parse(s.starts?.[region] || '');
      const end = Date.parse(s.ends?.[region] || '');
      return Number.isFinite(start) && start <= now && (!Number.isFinite(end) || now < end);
    })
    .sort((a, b) => Date.parse(b.starts?.[region] || '') - Date.parse(a.starts?.[region] || ''));

  if (active.length) return active[0];

  return main
    .filter((s) => {
      const start = Date.parse(s.starts?.[region] || '');
      return Number.isFinite(start) && start <= now;
    })
    .sort((a, b) => Date.parse(b.starts?.[region] || '') - Date.parse(a.starts?.[region] || ''))[0] || null;
}

async function getSeasonSlug(region) {
  const cached = seasonCache.get(region);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.slug;

  const url = new URL(`${RIO_BASE}/mythic-plus/static-data`);
  url.searchParams.set('expansion_id', String(EXPANSION_ID));

  const data = await fetchJson(url);
  const season = getCurrentSeason(data.seasons, region);
  if (!season?.slug) throw new Error('NO_SEASON');

  seasonCache.set(region, { slug: season.slug, at: Date.now() });
  return season.slug;
}

async function getCutoff(region, season) {
  const key = `${region}:${season}`;
  const cached = cutoffCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const url = new URL(`${RIO_BASE}/mythic-plus/season-cutoffs`);
  url.searchParams.set('region', region);
  url.searchParams.set('season', season);

  const data = await fetchJson(url);
  const cutoff = num(data?.cutoffs?.p999?.all?.quantileMinValue);
  if (cutoff === null) throw new Error('NO_CUTOFF');

  cutoffCache.set(key, { value: cutoff, at: Date.now() });
  return cutoff;
}

function extractCurrentScore(data, season) {
  const seasons = data?.mythic_plus_scores_by_season;
  if (!Array.isArray(seasons)) return null;

  const exact = seasons.find((entry) => entry?.season === season);
  if (exact) return num(exact?.scores?.all);

  return num(seasons[0]?.scores?.all);
}

async function getCharacter(region, realm, name, season) {
  const url = new URL(`${RIO_BASE}/characters/profile`);
  url.searchParams.set('region', region);
  url.searchParams.set('realm', realm);
  url.searchParams.set('name', name);
  url.searchParams.set('fields', 'mythic_plus_scores_by_season:current');

  const data = await fetchJson(url);
  const score = extractCurrentScore(data, season);
  if (score === null) throw new Error('NO_SCORE');

  return {
    name: data?.name || name,
    realm: data?.realm || realm,
    score,
  };
}

function reply(res, status, text, cache = false) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cache) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(text);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return reply(res, 405, 'Usa GET. Ejemplo: /api/rio?name=Apodruid&realm=zuljin&region=eu');
  }

  const name = String(req.query?.name || '').trim();
  const realm = normalizeRealm(req.query?.realm);
  const region = normalizeRegion(req.query?.region);

  if (!name || !realm) {
    return reply(res, 400, 'Uso: !rio PERSONAJE REINO [eu/us]');
  }

  if (!region) {
    return reply(res, 400, 'Region no valida. Usa eu o us.');
  }

  if (!/^[a-zA-ZÀ-ÿ0-9'-]{2,24}$/.test(name)) {
    return reply(res, 400, 'Nombre de personaje no valido.');
  }

  if (!/^[a-zA-Z0-9'-]{2,40}$/.test(realm)) {
    return reply(res, 400, 'Reino no valido. Usa el slug, por ejemplo zuljin, tarren-mill o area-52.');
  }

  try {
    const season = await getSeasonSlug(region);
    const [cutoff, character] = await Promise.all([
      getCutoff(region, season),
      getCharacter(region, realm, name, season),
    ]);

    const diff = character.score - cutoff;
    const regionLabel = region.toUpperCase();
    const who = `${character.name}-${character.realm}`;

    if (diff >= 0) {
      return reply(
        res,
        200,
        `${who}: ${fmt(character.score)} RIO | 🟢 +${fmt(diff)} dentro del cutoff ${regionLabel} 0.1% (${fmt(cutoff)})`,
        true
      );
    }

    return reply(
      res,
      200,
      `${who}: ${fmt(character.score)} RIO | 🔴 ${fmt(diff)} del cutoff ${regionLabel} 0.1% (${fmt(cutoff)})`,
      true
    );
  } catch (error) {
    const code = error?.message || 'UNKNOWN';

    if (code === 'HTTP_400' || code === 'HTTP_404' || code === 'NO_SCORE') {
      return reply(res, 404, `No encuentro ${name}-${realm} en ${region.toUpperCase()} o no tiene score actual.`);
    }

    if (code === 'RATE_LIMIT') {
      return reply(res, 503, 'Raider.IO esta limitando consultas. Prueba de nuevo en unos segundos.');
    }

    console.error('[apo-rio]', error);
    return reply(res, 500, 'No he podido consultar Raider.IO ahora mismo. Prueba de nuevo en unos segundos.');
  }
}
