const RIO_BASE = 'https://raider.io/api/v1';

const CHARACTERS = {
  apodruid: { name: 'Apodruid', realm: "Zul'jin", region: 'eu' },
  apomage: { name: 'Apomage', realm: "Zul'jin", region: 'eu' },
  apolocko: { name: 'Apolocko', realm: "Zul'jin", region: 'eu' },
};

const DUNGEONS = [
  { name: 'Temple of Sethraliss', short: 'TEMPLE' },
  { name: 'Ruby Life Pools', short: 'POOLS' },
  { name: 'Murder Row', short: 'MURDER' },
  { name: 'Altar of Fangs', short: 'ALTAR' },
  { name: 'Voidscar Arena', short: 'ARENA' },
  { name: 'Den of Nalorakk', short: 'DEN' },
  { name: "King's Rest", short: 'KINGS' },
  { name: 'The Blinding Vale', short: 'VALE' },
];

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fmtScore(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
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

async function getCharacter(character) {
  const fieldsWithAll = [
    'mythic_plus_scores_by_season:current',
    'mythic_plus_best_runs:all',
    'mythic_plus_alternate_runs',
  ].join(',');

  const fieldsFallback = [
    'mythic_plus_scores_by_season:current',
    'mythic_plus_best_runs',
    'mythic_plus_alternate_runs',
  ].join(',');

  async function request(fields) {
    const url = new URL(`${RIO_BASE}/characters/profile`);
    url.searchParams.set('region', character.region);
    url.searchParams.set('realm', character.realm);
    url.searchParams.set('name', character.name);
    url.searchParams.set('fields', fields);
    return fetchJson(url);
  }

  try {
    return await request(fieldsWithAll);
  } catch (error) {
    if (error?.message !== 'HTTP_400' && error?.message !== 'HTTP_422') {
      throw error;
    }
    return request(fieldsFallback);
  }
}

function extractScore(data) {
  const seasons = data?.mythic_plus_scores_by_season;
  if (!Array.isArray(seasons) || !seasons.length) return null;

  const score = Number(seasons[0]?.scores?.all);
  return Number.isFinite(score) ? score : null;
}

function extractDungeonLevels(data) {
  const best = Array.isArray(data?.mythic_plus_best_runs)
    ? data.mythic_plus_best_runs
    : [];

  const alternate = Array.isArray(data?.mythic_plus_alternate_runs)
    ? data.mythic_plus_alternate_runs
    : [];

  const levels = new Map();

  for (const run of [...best, ...alternate]) {
    const dungeonName = getDungeonName(run);
    const level = Number(run?.mythic_level);

    if (!dungeonName || !Number.isFinite(level)) continue;

    const key = normalizeName(dungeonName);
    const current = levels.get(key);

    if (current === undefined || level > current) {
      levels.set(key, level);
    }
  }

  return DUNGEONS.map((dungeon) => ({
    ...dungeon,
    level: levels.get(normalizeName(dungeon.name)) ?? null,
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

  const id = String(req.query?.char || '').trim().toLowerCase();
  const character = CHARACTERS[id];

  if (!character) {
    return reply(res, 400, 'Personaje no valido.');
  }

  try {
    const data = await getCharacter(character);
    const score = extractScore(data);
    const keys = extractDungeonLevels(data);

    if (score === null) {
      return reply(res, 404, `No encuentro score actual para ${character.name}.`);
    }

    const keyText = keys
      .map(({ short, level }) => `${short} ${level ?? '—'}`)
      .join(' | ');

    return reply(
      res,
      200,
      `${character.name}: ${fmtScore(score)} RIO | ${keyText}`,
      true
    );
  } catch (error) {
    if (error?.message === 'RATE_LIMIT') {
      return reply(
        res,
        503,
        'Raider.IO esta limitando consultas. Prueba de nuevo en unos segundos.'
      );
    }

    console.error('[apo-specific]', error);
    return reply(
      res,
      500,
      'No he podido consultar Raider.IO ahora mismo. Prueba de nuevo en unos segundos.'
    );
  }
}
