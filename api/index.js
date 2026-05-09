"use strict";

/**
 * AlooYTV Stremio Addon — Enhanced for Forward & Stremio
 * Ported to high-performance Serverless architecture (No Express)
 * Created by Abdulluh.X
 */

const https = require("https");
const http = require("http");
const zlib = require("zlib");

// ============================================================
// CONFIG
// ============================================================

const BASE_URL = "https://bp.alooytv13.xyz";
const IMAGE_BASE = "https://bp.alooytv13.xyz";
const DEFAULT_THUMB = `${IMAGE_BASE}/uploads/default_image/blank_thumbnail.jpg`;
const ADDON_NAME = "AlooYTV";
const ADDON_ID = "community.alooytv.abdulluhx.enhanced.v1";
const ADDON_LOGO = "https://bp.alooytv13.xyz/favicon.ico";

const CACHE_TTL_MS = 1000 * 60 * 10; // كاش الصفحات 10 دقائق لتسريع الاستجابة وتفادي الحجب

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ar,en-US;q=0.8,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": BASE_URL
};

// ============================================================
// MANIFEST
// ============================================================

const CATALOGS = [
  { id: "latest",              name: "أحدث الحلقات",        type: "series", url: `${BASE_URL}/tv-series.html` },
  { id: "ramadan-arabi-2026",  name: "رمضان عربي 2026 ★",   type: "series", url: `${BASE_URL}/genre/ramadan-arabi-2026.html` },
  { id: "ramadan-kleeji-2026", name: "رمضان خليجي 2026 ★",  type: "series", url: `${BASE_URL}/genre/ramadan-kleeji-2026.html` },
  { id: "turki",               name: "مسلسلات تركية",       type: "series", url: `${BASE_URL}/genre/turki.html` },
  { id: "arabic",              name: "مسلسلات عربية",       type: "series", url: `${BASE_URL}/genre/arabic.html` },
  { id: "kleeji",              name: "مسلسلات خليجية",      type: "series", url: `${BASE_URL}/genre/kleeji.html` },
  { id: "farisi",              name: "مسلسلات فارسية",      type: "series", url: `${BASE_URL}/genre/farisi.html` },
  { id: "ramadan-arabi-2025",  name: "رمضان عربي 2025",     type: "series", url: `${BASE_URL}/genre/ramadan-arabi-2025.html` },
  { id: "ramadan-kleeji-2025", name: "رمضان خليجي 2025",    type: "series", url: `${BASE_URL}/genre/ramadan-kleeji-2025.html` },
  { id: "Korean-movies",       name: "أفلام كورية",         type: "movie",  url: `${BASE_URL}/genre/Korean-movies.html` },
  { id: "foreign-movies",      name: "أفلام أجنبية",        type: "movie",  url: `${BASE_URL}/genre/foreign-movies.html` },
  { id: "anmi",                name: "أنمي",                type: "series", url: `${BASE_URL}/genre/anmi.html` },
  { id: "Foreign-series",      name: "مسلسلات أجنبية",      type: "series", url: `${BASE_URL}/genre/Foreign-series.html` },
  { id: "Korean-series",       name: "مسلسلات كورية",       type: "series", url: `${BASE_URL}/genre/Korean-series.html` },
  { id: "asia-series",         name: "مسلسلات آسيوية",      type: "series", url: `${BASE_URL}/genre/asia-series.html` },
];

const manifest = {
  id: ADDON_ID,
  version: "1.1.0",
  name: ADDON_NAME,
  description: "مسلسلات وأفلام عربية وتركية وخليجية وفارسية وأجنبية من موقع AlooYTV",
  logo: ADDON_LOGO,
  background: "https://bp.alooytv13.xyz/uploads/video_thumb/1890.jpg",
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  catalogs: CATALOGS.map((c) => ({
    type: c.type,
    id: c.id,
    name: c.name,
    extra: [
      { name: "search", isRequired: false },
      { name: "skip", isRequired: false }
    ],
  })),
  idPrefixes: ["alooytvseries:", "alooytvmovie:"],
  behaviorHints: { configurable: false, configurationRequired: false }
};

