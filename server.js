// CS2 Deal Finder server
// Proxies and merges live prices from DMarket, Skinport, and optionally
// CSFloat, enriched with CSGOTrader aggregated reference prices. Caches for
// 5 minutes. Node 18+ required (global fetch). MOCK_DATA=1 serves bundled
// fixtures instead of hitting the live APIs.

const express = require('express');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK_DATA === '1';
const ON_VERCEL = Boolean(process.env.VERCEL);
const CSFLOAT_API_KEY = process.env.CSFLOAT_API_KEY || null;
// No upstream may hang the whole response. Healthy APIs answer in a few
// seconds, so paged endpoints get short leashes and only the one big
// Skinport catalog download keeps a generous one.
const FETCH_TIMEOUT_MS = 25 * 1000;
const PAGE_TIMEOUT_MS = 8 * 1000;
const HISTORY_TIMEOUT_MS = 15 * 1000;

// Cap the merged list: phones cannot download or render the full ~20k item
// catalog. Cross-listed items always survive the cut, the rest is kept by
// best discount. Raise via env if you want more on desktop.
const MAX_ITEMS = Number(process.env.MAX_ITEMS) > 0 ? Number(process.env.MAX_ITEMS) : 800;

const CACHE_TTL_MS = 5 * 60 * 1000; // Skinport allows few requests per 5 min per IP. Never lower this.
const HISTORY_TTL_MS = 30 * 60 * 1000; // sales volume moves slowly, refresh sparingly
const IMAGES_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000; // csgotrader updates a few times a day
let cache = { at: 0, payload: null };
let historyCache = { at: 0, volumes: null };
let imageMap = { at: 0, map: null, loading: null };
let referenceMap = { at: 0, map: null, loading: null };

