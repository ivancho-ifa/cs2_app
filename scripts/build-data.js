// Build-time data precompute for serverless deploys (and faster local starts).
// Fetches the big upstream datasets once and reduces them to small files:
//   data/image-map.json         market_hash_name -> image URL
//   data/rarity-map.json        market_hash_name -> [rarity name, color]
//   data/reference-prices.json  market_hash_name -> { steam, buff }
// The server loads these from disk when present instead of fetching tens of
// megabytes at runtime, which serverless cold starts cannot afford.
// Partial failure is fine: whatever was fetched gets written, the server
// falls back to runtime fetching for anything missing.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data');

const IMAGE_DATASETS = [
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/sticker_slabs.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/graffiti.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/highlights.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/music_kits.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/patches.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/keychains.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/collectibles.json',
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/keys.json',
];
// CSGOTrader retired the combined prices_v6.json in favor of one file per market
const CSGOTRADER_STEAM_URL = 'https://prices.csgotrader.app/latest/steam.json';
const CSGOTRADER_BUFF_URL = 'https://prices.csgotrader.app/latest/buff163.json';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cs2-deal-finder-build/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Stitch the per-market files back into the { name: { steam, buff163 } }
// shape of the old combined dataset. One market failing still yields the other.
async function fetchCsgoTraderPrices() {
  const [steam, buff] = await Promise.allSettled([
    fetchJson(CSGOTRADER_STEAM_URL),
    fetchJson(CSGOTRADER_BUFF_URL),
  ]);
  if (steam.status === 'rejected' && buff.status === 'rejected') {
    throw new Error(`steam: ${steam.reason.message} || buff163: ${buff.reason.message}`);
  }
  if (steam.status === 'rejected') console.error(`  csgotrader steam FAILED: ${steam.reason.message}`);
  if (buff.status === 'rejected') console.error(`  csgotrader buff163 FAILED: ${buff.reason.message}`);
  const combined = {};
  for (const [market, settled] of [['steam', steam], ['buff163', buff]]) {
    if (settled.status !== 'fulfilled') continue;
    for (const [name, p] of Object.entries(settled.value)) {
      (combined[name] ||= {})[market] = p;
    }
  }
  return combined;
}

// The weapon tiers carry a redundant Grade suffix, sticker and agent tiers
// do not ("High Grade" is a real sticker tier, leave it alone)
const RARITY_RENAME = {
  'Consumer Grade': 'Consumer',
  'Industrial Grade': 'Industrial',
  'Mil-Spec Grade': 'Mil-Spec',
};

async function buildCatalogMaps() {
  const images = {};
  const rarities = {};
  let sources = 0;
  for (const url of IMAGE_DATASETS) {
    try {
      const data = await fetchJson(url);
      let added = 0;
      for (const o of Array.isArray(data) ? data : Object.values(data)) {
        if (!o || !o.market_hash_name) continue;
        if (o.image && !images[o.market_hash_name]) {
          images[o.market_hash_name] = o.image;
          added++;
        }
        if (o.rarity && o.rarity.name && !rarities[o.market_hash_name]) {
          rarities[o.market_hash_name] = [
            RARITY_RENAME[o.rarity.name] || o.rarity.name,
            o.rarity.color || null,
          ];
        }
      }
      sources++;
      console.log(`  ${url.split('/').pop()}: ${added} names`);
    } catch (err) {
      console.error(`  ${url.split('/').pop()} FAILED: ${err.message}`);
    }
  }
  if (sources === 0) return null;
  return { images, rarities };
}

async function buildReferencePrices() {
  try {
    const data = await fetchCsgoTraderPrices();
    const map = {};
    for (const [name, p] of Object.entries(data)) {
      if (!p || typeof p !== 'object') continue;
      const steamRaw = p.steam || {};
      const steam = Number(
        steamRaw.last_24h ?? steamRaw.last_7d ?? steamRaw.last_30d ?? steamRaw.last_90d
      );
      const buffRaw = (p.buff163 && p.buff163.starting_at) || {};
      const buff = Number(buffRaw.price ?? buffRaw);
      const entry = {};
      if (Number.isFinite(steam) && steam > 0) entry.steam = steam;
      if (Number.isFinite(buff) && buff > 0) entry.buff = buff;
      if (entry.steam || entry.buff) map[name] = entry;
    }
    console.log(`  reference prices: ${Object.keys(map).length} names`);
    return map;
  } catch (err) {
    console.error(`  csgotrader FAILED: ${err.message}`);
    return null;
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('building image and rarity maps...');
  const catalog = await buildCatalogMaps();
  if (catalog) {
    fs.writeFileSync(path.join(OUT_DIR, 'image-map.json'), JSON.stringify(catalog.images));
    console.log(`wrote data/image-map.json (${Object.keys(catalog.images).length} names)`);
    fs.writeFileSync(path.join(OUT_DIR, 'rarity-map.json'), JSON.stringify(catalog.rarities));
    console.log(`wrote data/rarity-map.json (${Object.keys(catalog.rarities).length} names)`);
  } else {
    console.error('catalog maps skipped, server will fetch at runtime');
  }

  console.log('building reference prices...');
  const refs = await buildReferencePrices();
  if (refs) {
    fs.writeFileSync(path.join(OUT_DIR, 'reference-prices.json'), JSON.stringify(refs));
    console.log(`wrote data/reference-prices.json (${Object.keys(refs).length} names)`);
  } else {
    console.error('reference prices skipped, server will fetch at runtime');
  }
})();
