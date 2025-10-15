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
const nodeFetch = require('node-fetch'); // node-fetch v2.x (CommonJS)
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

// rate limit (in-memory)
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
 * Helper test route: GET /download?url=...
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
 * Robust POST /api/download
 * Expects JSON body: { tiktokUrl: "https://..." }
 */
router.post('/api/download', async (ctx) => {
  const body = ctx.request.body || {};
  const tiktokUrl = body.tiktokUrl || body.url || ctx.request.query.url;
  if (!tiktokUrl) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing tiktokUrl in request body or url query' };
    return;
  }

  // retry wrapper
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

  // deep find helper for http(s) urls
  function deepFindUrl(obj, depth = 0) {
    if (!obj || depth > 4) return null;
    if (typeof obj === 'string' && /^https?:\/\//i.test(obj)) return obj;

    const candidateKeys = [
      'downloadUrl','download','url','playAddr','play_url','videoUrl','video','video_url',
      'noWatermark','no_watermark','no_watermark_url','watermarkless','no_wm','wmfree',
      'src','source'
    ];

    if (typeof obj === 'object') {
      for (const k of candidateKeys) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const v = obj[k];
          if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
          if (Array.isArray(v) && v.length) {
            for (const it of v) {
              if (typeof it === 'string' && /^https?:\/\//i.test(it)) return it;
              if (typeof it === 'object') {
                const inner = deepFindUrl(it, depth + 1);
                if (inner) return inner;
              }
            }
          }
          if (typeof v === 'object') {
            const nested = deepFindUrl(v, depth + 1);
            if (nested) return nested;
          }
        }
      }
    }

    if (Array.isArray(obj)) {
      for (const it of obj) {
        const r = deepFindUrl(it, depth + 1);
        if (r) return r;
      }
    } else if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        try {
          const val = obj[key];
          if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
          const r = deepFindUrl(val, depth + 1);
          if (r) return r;
        } catch (e) {
          console.warn('deepFindUrl property access error for key', key, e && e.message);
        }
      }
    }
    return null;
  }

  try {
    const result = await tryProvider(tiktokUrl, 2);

    // <<-- DEBUG LOG: show full provider raw result (for inspection in Render logs)
    try {
      console.log('PROVIDER RAW RESULT ===>', JSON.stringify(result, null, 2));
    } catch (logErr) {
      console.warn('Could not stringify provider result for logging:', logErr && logErr.message);
    }
    // also log top-level keys for quick view
    console.log('provider raw result keys:', result && typeof result === 'object' ? Object.keys(result) : typeof result);

    // try common containers
    const candidateContainers = [];
    if (result && result.video) candidateContainers.push(result.video);
    if (result && result.data) candidateContainers.push(result.data);
    candidateContainers.push(result);

    let downloadUrl = null;
    let thumbnail = null;

    for (const container of candidateContainers) {
      if (!container) continue;
      downloadUrl = deepFindUrl(container);
      if (downloadUrl) {
        thumbnail = (container && (container.thumbnail || container.cover || container.thumb)) || result.thumbnail || result.cover || null;
        break;
      }
    }

    // final fallback deep scan
    if (!downloadUrl) downloadUrl = deepFindUrl(result);

    if (!downloadUrl) {
      ctx.status = 502;
      ctx.body = {
        ok: false,
        error: 'No download URL found from provider',
        hint: 'Provider returned unexpected shape. Please paste the "raw" field from this response here for debugging.',
        raw: result
      };
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

    // Pick filename from headers or fallback to path
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
      // ignore and use fallback
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    ctx.set('Content-Type', contentType);
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`);

    const upstreamLength = upstream.headers.get('content-length');
    if (upstreamLength) ctx.set('Content-Length', upstreamLength);

    ctx.status = 200;
    ctx.body = upstream.body;
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