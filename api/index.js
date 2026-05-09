import express from "express";
import cors from "cors";
import { load } from "cheerio";
import fetch from "node-fetch";

const PORT = process.env.PORT || 7000;
const BASE_URL = "https://bp.alooytv13.xyz";
const IMAGE_BASE = "https://bp.alooytv13.xyz";
const DEFAULT_THUMB = `${IMAGE_BASE}/uploads/default_image/blank_thumbnail.jpg`;

// ─── Cache ────────────────────────────────────────────────────────────────────
const pageCache = new Map();
const streamCache = new Map();
const PAGE_TTL = 3 * 60 * 1000; // كاش لمدة 3 دقائق للمحافظة على سرعة الاستجابة وتخفيف الضغط
const STREAM_TTL = 30 * 60 * 1000;

async function fetchHtml(url) {
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.ts < PAGE_TTL) return cached.html;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ar,en-US;q=0.7,en;q=0.3",
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        Referer: BASE_URL,
      },
      timeout: 8000 // تحديد وقت أقصى للطلب لتجنب تعليق واجهة ستريمو
    });
    
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    
    const html = await res.text();
    if (html && html.length > 200) { // التأكد من جلب صفحة حقيقية وليست فارغة
      pageCache.set(url, { html, ts: Date.now() });
      return html;
    }
    throw new Error("Empty or blocked HTML received");
  } catch (err) {
    console.error(`[Fetch Error] Failed to load URL: ${url}. Error: ${err.message}`);
    // إذا كان هناك كاش قديم تالف، نرجعه كخيار احتياطي بدلاً من الانهيار
    if (cached) return cached.html;
    return "";
  }
}

// ─── Catalog definitions ──────────────────────────────────────────────────────
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

