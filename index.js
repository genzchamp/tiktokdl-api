// index.js (CommonJS) - Koa server for TikTok downloader
'use strict';

const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const serve = require('koa-static');
const logger = require('koa-logger');
const responseTime = require('koa-response-time');
const ratelimit = require('koa-ratelimit');
const scraper = require('btch-downloader'); // existing provider used earlier
const nodeFetch = require('node-fetch'); // requires node-fetch v2.x (CommonJS)
const { URL } = require('url');

const app = new Koa();
const router = new Router();
const port = process.env.PORT || 3000;

// serve static files from public/
app.use(serve('public'));

// helpful middlewares
app.use(logger());
app.use(responseTime());
app.use(bodyParser());

// rate limit (in-memory) - fine for small-scale usage
app.use(ratelimit({
  driver: 'memory',
  db: new Map(),
  duration: 1000 * 55,
  errorMessage: {
    ok: false,
    error: {
      code: 429,
      message: 'Rate limit exceeded. See "Retry-After"'
    }
  },
  id: (ctx) => ctx.ip,
  headers: {
    remaining: 'Rate-Limit-Remaining',
    reset: 'Rate-Limit-Reset',
    total: 'Rate-Limit-Total'
  },
  max: 100
}));

/**
 * Compatibility route (original)
 * GET /tiktok/api.php?url=<tiktok_link>
 * Returns provider's audio/video structure (keeps backwards compatibility)
 */
router.get('/tiktok/api.php', async (ctx) => {
  const urls = ctx.request.query.url;
  if (!urls) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing url query param' };
    return;
  }

  try {
    const result = await scraper.ttdl(urls);
    const audio = result && result.audio ? result.audio : null;
    const video = result && result.video ? result.video : null;
    ctx.body = { audio, video };
  } catch (error) {
    console.error('GET /tiktok/api.php error:', error && (error.stack || error));
    ctx.status = 500;
    ctx.body = { ok: false, error: 'Internal server error' };
  }
});

/**
 * Helper GET route for testing:
 * GET /download?url=<tiktok_link>
 * Returns normalized JSON with downloadUrl + thumbnail
 */
router.get('/download', async (ctx) => {
  const urls = ctx.request.query.url || ctx.request.query.tiktokUrl;
  if (!urls) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing url query param' };
    return;
  }

  try {
    const result = await scraper.ttdl(urls);
    const video = result && result.video ? result.video : result;

    let downloadUrl = null;
    let thumbnail = null;

    if (typeof video === 'string') {
      downloadUrl = video;
    } else if (video && typeof video === 'object') {
      downloadUrl = video.noWatermark || video.no_watermark || video.url || video.playAddr || video.download || (video.urls && video.urls[0]) || null;
      thumbnail = video.thumbnail || video.cover || result.thumbnail || null;
    }

    ctx.body = { ok: true, downloadUrl, thumbnail, raw: result };
  } catch (err) {
    console.error('GET /download error:', err && (err.stack || err));
    ctx.status = 502;
    ctx.body = { ok: false, error: 'Upstream provider error', details: String(err) };
  }
});

/**
 * POST /api/download
 * Expects JSON body: { tiktokUrl: "https://vm.tiktok.com/..." }
 * Returns JSON { ok: true, downloadUrl, thumbnail, raw }
 */
