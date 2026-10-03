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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ApoWow-RaiderIO-Chatbot/1.0',
      'Accept': 'application/json',
    },
  });

  if (response.status === 429) throw new Error('RATE_LIMIT');

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
      return Number.isFinite(start) &&
        start <= now &&
        (!Number.isFinite(end) || now < end);
    })
    .sort(
      (a, b) =>
        Date.parse(b.starts?.[region] || '') -
        Date.parse(a.starts?.[region] || '')
    );

  if (active.length) return active[0];

  return (
    main
      .filter((s) => {
        const start = Date.parse(s.starts?.[region] || '');
        return Number.isFinite(start) && start <= now;
      })
      .sort(
        (a, b) =>
          Date.parse(b.starts?.[region] || '') -
          Date.parse(a.starts?.[region] || '')
      )[0] || null
  );
}

async function getSeasonSlug(region) {
  const cached = seasonCache.get(region);

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.slug;
  }

  const url = new URL(`${RIO_BASE}/mythic-plus/static-data`);
  url.searchParams.set('expansion_id', String(EXPANSION_ID));

  const data = await fetchJson(url);
  const season = getCurrentSeason(data?.seasons, region);

  if (!season?.slug) throw new Error('NO_SEASON');

  seasonCache.set(region, {
    slug: season.slug,
    at: Date.now(),
  });

  return season.slug;
}

async function getCutoffs(region, season) {
  const key = `${region}:${season}`;
  const cached = cutoffCache.get(key);

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const url = new URL(`${RIO_BASE}/mythic-plus/season-cutoffs`);
  url.searchParams.set('region', region);
  url.searchParams.set('season', season);

  const data = await fetchJson(url);

  const top01 = num(data?.cutoffs?.p999?.all?.quantileMinValue);
  const top1 = num(data?.cutoffs?.p990?.all?.quantileMinValue);

  if (top01 === null || top1 === null) {
    throw new Error('NO_CUTOFF');
  }

  const value = { top01, top1 };

  cutoffCache.set(key, {
    value,
    at: Date.now(),
  });

  return value;
}

function reply(res, status, text, cache = false) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    cache
      ? 'public, s-maxage=60, stale-while-revalidate=300'
      : 'no-store'
  );
  res.end(text);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return reply(res, 405, 'Usa GET.');
  }

  try {
    const [seasonEU, seasonUS] = await Promise.all([
      getSeasonSlug('eu'),
      getSeasonSlug('us'),
    ]);

    const [eu, us] = await Promise.all([
      getCutoffs('eu', seasonEU),
      getCutoffs('us', seasonUS),
    ]);

    return reply(
      res,
      200,
      `Cutoff EU: 0.1% ${fmt(eu.top01)} | 1% ${fmt(eu.top1)} | Cutoff US: 0.1% ${fmt(us.top01)} | 1% ${fmt(us.top1)}`,
      true
    );
  } catch (error) {
    const code = error?.message || 'UNKNOWN';

    if (code === 'RATE_LIMIT') {
      return reply(
        res,
        503,
        'Raider.IO esta limitando consultas. Prueba de nuevo en unos segundos.'
      );
    }

    console.error('[apo-cutoff]', error);
    return reply(
      res,
      500,
      'No he podido consultar los cutoffs de Raider.IO ahora mismo.'
    );
  }
}