// ============================================================
// LRU CACHE WITH TTL
// ============================================================

class LRUCache {
  constructor(maxSize = 500, defaultTtl = null) {
    this.maxSize = maxSize;
    this.defaultTtl = defaultTtl;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires && entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttl = this.defaultTtl) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: ttl ? Date.now() + ttl : null });
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

const pageCache = new LRUCache(500, CACHE_TTL_MS);
const metaCache = new LRUCache(300, CACHE_TTL_MS);

// ============================================================
// IN-FLIGHT DEDUPLICATION & FETCH
// ============================================================

const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    try { return await fn(); }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, promise);
  return promise;
}

function fetchRaw(url, { timeout = 8000, headers = HEADERS } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    let req;
    const timer = setTimeout(() => {
      try { if (req) req.destroy(); } catch {}
      reject(new Error("Timeout: " + url));
    }, timeout);

    try {
      req = client.get(url, { headers }, (res) => {
        let stream = res;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on("data", c => chunks.push(c));
        stream.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        stream.on("error", err => {
          clearTimeout(timer);
          reject(err);
        });
      });
      req.on("error", err => {
        clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function fetchText(url) {
  const cached = pageCache.get(url);
  if (cached !== undefined) return cached;

  return dedupe("fetch:" + url, async () => {
    try {
      const text = await fetchRaw(url);
      if (text && text.length > 200) {
        pageCache.set(url, text);
        return text;
      }
      return "";
    } catch {
      return "";
    }
  });
}

// ============================================================
// PARSING HELPERS (LIGHTWEIGHT SCRAPING WITHOUT CHEERIO REGEX)
// ============================================================

function cleanHtml(str) {
  return String(str || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * دالة سكرابر سريعة للكتالوجات باستخدام Regex لضمان أقصى سرعة وتفادي حظر خوادم Vercel Serverless
 */
async function scrapeCatalog(url, type) {
  const html = await fetchText(url);
  if (!html) return [];

  const items = [];
  const seen = new Set();
  
  // Regex قوي لاستخراج الصور والروابط المرافقة لها
  const imgRegex = /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*alt=["']([^"']+)["']/gi;
  let match;
  
  while ((match = imgRegex.exec(html))) {
    const rawImg = match[1];
    const rawTitle = cleanHtml(match[2]);
    if (!rawTitle || (!rawImg.includes("/uploads/video_thumb/") && !rawImg.includes("/uploads/default_image/"))) continue;

    // استخراج رابط الصفحة الأب
    const index = html.lastIndexOf("<a", imgRegex.lastIndex);
    if (index === -1) continue;
    const aPart = html.substring(index, imgRegex.lastIndex);
    const hrefMatch = aPart.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch || !hrefMatch[1].includes("/watch/")) continue;

    const href = hrefMatch[1];
    const slug = href.replace(/.*\/watch\//, "").replace(/\.html.*/, "");
    if (seen.has(slug)) continue;
    seen.add(slug);

    const poster = rawImg.startsWith("http") ? rawImg : `${IMAGE_BASE}${rawImg}`;
    const prefix = type === "movie" ? "alooytvmovie:" : "alooytvseries:";

    items.push({
      id: `${prefix}${slug}`,
      type: type,
      name: rawTitle,
      poster: poster,
      released: "2026-01-01",
      imdbRating: "8.0"
    });
  }

  return items;
}

async function scrapeMeta(slug, type) {
  const cacheKey = `${slug}:${type}`;
  const cached = metaCache.get(cacheKey);
  if (cached) return cached;

  return dedupe("meta:" + cacheKey, async () => {
    const url = `${BASE_URL}/watch/${slug}.html`;
    const html = await fetchText(url);
    if (!html) return null;

    // استخراج العنوان
    let name = "";
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) name = cleanHtml(h1Match[1]);
    if (!name) {
      const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      name = titleMatch ? cleanHtml(titleMatch[1].replace("alooytv", "").replace("|", "").replace("مشاهدة", "").replace("مسلسل", "")) : slug;
    }

    // استخراج البوستر
    let poster = "";
    const posterMatch = html.match(/<img[^>]+(?:src|data-src)=["']([^"']+\/uploads\/video_thumb\/[^"']+)["']/i);
    if (posterMatch) poster = posterMatch[1].startsWith("http") ? posterMatch[1] : `${IMAGE_BASE}${posterMatch[1]}`;
    if (!poster) poster = DEFAULT_THUMB;

    // استخراج القصة والتصنيف
    let genre = "دراما";
    const genreMatch = html.match(/Genre[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    if (genreMatch) genre = cleanHtml(genreMatch[1]);

    let overview = `شاهد مسلسل ${name} أون لاين على AlooYTV.`;
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (descMatch) overview = cleanHtml(descMatch[1]);

    // استخراج الحلقات بدقة عبر البحث عن كل الروابط التي تحتوي على مفتاح key
    const episodes = [];
    const linkRegex = /<a[^>]+href=["']([^"']*key=([^"'&]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lMatch;
    const prefix = type === "movie" ? "alooytvmovie:" : "alooytvseries:";

    while ((lMatch = linkRegex.exec(html))) {
      const key = lMatch[2];
      const text = cleanHtml(lMatch[3]);
      
      const epMatch = text.match(/EP#?(\d+)/i) || text.match(/(\d+)/);
      const epNum = epMatch ? parseInt(epMatch[1], 10) : (episodes.length + 1);

      if (!episodes.some(ep => ep.key === key)) {
        episodes.push({
          id: `${prefix}${slug}:${key}`,
          title: `الحلقة ${epNum}`,
          season: 1,
          episode: epNum,
          key,
          slug
        });
      }
    }

    episodes.sort((a, b) => a.episode - b.episode);

    const result = {
      id: `${prefix}${slug}`,
      name,
      poster,
      genre,
      overview,
      episodes
    };

    metaCache.set(cacheKey, result);
    return result;
  });
}

async function getDirectStreamUrl(slug, key) {
  const url = `${BASE_URL}/watch/${slug}.html?key=${key}`;
  try {
    const html = await fetchText(url);
    if (!html) return null;

    const srcMatch = html.match(/<source\s+src="(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/i);
    if (srcMatch && srcMatch[1] && !srcMatch[1].match(/vid\d+\.0/)) {
      return srcMatch[1];
    }

    const dlMatch = html.match(/download_video\.php\?video_url=([A-Za-z0-9+/=]+)&/);
    if (dlMatch && dlMatch[1]) {
      const decoded = Buffer.from(dlMatch[1], "base64").toString("utf8");
      if (decoded.startsWith("http") && (decoded.includes(".mp4") || decoded.includes(".m3u8"))) {
        return decoded;
      }
    }
  } catch {}
  return null;
}

// ============================================================
// UTILS
// ============================================================

function parseExtraArgs(raw) {
  const out = {};
  if (!raw) return out;
  raw.split("&").forEach(part => {
    const [key, value = ""] = part.split("=");
    if (!key) return;
    out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
  });
  return out;
}

function sendJson(res, payload, statusCode = 200, cacheSeconds = 0) {
  res.statusCode = statusCode;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cacheSeconds > 0) {
    res.setHeader("Cache-Control", `public, max-age=${cacheSeconds}`);
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
  return res.end(JSON.stringify(payload));
}

// ============================================================
// EXPORT HANDLER (SERVERLESS COMPATIBLE WITH VERCEL)
// ============================================================

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.end();
  }

  const url = req.url || "/";

  // Manifest
  if (url === "/" || url === "/manifest.json" || url.startsWith("/manifest.json?")) {
    return sendJson(res, manifest, 200, 3600);
  }

  // Catalog
  const catalogMatch = url.match(/\/catalog\/(series|movie)\/([^/]+)(?:\/(.+))?\.json/);
  if (catalogMatch) {
    try {
      const type = catalogMatch[1];
      const catalogId = catalogMatch[2];
      const extra = parseExtraArgs(catalogMatch[3] || "");
      const search = String(extra.search || "").toLowerCase().trim();
      
      const catalog = CATALOGS.find(c => c.id === catalogId);
      if (!catalog) return sendJson(res, { metas: [] }, 200, 0);

      let items = await scrapeCatalog(catalog.url, type);

      if (search) {
        items = items.filter(item => item.name.toLowerCase().includes(search));
      }

      const metas = items.map(item => ({
        id: item.id,
        type: item.type,
        name: item.name,
        poster: item.poster,
        posterShape: "poster",
        released: item.released,
        imdbRating: item.imdbRating
      }));

      return sendJson(res, { metas }, 200, 900);
    } catch (e) {
      console.error("[Catalog Error]", e.message);
      return sendJson(res, { metas: [] }, 200, 0);
    }
  }

  // Meta
  const metaMatch = url.match(/\/meta\/(series|movie)\/((alooytvseries:|alooytvmovie:)[^/]+)\.json/);
  if (metaMatch) {
    try {
      const type = metaMatch[1];
      const fullId = metaMatch[2];
      const slug = fullId.replace(/^(alooytvseries:|alooytvmovie:)/, "");

      const metaData = await scrapeMeta(slug, type);
      if (!metaData) return sendJson(res, { meta: null }, 200, 0);

      const videos = metaData.episodes.map(ep => ({
        id: ep.id,
        title: ep.title,
        season: ep.season,
        episode: ep.episode,
        released: new Date(Date.now() - ep.episode * 24 * 60 * 60 * 1000).toISOString(),
        overview: `شاهد ${metaData.name} - ${ep.title}`
      }));

      const finalMeta = {
        id: fullId,
        type: type,
        name: metaData.name,
        poster: metaData.poster,
        background: metaData.poster,
        description: metaData.overview ? metaData.overview : `التصنيف: ${metaData.genre}`,
        genres: [metaData.genre, "عربي"],
        posterShape: "poster",
        videos: type === "series" ? videos : undefined
      };

      return sendJson(res, { meta: finalMeta }, 200, 900);
    } catch (e) {
      console.error("[Meta Error]", e.message);
      return sendJson(res, { meta: null }, 200, 0);
    }
  }

  // Stream
  const streamMatch = url.match(/\/stream\/(series|movie)\/((alooytvseries:|alooytvmovie:)[^/]+)\.json/);
  if (streamMatch) {
    try {
      const type = streamMatch[1];
      const fullId = streamMatch[2];
      const cleanId = fullId.replace(/^(alooytvseries:|alooytvmovie:)/, "");
      const parts = cleanId.split(":");
      const slug = parts[0];
      let key = parts[1];

      if (!slug) return sendJson(res, { streams: [] }, 200, 0);

      if (!key) {
        const metaData = await scrapeMeta(slug, type);
        if (!metaData || !metaData.episodes.length) return sendJson(res, { streams: [] }, 200, 0);
        key = metaData.episodes[0].key;
      }

      const directUrl = await getDirectStreamUrl(slug, key);
      const streams = [];

      if (directUrl) {
        streams.push({
          name: "HD",
          title: `AlooYTV - جودة عالية\nالمصدر: البث المباشر`,
          url: directUrl,
          behaviorHints: { notWebReady: false, bingeGroup: `alooytv-${slug}` }
        });
      }

      streams.push({
        name: "WEB",
        title: `AlooYTV - متصفح الويب\nرابط خارجي للمشاهدة`,
        externalUrl: `${BASE_URL}/watch/${slug}.html?key=${key}`,
        behaviorHints: { notWebReady: false }
      });

      return sendJson(res, { streams }, 200, 300);
    } catch (e) {
      console.error("[Stream Error]", e.message);
      return sendJson(res, { streams: [] }, 200, 0);
    }
  }

  return sendJson(res, { error: "Not found" }, 404, 0);
};