router.post('/api/download', async (ctx) => {
  const body = ctx.request.body || {};
  const tiktokUrl = body.tiktokUrl || body.url || ctx.request.query.url;
  if (!tiktokUrl) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing tiktokUrl in request body or url query' };
    return;
  }

  // small retry wrapper
  async function tryProvider(url, attempts = 2) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await scraper.ttdl(url);
        return res;
      } catch (err) {
        lastErr = err;
        console.warn(`scraper.ttdl attempt ${i+1} failed:`, (err && (err.message || err)));
        await new Promise(r => setTimeout(r, 300 * (i+1)));
      }
    }
    throw lastErr;
  }

  // deep find helper
  function deepFindUrl(obj) {
    if (!obj) return null;
    if (typeof obj === 'string' && /^https?:\/\//i.test(obj)) return obj;

    const keys = [
      'downloadUrl','download','url','playAddr','play_url','videoUrl','video','video_url',
      'noWatermark','no_watermark','no_watermark_url','watermarkless','no_wm','wmfree'
    ];

    for (const k of keys) {
      if (obj[k]) {
        if (typeof obj[k] === 'string' && /^https?:\/\//i.test(obj[k])) return obj[k];
        if (typeof obj[k] === 'object') {
          const nested = obj[k].url || obj[k].src || obj[k].playAddr || obj[k].download || obj[k][0];
          if (typeof nested === 'string' && /^https?:\/\//i.test(nested)) return nested;
        }
      }
    }

    if (Array.isArray(obj.urls)) {
      for (const u of obj.urls) {
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
        if (u && typeof u === 'object') {
          const cand = u.url || u.src || u.playAddr || u.download;
          if (typeof cand === 'string' && /^https?:\/\//i.test(cand)) return cand;
        }
      }
    }

    if (obj.video) {
      const found = deepFindUrl(obj.video);
      if (found) return found;
    }
    if (obj.data) {
      const found = deepFindUrl(obj.data);
      if (found) return found;
    }

    // limited deep scan
    function deepScan(o, depth = 0) {
      if (!o || depth > 3) return null;
      if (typeof o === 'string' && /^https?:\/\//i.test(o)) return o;
      if (Array.isArray(o)) {
        for (const it of o) {
          const r = deepScan(it, depth + 1);
          if (r) return r;
        }
      } else if (typeof o === 'object') {
        for (const kk of Object.keys(o)) {
          const r = deepScan(o[kk], depth + 1);
          if (r) return r;
        }
      }
      return null;
    }

    return deepScan(obj, 0);
  }

  try {
    const result = await tryProvider(tiktokUrl, 2);
    console.log('provider raw result keys:', result && typeof result === 'object' ? Object.keys(result) : typeof result);

    let downloadUrl = null;
    let thumbnail = null;
    if (result && result.video) {
      downloadUrl = deepFindUrl(result.video);
      thumbnail = result.thumbnail || result.cover || (result.video && (result.video.thumbnail || result.video.cover)) || null;
    } else {
      downloadUrl = deepFindUrl(result);
      thumbnail = result && (result.thumbnail || result.cover || null);
    }

    if (!downloadUrl) {
      ctx.status = 502;
      ctx.body = { ok: false, error: 'No download URL found from provider', raw: result };
      return;
    }

    ctx.body = { ok: true, downloadUrl, thumbnail, raw: result };
  } catch (err) {
    console.error('POST /api/download provider failure:', err && (err.stack || err));
    ctx.status = 502;
    ctx.body = { ok: false, error: 'Provider call failed', details: String(err) };
  }
});

/**
 * GET /stream?url=<encoded_mp4_url>
 * Proxies and forces download with Content-Disposition: attachment
 */
router.get('/stream', async (ctx) => {
  const source = ctx.request.query.url || ctx.request.query.source;
  if (!source) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing url query parameter' };
    return;
  }

  try {
    const parsed = new URL(source);
    if (!/^https?:$/.test(parsed.protocol)) {
      ctx.status = 400;
      ctx.body = { ok: false, error: 'Invalid URL protocol' };
      return;
    }

    const upstream = await nodeFetch(source, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
      }
    });

    if (!upstream.ok) {
      const bodyText = await upstream.text().catch(() => '');
      ctx.status = 502;
      ctx.body = { ok: false, error: 'Upstream fetch failed', status: upstream.status, body: bodyText };
      return;
    }

    // Try to pick filename from Content-Disposition or fallback to path
    let filename = 'tiktok_video.mp4';
    try {
      const cd = upstream.headers.get('content-disposition');
      if (cd) {
        const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)/i);
        if (m && m[1]) filename = decodeURIComponent(m[1]);
      } else {
        const parts = parsed.pathname.split('/');
        const last = parts[parts.length - 1] || '';
        if (last && last.includes('.')) filename = last;
      }
    } catch (e) {
      // ignore and use fallback filename
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    ctx.set('Content-Type', contentType);
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`);

    const upstreamLength = upstream.headers.get('content-length');
    if (upstreamLength) ctx.set('Content-Length', upstreamLength);

    ctx.status = 200;
    ctx.body = upstream.body; // node-fetch v2 Readable stream
  } catch (err) {
    console.error('GET /stream error:', err && (err.stack || err));
    ctx.status = 500;
    ctx.body = { ok: false, error: 'Server error proxying video', details: String(err) };
  }
});

// Apply routes & start server
app.use(router.routes());
app.use(router.allowedMethods());

app.listen(port, () => {
  console.log(`Server started on - http://localhost:${port}`);
  console.log(`Port - ${port}`);
});