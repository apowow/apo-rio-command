const RIO_BASE = 'https://raider.io/api/v1';

const DUNGEONS = [
  "Altar of Fangs",
  "Den of Nalorakk",
  "King's Rest",
  "Murder Row",
  "Ruby Life Pools",
  "Temple of Sethraliss",
  "The Blinding Vale",
  "Voidscar Arena",
];

function normalizeRegion(value) {
  const raw = String(value ?? '').trim().toLowerCase();

  if (
    raw === '' ||
    raw === 'undefined' ||
    raw === 'null' ||
    raw === 'none'
  ) {
    return 'eu';
  }

  return raw === 'us' ? 'us' : raw === 'eu' ? 'eu' : null;
}

function normalizeRealm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getDungeonName(run) {
  if (!run?.dungeon) return '';
  return typeof run.dungeon === 'string'
    ? run.dungeon
    : run.dungeon.name || '';
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

async function getCharacter(region, realm, name) {
  const candidates = [...new Set([
    realm,
    realm.replace(/-/g, ''),
  ])].filter(Boolean);

  let lastError = null;

  for (const realmCandidate of candidates) {
    const url = new URL(`${RIO_BASE}/characters/profile`);
    url.searchParams.set('region', region);
    url.searchParams.set('realm', realmCandidate);
    url.searchParams.set('name', name);
    url.searchParams.set(
      'fields',
      'mythic_plus_best_runs:all,mythic_plus_alternate_runs'
    );

    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      const code = error?.message || '';
      if (code !== 'HTTP_400' && code !== 'HTTP_404' && code !== 'HTTP_422') {
        throw error;
      }
    }
  }

  throw lastError || new Error('HTTP_404');
}

function extractDungeonLevels(data) {
  const best = Array.isArray(data?.mythic_plus_best_runs)
    ? data.mythic_plus_best_runs
    : [];

  const alt = Array.isArray(data?.mythic_plus_alternate_runs)
    ? data.mythic_plus_alternate_runs
    : [];

  const runs = [...best, ...alt];
  const levels = new Map();

  for (const run of runs) {
    const dungeonName = getDungeonName(run);
    if (!dungeonName) continue;

    const key = normalizeName(dungeonName);
    const level = Number(run?.mythic_level);

    if (!Number.isFinite(level)) continue;

    const current = levels.get(key);
    if (current === undefined || level > current) {
      levels.set(key, level);
    }
  }

  return DUNGEONS.map((dungeon) => ({
    dungeon,
    level: levels.get(normalizeName(dungeon)) ?? null,
  }));
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

  const name = String(req.query?.name || '').trim();
  const realm = normalizeRealm(req.query?.realm);
  const region = normalizeRegion(req.query?.region);

  if (!name || !realm) {
    return reply(res, 400, 'Uso: !keys PERSONAJE REINO [eu/us]');
  }

  if (!region) {
    return reply(res, 400, 'Region no valida. Usa eu o us.');
  }

  try {
    const data = await getCharacter(region, realm, name);
    const characterName = data?.name || name;
    const characterRealm = data?.realm || realm;
    const levels = extractDungeonLevels(data);

    const text = levels
      .map(({ dungeon, level }) => `${dungeon}: ${level ?? '—'}`)
      .join(' | ');

    return reply(
      res,
      200,
      `${characterName}-${characterRealm} (${region.toUpperCase()}) | ${text}`,
      true
    );
  } catch (error) {
    const code = error?.message || 'UNKNOWN';

    if (code === 'HTTP_400' || code === 'HTTP_404' || code === 'HTTP_422') {
      return reply(
        res,
        404,
        `No encuentro ${name}-${realm} en ${region.toUpperCase()}.`
      );
    }

    if (code === 'RATE_LIMIT') {
      return reply(
        res,
        503,
        'Raider.IO esta limitando consultas. Prueba de nuevo en unos segundos.'
      );
    }

    console.error('[apo-keys]', error);
    return reply(
      res,
      500,
      'No he podido consultar Raider.IO ahora mismo. Prueba de nuevo en unos segundos.'
    );
  }
}