const DMARKET_PAGES = 3;
const DMARKET_PAGE_SIZE = 100;
// DMarket retired /exchange/v1/market/items (HTTP 410). Their swagger now
// documents /offers/v1/search on the dmarket.com host, with the older
// /offers-search/v1/search still answering as a deprecated alias. Try the
// current one first and fall through, keeping the retired one last in case
// a mirror still serves it.
const DMARKET_ENDPOINTS = [
  {
    name: 'offers/v1/search',
    url: (page) =>
      `https://dmarket.com/offers/v1/search?gameId=a8db&currency=USD&limit=${DMARKET_PAGE_SIZE}&offset=${page * DMARKET_PAGE_SIZE}&orderBy=updated&orderDir=desc`,
  },
  {
    name: 'offers-search/v1/search',
    url: (page) =>
      `https://dmarket.com/offers-search/v1/search?gameId=a8db&currency=USD&limit=${DMARKET_PAGE_SIZE}&offset=${page * DMARKET_PAGE_SIZE}&orderBy=updated&orderDir=desc`,
  },
  {
    name: 'exchange/v1/market/items',
    url: (page, cursor) =>
      `https://api.dmarket.com/exchange/v1/market/items?gameId=a8db&currency=USD&limit=${DMARKET_PAGE_SIZE}&orderBy=best_discount&orderDir=desc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    cursorPaged: true,
  },
];
const SKINPORT_ITEMS_URL = 'https://api.skinport.com/v1/items?app_id=730&currency=USD';
const SKINPORT_HISTORY_URL = 'https://api.skinport.com/v1/sales/history?app_id=730&currency=USD';
const MARKETCSGO_PRICES_URL = 'https://market.csgo.com/api/v2/prices/USD.json';
const WAXPEER_PRICES_URL = 'https://api.waxpeer.com/v1/prices?game=csgo&minified=1';
const WHITEMARKET_PRICES_URL = 'https://api.white.market/export/v1/prices/730.json';
const LISSKINS_PRICES_URL = 'https://lis-skins.com/market_export_json/csgo.json';
const CSFLOAT_PAGES = 3;
const CSFLOAT_URL = (page, sortBy) =>
  `https://csfloat.com/api/v1/listings?page=${page}&limit=50&sort_by=${sortBy}`;
// Aggregated cross-market prices, no key needed. CSGOTrader retired the
// combined prices_v6.json in favor of one file per market.
const CSGOTRADER_STEAM_URL = 'https://prices.csgotrader.app/latest/steam.json';
const CSGOTRADER_BUFF_URL = 'https://prices.csgotrader.app/latest/buff163.json';

// market_hash_name to Steam CDN image mapping, so items without a marketplace
// image still get pictures. Handoff improvement #2.
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

const STEAM_LISTING = (name) =>
  `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`;
const BUFF_SEARCH = (name) =>
  `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${encodeURIComponent(name)}`;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'cs2-deal-finder/1.0', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`timeout after ${timeoutMs / 1000}s from ${new URL(url).host}`);
    }
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    // Surface the body: API error responses often carry migration instructions
    const snippet = buf.toString('utf8').slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}${snippet ? ` | body: ${snippet}` : ''}`);
  }
  // Node's fetch auto-decompresses encodings it knows. Older Node 18 builds do
  // not decode Brotli, so if plain parsing fails try a manual Brotli pass.
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return JSON.parse(zlib.brotliDecompressSync(buf).toString('utf8'));
  }
}

// Money values arrive in several shapes across APIs and API generations:
// {"USD":"1234"} cents, {"amount":1234} cents, "1234" cents, "12.34" dollars,
// or plain numbers. Returns dollars or null.
function parseMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    return parseMoney(value.USD ?? value.usd ?? value.amount ?? value.Amount);
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return value.includes('.') ? n : n / 100;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Number.isInteger(value) ? value / 100 : value;
  }
  return null;
}

function centsToUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

function dmarketLink(title) {
  return `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${encodeURIComponent(title)}`;
}

// ---------------------------------------------------------------------------
// Source fetchers
// ---------------------------------------------------------------------------

// Normalize one raw DMarket object regardless of which endpoint produced it
function normalizeDMarketObject(o) {
  const title = o.title || o.marketHashName || o.name;
  const price = parseMoney(o.price ?? o.cheapestOfferPrice ?? o.minPrice);
  if (!title || price === null) return null;
  return {
    name: title,
    price,
    suggested: parseMoney(o.suggestedPrice ?? o.recommendedPrice),
    image: o.image || o.imageUrl || null,
    float:
      o.extra && Number.isFinite(Number(o.extra.floatValue)) ? Number(o.extra.floatValue) : null,
    listingsCount: Number.isFinite(Number(o.totalSellOffers)) ? Number(o.totalSellOffers) : null,
    url: dmarketLink(title),
  };
}

function extractDMarketObjects(data) {
  return Array.isArray(data.objects) ? data.objects : Array.isArray(data.items) ? data.items : [];
}

// Offset-paged endpoints can fetch all pages at once
async function fetchDMarketPagesParallel(ep) {
  const results = await Promise.allSettled(
    Array.from({ length: DMARKET_PAGES }, (_, p) => fetchJson(ep.url(p), {}, PAGE_TIMEOUT_MS))
  );
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length === results.length) throw failures[0].reason;
  return results.flatMap((r) => (r.status === 'fulfilled' ? extractDMarketObjects(r.value) : []));
}

// Cursor pagination is inherently sequential
async function fetchDMarketPagesCursor(ep) {
  const objects = [];
  let cursor = null;
  for (let page = 0; page < DMARKET_PAGES; page++) {
    const data = await fetchJson(ep.url(page, cursor), {}, PAGE_TIMEOUT_MS);
    const batch = extractDMarketObjects(data);
    objects.push(...batch);
    cursor = data.cursor ?? (data.paging && data.paging.cursor) ?? null;
    if (!cursor || batch.length < DMARKET_PAGE_SIZE) break;
  }
  return objects;
}

// Remember which endpoint answered last so refreshes skip the dead ones
// instead of burning a timeout on each, every 5 minutes
let dmarketPreferred = 0;

async function fetchDMarket() {
  const errors = [];
  for (let i = 0; i < DMARKET_ENDPOINTS.length; i++) {
    const idx = (dmarketPreferred + i) % DMARKET_ENDPOINTS.length;
    const ep = DMARKET_ENDPOINTS[idx];
    try {
      const objects = ep.cursorPaged
        ? await fetchDMarketPagesCursor(ep)
        : await fetchDMarketPagesParallel(ep);
      if (objects.length) {
        console.log(`DMarket via ${ep.name}, sample object: ${JSON.stringify(objects[0]).slice(0, 400)}`);
      }
      const items = objects.map(normalizeDMarketObject).filter(Boolean);
      if (items.length > 0) {
        dmarketPreferred = idx;
        return items;
      }
      errors.push(`${ep.name}: 0 items`);
    } catch (err) {
      errors.push(`${ep.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' || '));
}