// ─── Manifest ─────────────────────────────────────────────────────────────────
const MANIFEST = {
  id: "community.alooytv.addon",
  version: "1.0.2",
  name: "AlooYTV",
  description: "مسلسلات وأفلام عربية وتركية وخليجية وفارسية وأجنبية من موقع AlooYTV",
  logo: "https://bp.alooytv13.xyz/favicon.ico",
  background: "https://bp.alooytv13.xyz/uploads/video_thumb/1890.jpg",
  types: ["series", "movie"],
  catalogs: CATALOGS.map((c) => ({
    type: c.type,
    id: c.id,
    name: c.name,
    extra: [{ name: "skip", isRequired: false }],
  })),
  resources: [
    { name: "catalog", types: ["series", "movie"] },
    { name: "meta",    types: ["series", "movie"], idPrefixes: ["alooytv:"] },
    { name: "stream",  types: ["series", "movie"], idPrefixes: ["alooytv:"] },
  ],
  idPrefixes: ["alooytv:"],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ─── Scraper helpers ──────────────────────────────────────────────────────────
async function getCatalogItems(catalogId) {
  const catalog = CATALOGS.find((c) => c.id === catalogId);
  if (!catalog) return [];

  const html = await fetchHtml(catalog.url);
  if (!html) return [];
  
  const $ = load(html);
  const items = [];

  $("img.lazy, img[data-src], img[src]").each((_i, el) => {
    const imgEl = $(el);
    const dataSrc = imgEl.attr("data-src") || imgEl.attr("src") || "";
    const name = imgEl.attr("alt") || "";
    if (!name) return;

    if (!dataSrc.includes("/uploads/video_thumb/") && !dataSrc.includes("/uploads/default_image/")) return;

    let href = imgEl.closest("a").attr("href") || "";
    if (!href) href = imgEl.parent().parent().find("a[href*='/watch/']").first().attr("href") || "";
    if (!href.includes("/watch/")) return;

    const slug = href.replace(/.*\/watch\//, "").replace(/\.html.*/, "");
    if (items.some((i) => i.slug === slug)) return;

    const poster = dataSrc && !dataSrc.includes("blank_thumbnail")
      ? (dataSrc.startsWith("http") ? dataSrc : `${IMAGE_BASE}${dataSrc}`)
      : DEFAULT_THUMB;

    items.push({ id: `alooytv:${slug}`, type: catalog.type, name, poster, slug });
  });

  return items;
}

async function getSeriesMeta(slug) {
  const url = `${BASE_URL}/watch/${slug}.html`;
  const html = await fetchHtml(url);
  if (!html) return null;
  
  const $ = load(html);

  let name = $("h1").first().text().trim();
  if (!name) {
    name = $("title").text().replace("alooytv", "").replace("|", "").replace("مشاهدة", "").replace("مسلسل", "").trim();
  }

  let poster = "";
  const thumbImg = $("img[src*='/uploads/video_thumb/'], img[data-src*='/uploads/video_thumb/']").first();
  if (thumbImg.length) {
    poster = thumbImg.attr("data-src") || thumbImg.attr("src") || "";
  }
  
  if (!poster) {
    poster = $("meta[property='og:image']").attr("content") || "";
  }

  if (!poster) {
    poster = DEFAULT_THUMB;
  } else if (!poster.startsWith("http")) {
    poster = `${IMAGE_BASE}${poster}`;
  }

  const genre = $("strong:contains('Genre')").parent().find("a").first().text().trim() || "دراما";
  
  let overview = "";
  const descMeta = $("meta[name='description']").attr("content");
  if (descMeta) {
    overview = descMeta.trim();
  } else {
    overview = $(".video-details, .plot, p").first().text().trim();
  }

  const releaseText = $("strong:contains('Release')").parent().text().trim();
  const releaseMatch = releaseText.match(/\d{4}-\d{2}-\d{2}/);
  const releaseInfo = releaseMatch ? releaseMatch[0] : "2026";

  const episodes = [];
  
  $("a").each((_i, el) => {
    const linkEl = $(el);
    const href = linkEl.attr("href") || "";
    const text = linkEl.text().trim();

    const keyMatch = href.match(/[?&]key=([^&]+)/);
    if (keyMatch) {
      const key = keyMatch[1];
      const epMatch = text.match(/EP#?(\d+)/i) || text.match(/(\d+)/);
      const epNum = epMatch ? parseInt(epMatch[1], 10) : (episodes.length + 1);

      if (!episodes.some(ep => ep.key === key)) {
        episodes.push({
          id: `alooytv:${slug}:${key}`,
          title: `الحلقة ${epNum}`,
          season: 1,
          episode: epNum,
          key,
          slug,
        });
      }
    }
  });

  episodes.sort((a, b) => a.episode - b.episode);

  return {
    id: `alooytv:${slug}`,
    name,
    poster,
    genre,
    overview,
    releaseInfo,
    slug,
    episodes,
  };
}

async function getDirectStreamUrl(slug, key) {
  const cacheKey = `${slug}:${key}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < STREAM_TTL) return cached.url;

  const url = `${BASE_URL}/watch/${slug}.html?key=${key}`;
  try {
    const html = await fetchHtml(url);
    if (!html) return null;

    const srcMatch = html.match(/<source\s+src="(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/i);
    if (srcMatch && srcMatch[1] && !srcMatch[1].match(/vid\d+\.0/)) {
      streamCache.set(cacheKey, { url: srcMatch[1], ts: Date.now() });
      return srcMatch[1];
    }

    const dlMatch = html.match(/download_video\.php\?video_url=([A-Za-z0-9+/=]+)&/);
    if (dlMatch && dlMatch[1]) {
      const decoded = Buffer.from(dlMatch[1], "base64").toString("utf8");
      if (decoded.startsWith("http") && (decoded.includes(".mp4") || decoded.includes(".m3u8"))) {
        streamCache.set(cacheKey, { url: decoded, ts: Date.now() });
        return decoded;
      }
    }
  } catch (err) {
    console.error(`[Stream Error] for key ${key}: ${err.message}`);
  }
  return null;
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/", (_req, res) => {
  res.send("<h1>AlooYTV Stremio Addon is running successfully!</h1><p>Please load <a href='/manifest.json'>/manifest.json</a> in Stremio.</p>");
});

app.get("/test-meta/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const meta = await getSeriesMeta(slug);
    res.json({ success: true, meta });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manifest
app.get("/manifest.json", (_req, res) => res.json(MANIFEST));

// Catalog
app.get("/catalog/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  try {
    const items = await getCatalogItems(id);
    if (!items || items.length === 0) {
      // إرجاع مصفوفة فارغة لتجنب تحطم التطبيق والسماح له بإعادة المحاولة
      return res.json({ metas: [] });
    }
    const metas = items
      .filter((i) => i.type === type || type === "all")
      .map((item) => ({ id: item.id, type: item.type, name: item.name, poster: item.poster, posterShape: "poster" }));
    res.json({ metas });
  } catch {
    res.json({ metas: [] });
  }
});

// Meta
app.get("/meta/:type/:id.json", async (req, res) => {
  const { type: requestedType, id } = req.params;
  const slug = id.replace(/^alooytv:/, "");
  try {
    const meta = await getSeriesMeta(slug);
    if (!meta) return res.status(404).json({ meta: null });

    const finalType = requestedType === "movie" ? "movie" : "series";
    const videos = meta.episodes.map((ep) => ({
      id: ep.id,
      title: ep.title,
      season: ep.season,
      episode: ep.episode,
      released: new Date(Date.now() - ep.episode * 24 * 60 * 60 * 1000).toISOString(),
      overview: `شاهد ${meta.name} - ${ep.title}`,
    }));

    res.json({
      meta: {
        id: meta.id,
        type: finalType,
        name: meta.name,
        poster: meta.poster,
        background: meta.poster,
        description: meta.overview ? meta.overview : (meta.genre ? `النوع: ${meta.genre}` : ""),
        releaseInfo: meta.releaseInfo,
        videos: finalType === "series" ? videos : undefined,
      },
    });
  } catch {
    res.status(500).json({ meta: null });
  }
});

// Stream
app.get("/stream/:type/:id.json", async (req, res) => {
  const { id } = req.params;
  const parts = id.replace(/^alooytv:/, "").split(":");
  const slug = parts[0];
  let key = parts[1];

  if (!slug) return res.json({ streams: [] });

  try {
    if (!key) {
      const meta = await getSeriesMeta(slug);
      if (!meta || !meta.episodes.length) return res.json({ streams: [] });
      key = meta.episodes[0].key;
    }

    const directUrl = await getDirectStreamUrl(slug, key);
    const streams = [];

    if (directUrl) {
      streams.push({
        title: "🎬 AlooYTV - جودة عالية",
        url: directUrl,
        behaviorHints: { notWebReady: false, bingeGroup: `alooytv-${slug}` },
      });
    }

    // إضافة رابط المتصفح دائماً كخيار احتياطي ومضمون
    streams.push({
      title: "🌐 AlooYTV - متصفح الويب",
      externalUrl: `${BASE_URL}/watch/${slug}.html?key=${key}`,
      behaviorHints: { notWebReady: false },
    });

    res.json({ streams });
  } catch {
    res.json({ streams: [] });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n✅ AlooYTV Stremio Addon يعمل على المنفذ ${PORT}`);
});