async function fetchSkinport() {
  // Skinport requires Brotli accept-encoding and rate limits aggressively.
  // The caches above keep us at roughly 1 items request and at most 1 history
  // request per 5 minute window.
  const data = await fetchJson(SKINPORT_ITEMS_URL, { 'Accept-Encoding': 'br' });
  if (!Array.isArray(data)) throw new Error('Skinport response is not an array');
  const items = [];
  for (const o of data) {
    const name = o.market_hash_name;
    const price = Number(o.min_price);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    const suggested = Number(o.suggested_price);
    items.push({
      name,
      price,
      suggested: Number.isFinite(suggested) && suggested > 0 ? suggested : null,
      image: null,
      float: null,
      listingsCount: Number.isFinite(Number(o.quantity)) ? Number(o.quantity) : null,
      url:
        o.item_page ||
        o.market_page ||
        `https://skinport.com/market?search=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

async function fetchMarketCsgo() {
  const data = await fetchJson(MARKETCSGO_PRICES_URL);
  if (!data.success || !Array.isArray(data.items)) throw new Error('Market.CSGO response has no items');
  const items = [];
  for (const o of data.items) {
    const name = o.market_hash_name;
    const price = Number(o.price);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    items.push({
      name,
      price,
      suggested: null,
      image: null,
      float: null,
      listingsCount: null,
      url: `https://market.csgo.com/en/?search=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

// Waxpeer: lowest ask per name, min is in thousandths of a USD
async function fetchWaxpeer() {
  const data = await fetchJson(WAXPEER_PRICES_URL);
  if (!data.success || !Array.isArray(data.items)) throw new Error('Waxpeer response has no items');
  const items = [];
  for (const o of data.items) {
    const name = o.name;
    const price = Number(o.min) / 1000;
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    items.push({
      name,
      price,
      suggested: null,
      image: null,
      float: null,
      listingsCount: Number.isFinite(Number(o.count)) ? Number(o.count) : null,
      url: `https://waxpeer.com/?search=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

// White.market: lowest ask per name as a USD string, with the float of that
// cheapest listing. The API host redirects to a static export file.
async function fetchWhiteMarket() {
  const data = await fetchJson(WHITEMARKET_PRICES_URL);
  if (!Array.isArray(data)) throw new Error('White.market response is not an array');
  const items = [];
  for (const o of data) {
    const name = o.market_hash_name;
    const price = Number(o.price);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    const float = o.cheapest_float === null || o.cheapest_float === undefined ? NaN : Number(o.cheapest_float);
    items.push({
      name,
      price,
      suggested: null,
      image: null,
      float: Number.isFinite(float) ? float : null,
      listingsCount: Number.isFinite(Number(o.market_product_count)) ? Number(o.market_product_count) : null,
      url: o.market_product_link || `https://white.market/market?search=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

// Lis-Skins: lowest ask per name in USD with a direct item page link
async function fetchLisSkins() {
  const data = await fetchJson(LISSKINS_PRICES_URL);
  if (!Array.isArray(data)) throw new Error('Lis-Skins response is not an array');
  const items = [];
  for (const o of data) {
    const name = o.name;
    const price = Number(o.price);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    items.push({
      name,
      price,
      suggested: null,
      image: null,
      float: null,
      listingsCount: Number.isFinite(Number(o.count)) ? Number(o.count) : null,
      url: o.url || `https://lis-skins.com/market/csgo/?query=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

// CSFloat is optional: set CSFLOAT_API_KEY to enable it as a third source.
// Prices are cents. The response has been a bare array historically and a
// {data: [...]} wrapper in newer versions, so accept both. sort_by=best_deal
// mirrors the best-discount intent, with lowest_price as a fallback.
function normalizeCSFloatListing(l) {
  const item = l.item || {};
  const name = item.market_hash_name || l.market_hash_name;
  const price = centsToUsd(l.price);
  if (!name || price === null) return null;
  const suggested = centsToUsd(l.reference && (l.reference.predicted_price ?? l.reference.base_price));
  const float = Number(item.float_value ?? l.float_value);
  return {
    name,
    price,
    suggested,
    image: item.icon_url
      ? `https://community.fastly.steamstatic.com/economy/image/${item.icon_url}`
      : null,
    float: Number.isFinite(float) ? float : null,
    listingsCount: null,
    url: l.id ? `https://csfloat.com/item/${l.id}` : `https://csfloat.com/search?market_hash_name=${encodeURIComponent(name)}`,
  };
}

async function fetchCSFloat() {
  const headers = { Authorization: CSFLOAT_API_KEY };
  const errors = [];
  for (const sortBy of ['best_deal', 'lowest_price']) {
    try {
      const items = [];
      let sampleLogged = false;
      for (let page = 0; page < CSFLOAT_PAGES; page++) {
        const data = await fetchJson(CSFLOAT_URL(page, sortBy), headers, PAGE_TIMEOUT_MS);
        const listings = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
        if (listings.length && !sampleLogged) {
          sampleLogged = true;
          console.log(`CSFloat via sort_by=${sortBy}, sample: ${JSON.stringify(listings[0]).slice(0, 400)}`);
        }
        for (const l of listings) {
          const it = normalizeCSFloatListing(l);
          if (it) items.push(it);
        }
        if (listings.length < 50) break;
      }
      if (items.length > 0) return items;
      errors.push(`sort_by=${sortBy}: 0 items`);
    } catch (err) {
      errors.push(`sort_by=${sortBy}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' || '));
}

// ---------------------------------------------------------------------------
// Enrichment: sales volumes, reference prices, images
// ---------------------------------------------------------------------------

// Skinport 7-day sales volume per item name, cached for 30 minutes.
// Soft-fails so a hiccup here never blocks the deal list.
async function getSalesVolumes() {
  const now = Date.now();
  if (historyCache.volumes && now - historyCache.at < HISTORY_TTL_MS) return historyCache.volumes;
  try {
    const data = MOCK
      ? readFixture('skinport_history.json')
      : await fetchJson(SKINPORT_HISTORY_URL, { 'Accept-Encoding': 'br' }, HISTORY_TIMEOUT_MS);
    const volumes = new Map();
    for (const o of data) {
      if (!o.market_hash_name) continue;
      const v7 = o.last_7_days && Number(o.last_7_days.volume);
      const v24 = o.last_24_hours && Number(o.last_24_hours.volume);
      volumes.set(o.market_hash_name, {
        volume7d: Number.isFinite(v7) ? v7 : null,
        volume24h: Number.isFinite(v24) ? v24 : null,
      });
    }
    historyCache = { at: now, volumes };
    return volumes;
  } catch (err) {
    console.error('Skinport sales history failed:', err.message);
    return historyCache.volumes || new Map();
  }
}

// CSGOTrader aggregated prices: one fetch covers Steam and Buff163 reference
// prices for the whole catalog, refreshed every 6 hours. This deliberately
// replaces per-item Steam priceoverview calls, which get IPs banned fast.
// Build-time snapshots (scripts/build-data.js) load from disk instantly.
// Serverless cold starts rely on these, and they speed local startup too.
function readPrebuilt(file) {
  // Bundlers relocate files, so probe the plausible roots
  const candidates = [
    path.join(__dirname, 'data', file),
    path.join(process.cwd(), 'data', file),
    path.join(__dirname, '..', 'data', file),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      const map = new Map(Object.entries(obj));
      if (map.size) return map;
    } catch {}
  }
  return null;
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
  if (steam.status === 'rejected') console.error('CSGOTrader steam prices failed:', steam.reason.message);
  if (buff.status === 'rejected') console.error('CSGOTrader buff163 prices failed:', buff.reason.message);
  const combined = {};
  for (const [market, settled] of [['steam', steam], ['buff163', buff]]) {
    if (settled.status !== 'fulfilled') continue;
    for (const [name, p] of Object.entries(settled.value)) {
      (combined[name] ||= {})[market] = p;
    }
  }
  return combined;
}

async function getReferencePrices() {
  const now = Date.now();
  if (referenceMap.map && now - referenceMap.at < REFERENCE_TTL_MS) return referenceMap.map;
  if (referenceMap.loading) return referenceMap.loading;
  if (!MOCK && !referenceMap.map) {
    const prebuilt = readPrebuilt('reference-prices.json');
    if (prebuilt) {
      // Treat the snapshot as always fresh: it refreshes on each deploy and
      // reference prices only move a few times a day anyway
      referenceMap = { at: Infinity, map: prebuilt, loading: null };
      console.log(`reference prices loaded from snapshot, ${prebuilt.size} names`);
      return prebuilt;
    }
    if (ON_VERCEL) {
      // Never pull the ~50 MB dataset inside a serverless request. No
      // snapshot means the build step needs fixing, check /api/health
      console.error('no reference-prices snapshot on Vercel, references disabled until a deploy builds one');
      referenceMap = { at: Infinity, map: new Map(), loading: null };
      return referenceMap.map;
    }
  }
  const loading = (async () => {
    const map = new Map();
    try {
      const data = MOCK ? readFixture('csgotrader.json') : await fetchCsgoTraderPrices();
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
        if (entry.steam || entry.buff) map.set(name, entry);
      }
      if (map.size) console.log(`reference prices loaded, ${map.size} names`);
    } catch (err) {
      console.error('CSGOTrader reference prices failed:', err.message);
    }
    referenceMap = { at: Date.now(), map, loading: null };
    return map;
  })();
  referenceMap.loading = loading;
  return loading;
}

// market_hash_name to image URL and rarity maps, loaded lazily, refreshed
// daily. Soft-fails to empty maps, cards then show the NO PREVIEW
// placeholder and carry no rarity tag.
const RARITY_RENAME = {
  'Consumer Grade': 'Consumer',
  'Industrial Grade': 'Industrial',
  'Mil-Spec Grade': 'Mil-Spec',
};

function emptyCatalog() {
  return { images: new Map(), rarities: new Map() };
}

async function getCatalog() {
  const now = Date.now();
  if (imageMap.map && now - imageMap.at < IMAGES_TTL_MS) return imageMap.map;
  if (imageMap.loading) return imageMap.loading;
  if (!imageMap.map) {
    if (MOCK) {
      const rarities = new Map(Object.entries(readFixture('rarity.json')));
      imageMap = { at: Infinity, map: { images: new Map(), rarities }, loading: null };
      return imageMap.map;
    }
    const images = readPrebuilt('image-map.json');
    if (images) {
      const rarities = readPrebuilt('rarity-map.json') || new Map();
      imageMap = { at: Infinity, map: { images, rarities }, loading: null };
      console.log(`catalog loaded from snapshot, ${images.size} images, ${rarities.size} rarities`);
      return imageMap.map;
    }
    if (ON_VERCEL) {
      // Never pull ~100 MB of datasets inside a serverless request. No
      // snapshot means the build step needs fixing, check /api/health
      console.error('no catalog snapshot on Vercel, images and rarities disabled until a deploy builds one');
      imageMap = { at: Infinity, map: emptyCatalog(), loading: null };
      return imageMap.map;
    }
  }
  const loading = (async () => {
    const map = emptyCatalog();
    for (const url of IMAGE_DATASETS) {
      try {
        const data = await fetchJson(url);
        for (const o of Array.isArray(data) ? data : Object.values(data)) {
          if (!o || !o.market_hash_name) continue;
          if (o.image && !map.images.has(o.market_hash_name)) {
            map.images.set(o.market_hash_name, o.image);
          }
          if (o.rarity && o.rarity.name && !map.rarities.has(o.market_hash_name)) {
            map.rarities.set(o.market_hash_name, [
              RARITY_RENAME[o.rarity.name] || o.rarity.name,
              o.rarity.color || null,
            ]);
          }
        }
      } catch (err) {
        console.error(`catalog dataset failed (${url.split('/').pop()}):`, err.message);
      }
    }
    if (map.images.size) console.log(`catalog loaded, ${map.images.size} images, ${map.rarities.size} rarities`);
    imageMap = { at: Date.now(), map, loading: null };
    return map;
  })();
  imageMap.loading = loading;
  return loading;
}

// ---------------------------------------------------------------------------
// Mock mode: same merge pipeline, data comes from bundled fixtures that match
// the documented response shapes of the APIs.
// ---------------------------------------------------------------------------

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', file), 'utf8'));
}

async function fetchDMarketMock() {
  const data = readFixture('dmarket.json');
  return data.objects.map(normalizeDMarketObject).filter(Boolean);
}

async function fetchSkinportMock() {
  const data = readFixture('skinport.json');
  return data
    .filter((o) => o.min_price !== null)
    .map((o) => ({
      name: o.market_hash_name,
      price: Number(o.min_price),
      suggested: o.suggested_price ? Number(o.suggested_price) : null,
      image: null,
      float: null,
      listingsCount: o.quantity ?? null,
      url: o.item_page || `https://skinport.com/market?search=${encodeURIComponent(o.market_hash_name)}`,
    }));
}

async function fetchCSFloatMock() {
  const data = readFixture('csfloat.json');
  return data.map(normalizeCSFloatListing).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Merge: exact name match across sources, cheapest source wins, discount is
// computed against the best reference price available.
// ---------------------------------------------------------------------------

// Item type from the market hash name. Souvenir skins carry a "Souvenir "
// prefix (souvenir packages do not, they end with "Souvenir Package" and
// classify as normal). Knives and gloves carry the star.
function classifyType(name) {
  if (name.startsWith('Souvenir ')) return 'souvenir';
  if (name.startsWith('★')) return 'special';
  if (name.includes('StatTrak™')) return 'stattrak';
  return 'normal';
}

// 0 to 5 popularity from 7-day sales volume, with total listing count as a
// weaker fallback signal when volume data is missing for an item
function popularityFor(volume7d, listings) {
  if (volume7d !== null && volume7d !== undefined) {
    const score =
      volume7d >= 500 ? 5 : volume7d >= 150 ? 4 : volume7d >= 40 ? 3 : volume7d >= 10 ? 2 : volume7d > 0 ? 1 : 0;
    return { score, basis: 'sales', volume7d };
  }
  if (listings !== null && listings > 0) {
    const score = listings >= 500 ? 4 : listings >= 100 ? 3 : listings >= 25 ? 2 : 1;
    return { score, basis: 'listings', listings };
  }
  return { score: 0, basis: 'none' };
}

function mergeSources(sourceItems, volumes, catalog, references) {
  const byName = new Map();

  const add = (source, item) => {
    let entry = byName.get(item.name);
    if (!entry) {
      entry = { name: item.name, image: null, float: null, listings: 0, sources: {} };
      byName.set(item.name, entry);
    }
    // Keep the cheapest listing per source if a name repeats within one source
    const existing = entry.sources[source];
    if (!existing || item.price < existing.price) {
      entry.sources[source] = { price: item.price, url: item.url, suggested: item.suggested };
    }
    if (item.image && !entry.image) entry.image = item.image;
    if (item.float !== null && entry.float === null) entry.float = item.float;
    if (item.listingsCount) entry.listings += item.listingsCount;
  };

  for (const [source, items] of Object.entries(sourceItems)) {
    for (const it of items) add(source, it);
  }

  const items = [];
  for (const entry of byName.values()) {
    const listings = Object.entries(entry.sources).map(([source, s]) => ({ source, ...s }));
    listings.sort((a, b) => a.price - b.price);
    const best = listings[0];
    const highestListed = listings[listings.length - 1].price;

    const ref = references.get(entry.name) || {};
    // Discount is the saving versus buying on Steam. Steam's reference is a
    // sales average, which a single absurd ask cannot skew the way lowest-ask
    // references (Buff163, marketplace suggestions) can. Without a Steam
    // price, fall back to the highest price the item is listed at anywhere.
    const reference = ref.steam ?? highestListed;
    const discount = reference > 0 ? Math.max(0, ((reference - best.price) / reference) * 100) : 0;

    const spread =
      listings.length > 1 ? listings[listings.length - 1].price - listings[0].price : 0;

    const vol = volumes.get(entry.name);
    const popularity = popularityFor(vol ? vol.volume7d : null, entry.listings || null);
    const rarity = catalog.rarities.get(entry.name) || null;

    const refs = [];
    if (ref.steam) refs.push({ label: 'Steam', price: ref.steam, url: STEAM_LISTING(entry.name) });
    if (ref.buff) refs.push({ label: 'Buff163', price: ref.buff, url: BUFF_SEARCH(entry.name) });

    items.push({
      name: entry.name,
      type: classifyType(entry.name),
      image: entry.image || catalog.images.get(entry.name) || null,
      rarity: rarity ? rarity[0] : null,
      rarityColor: rarity ? rarity[1] : null,
      float: entry.float,
      bestPrice: best.price,
      bestSource: best.source,
      bestUrl: best.url,
      suggestedPrice: reference,
      discountBasis: ref.steam ? 'steam' : 'listed',
      discount: Math.round(discount * 10) / 10,
      spread: Math.round(spread * 100) / 100,
      crossListed: listings.length > 1,
      popularity,
      refs,
      listings: listings.map((l) => ({ source: l.source, price: l.price, url: l.url })),
    });
  }

  items.sort((a, b) => b.discount - a.discount);
  return items;
}

// Cap a (possibly filtered) list for the response: keep every cross-listed
// item (the whole point of the app), fill the remainder with the best
// single-source discounts
function capItems(items) {
  if (items.length <= MAX_ITEMS) return items;
  const kept = items.filter((it) => it.crossListed);
  for (const it of items) {
    if (kept.length >= Math.max(MAX_ITEMS, kept.length)) break;
    if (!it.crossListed) kept.push(it);
  }
  kept.sort((a, b) => b.discount - a.discount);
  return kept;
}

// Shape the cached full payload for one response: optional rarity filter
// runs over the FULL merged list before capping, so a filtered view is as
// deep as an unfiltered one
function shapePayload(base, rarity, type, extra) {
  let items = base.items;
  if (rarity) items = items.filter((it) => it.rarity === rarity);
  if (type) items = items.filter((it) => it.type === type);
  return {
    ...base,
    ...extra,
    rarityFilter: rarity || null,
    typeFilter: type || null,
    totalBeforeCap: items.length,
    items: capItems(items),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const CSFLOAT_ENABLED = MOCK || Boolean(CSFLOAT_API_KEY);
const DMARKET_ENABLED = MOCK;

// Every price source, in response order. Disabled sources are reported but
// never fetched. Mock mode swaps fetchers for fixture readers.
const SOURCES = {
  dmarket: { label: 'DMarket', enabled: DMARKET_ENABLED, fetch: () => (MOCK ? fetchDMarketMock() : fetchDMarket()) },
  skinport: { label: 'Skinport', enabled: true, fetch: () => (MOCK ? fetchSkinportMock() : fetchSkinport()) },
  csfloat: { label: 'CSFloat', enabled: CSFLOAT_ENABLED, fetch: () => (MOCK ? fetchCSFloatMock() : fetchCSFloat()) },
  marketcsgo: { label: 'Market.CSGO', enabled: !MOCK, fetch: fetchMarketCsgo },
  waxpeer: { label: 'Waxpeer', enabled: !MOCK, fetch: fetchWaxpeer },
  whitemarket: { label: 'White.market', enabled: !MOCK, fetch: fetchWhiteMarket },
  lisskins: { label: 'Lis-Skins', enabled: !MOCK, fetch: fetchLisSkins },
};

// Non-blocking peeks: kick the load off and use whatever is available right
// now. Snapshot loads complete synchronously, live downloads fill in for a
// later refresh. Deal responses must never wait on enrichment data.
function peekCatalog() {
  getCatalog().catch(() => {});
  return imageMap.map || emptyCatalog();
}
function peekReferences() {
  getReferencePrices().catch(() => {});
  return referenceMap.map || new Map();
}

async function buildPayload() {
  const keys = Object.keys(SOURCES);
  const [volumes, ...settled] = await Promise.allSettled([
    getSalesVolumes(),
    ...keys.map((k) => (SOURCES[k].enabled ? SOURCES[k].fetch() : Promise.resolve([]))),
  ]);

  const sourceItems = {};
  const sources = {};
  keys.forEach((k, i) => {
    const s = settled[i];
    const { enabled, label } = SOURCES[k];
    if (s.status === 'rejected') console.error(`${label} failed:`, s.reason.message);
    sourceItems[k] = s.status === 'fulfilled' ? s.value : [];
    sources[k] = {
      label,
      enabled,
      ok: enabled && s.status === 'fulfilled',
      count: sourceItems[k].length,
      error: enabled && s.status === 'rejected' ? s.reason.message : null,
    };
  });
  const vols = volumes.status === 'fulfilled' ? volumes.value : new Map();
  // Mock stays deterministic for the smoke test, live never blocks on these
  const cat = MOCK ? await getCatalog() : peekCatalog();
  const refs = MOCK ? await getReferencePrices() : peekReferences();

  const merged = mergeSources(sourceItems, vols, cat, refs);
  const rarityCounts = {};
  const typeCounts = {};
  for (const it of merged) {
    if (it.rarity) rarityCounts[it.rarity] = (rarityCounts[it.rarity] || 0) + 1;
    typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
  }

  return {
    mock: MOCK,
    fetchedAt: new Date().toISOString(),
    sources,
    referenceCount: refs.size,
    itemCap: MAX_ITEMS,
    rarityCounts,
    typeCounts,
    items: merged, // full list, capped per response in shapePayload
  };
}

// Deployment diagnostics: shows whether the build-time snapshots made it
// into the running function and which sources are enabled
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    node: process.version,
    onVercel: ON_VERCEL,
    mock: MOCK,
    csfloatEnabled: CSFLOAT_ENABLED,
    snapshots: {
      imageMap: readPrebuilt('image-map.json') ? true : false,
      rarityMap: readPrebuilt('rarity-map.json') ? true : false,
      referencePrices: readPrebuilt('reference-prices.json') ? true : false,
    },
    loaded: {
      images: imageMap.map ? imageMap.map.images.size : 0,
      rarities: imageMap.map ? imageMap.map.rarities.size : 0,
      references: referenceMap.map ? referenceMap.map.size : 0,
      volumes: historyCache.volumes ? historyCache.volumes.size : 0,
    },
    dealCacheAgeSeconds: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null,
  });
});

// One background refresh at a time, shared by all waiting requests
let refreshing = null;
function refreshCache() {
  if (!refreshing) {
    refreshing = buildPayload()
      .then((payload) => {
        // Only refresh the cache clock when at least one source answered, so
        // a total outage retries on the next request instead of caching emptiness
        if (Object.values(payload.sources).some((s) => s.ok)) {
          cache = { at: Date.now(), payload };
        }
        return payload;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

app.get('/api/deals', async (req, res) => {
  // On Vercel the CDN caches for 5 minutes across stateless invocations
  // (keyed per query string, so each rarity filter caches separately). The
  // directives go in Vercel-CDN-Cache-Control, which only Vercel reads:
  // browsers also honor stale-while-revalidate, and served directly they kept
  // showing a previous payload for up to 10 minutes after a restart.
  res.set('Vercel-CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.set('Cache-Control', 'no-cache');
  const rarity =
    typeof req.query.rarity === 'string' && req.query.rarity.length <= 40 ? req.query.rarity : '';
  const TYPES = ['souvenir', 'stattrak', 'special', 'normal'];
  const type = TYPES.indexOf(req.query.type) !== -1 ? req.query.type : '';
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return res.json(shapePayload(cache.payload, rarity, type, { cached: true }));
  }
  // Expired but present: answer instantly with stale data and refresh in the
  // background. Nobody waits on a refetch except the very first request.
  if (cache.payload) {
    refreshCache().catch((err) => console.error('background refresh failed:', err));
    return res.json(shapePayload(cache.payload, rarity, type, { cached: true, stale: true }));
  }
  try {
    const payload = await refreshCache();
    res.json(shapePayload(payload, rarity, type, { cached: false }));
  } catch (err) {
    console.error('deal build failed:', err);
    res.status(502).json({ error: 'All marketplace sources are unavailable right now' });
  }
});

// Quote a CSV field when needed. Text starting with = + - @ is prefixed with
// an apostrophe so spreadsheets never evaluate marketplace data as a formula.
function csvField(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(payload) {
  const sources = Object.keys(payload.sources).filter((k) => payload.sources[k].enabled);
  const header = [
    'market_hash_name',
    'type',
    'rarity',
    ...sources.map((s) => `${s}_price`),
    'steam_ref',
    'buff163_ref',
    'cheapest_source',
    'cheapest_price',
    'spread',
    'spread_pct',
    'discount_pct',
    'cross_listed',
    'cheapest_url',
  ];
  const lines = [header.join(',')];
  for (const it of payload.items) {
    const price = Object.fromEntries(it.listings.map((l) => [l.source, l.price]));
    const ref = Object.fromEntries(it.refs.map((r) => [r.label, r.price]));
    const spreadPct = it.crossListed ? Math.round((it.spread / it.bestPrice) * 1000) / 10 : null;
    const row = [
      it.name,
      it.type,
      it.rarity,
      ...sources.map((s) => price[s]),
      ref.Steam,
      ref.Buff163,
      it.bestSource,
      it.bestPrice,
      it.crossListed ? it.spread : null,
      spreadPct,
      it.discount,
      it.crossListed,
      it.bestUrl,
    ];
    lines.push(row.map(csvField).join(','));
  }
  // BOM so Excel reads the file as UTF-8 and keeps the ★ and ™ in item names
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Full merged list as CSV, uncapped, from the same cache as /api/deals
app.get('/api/export.csv', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let payload = cache.payload;
  try {
    if (!payload) payload = await refreshCache();
    else if (Date.now() - cache.at >= CACHE_TTL_MS) {
      refreshCache().catch((err) => console.error('background refresh failed:', err));
    }
  } catch (err) {
    console.error('export build failed:', err);
    return res.status(502).type('text/plain').send('All marketplace sources are unavailable right now');
  }
  const date = payload.fetchedAt.slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="cs2-prices-${date}.csv"`);
  res.send(toCsv(payload));
});

app.use(express.static(path.join(__dirname, 'public')));

// Local: run the server directly. Vercel: api/index.js imports the app and
// each request is handled by a serverless invocation instead of listen()
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`CS2 Deal Finder running at http://localhost:${PORT}${MOCK ? ' (mock data mode)' : ''}`);
    if (!CSFLOAT_ENABLED) console.log('CSFloat disabled, set CSFLOAT_API_KEY to enable it as a third source');
    if (!MOCK) {
      // Start warming the image, rarity and reference maps right away. A deals
      // payload built before they land lacks images, rarities and references
      // for the whole cache TTL, so rebuild it as soon as they arrive.
      Promise.allSettled([getCatalog(), getReferencePrices()])
        .then(() => refreshing) // an in-flight build may predate the maps, let it finish first
        .catch(() => {})
        .then(() => cache.payload && refreshCache())
        .catch((err) => console.error('enrichment refresh failed:', err));
    }
  });
}

module.exports = app;
