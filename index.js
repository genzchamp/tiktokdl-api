// index.js - Koa server for TikTok downloader (updated)
// Keep the NODE_TLS_REJECT_UNAUTHORIZED line commented out for security.
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const serve = require('koa-static');
const logger = require('koa-logger');
const responseTime = require('koa-response-time');
const ratelimit = require('koa-ratelimit');
const scraper = require('btch-downloader');

const app = new Koa();
const router = new Router();

const port = process.env.PORT || 3000;

app.use(serve('public'));
app.use(logger());
app.use(responseTime());
app.use(bodyParser());

// simple in-memory rate limit (suitable for small scale)
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
 * Original compatibility route (keeps existing behavior)
 * Example: GET /tiktok/api.php?url=<tiktok_link>
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
    // original response shape: return audio, video
    const { audio, video } = result || {};
    ctx.body = { audio, video };
  } catch (error) {
    console.error('GET /tiktok/api.php error:', error && (error.stack || error));
    ctx.status = 500;
    ctx.body = { ok: false, error: 'Internal server error' };
  }
});

/**
 * GET /download?url=<tiktok_link>
 * Quick helper for testing with curl or direct GET requests.
 * Returns normalized JSON with downloadUrl and thumbnail fields.
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
    // Try to normalize the result to downloadUrl + thumbnail
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
 * Returns JSON: { ok:true, downloadUrl: "...", thumbnail: "...", raw: {...} }
 */
// Improved POST /api/download with aggressive normalization + debug info
router.post('/api/download', async (ctx) => {
  const body = ctx.request.body || {};
  const tiktokUrl = body.tiktokUrl || body.url || ctx.request.query.url;
  if (!tiktokUrl) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing tiktokUrl in request body or url query' };
    return;
  }

  // helper: try to extract a URL from many possible shapes
  function findDownloadUrl(obj) {
    if (!obj) return null;
    // if it's already a string and looks like an http url, return it
    if (typeof obj === 'string' && /^https?:\/\//i.test(obj)) return obj;

    // common candidate keys
    const keys = [
      'downloadUrl','download','url','playAddr','play_url','videoUrl','video','video_url',
      'noWatermark','no_watermark','no_watermark_url','no_watermark_url',
      'watermarkless','no_wm','wmfree'
    ];

    for (const k of keys) {
      if (obj[k]) {
        if (typeof obj[k] === 'string' && /^https?:\/\//i.test(obj[k])) return obj[k];
        // sometimes nested objects
        if (typeof obj[k] === 'object') {
          // check common nested fields
          const nested = obj[k].url || obj[k].src || obj[k].playAddr || obj[k].download || obj[k][0];
          if (nested && typeof nested === 'string' && /^https?:\/\//i.test(nested)) return nested;
        }
      }
    }

    // arrays like urls: [ { url: '...' }, '...' ]
    if (Array.isArray(obj.urls) && obj.urls.length) {
      for (const u of obj.urls) {
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
        if (u && typeof u === 'object') {
          const cand = u.url || u.src || u.playAddr || u.download;
          if (cand && typeof cand === 'string' && /^https?:\/\//i.test(cand)) return cand;
        }
      }
    }

    // check for nested video object
    if (obj.video) {
      const found = findDownloadUrl(obj.video);
      if (found) return found;
    }

    // thumbnail sometimes contains video url? check common nested fields
    if (obj.data) {
      const fromData = findDownloadUrl(obj.data);
      if (fromData) return fromData;
    }

    // deep scan: walk object (limited depth to avoid perf)
    function deepScan(o, depth = 0) {
      if (!o || depth > 3) return null;
      if (typeof o === 'string' && /^https?:\/\//i.test(o)) return o;
      if (Array.isArray(o)) {
        for (const it of o) {
          const r = deepScan(it, depth + 1);
          if (r) return r;
        }
      } else if (typeof o === 'object') {
        for (const k of Object.keys(o)) {
          const r = deepScan(o[k], depth + 1);
          if (r) return r;
        }
      }
      return null;
    }

    return deepScan(obj, 0);
  }

  // small retry wrapper in case of transient failures
  async function tryProvider(url, attempts = 2) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await scraper.ttdl(url);
        return res;
      } catch (err) {
        lastErr = err;
        console.warn(`scraper.ttdl attempt ${i+1} failed:`, (err && (err.message || err)));
        // slight delay between retries
        await new Promise(r => setTimeout(r, 400 * (i+1)));
      }
    }
    throw lastErr;
  }

  try {
    const result = await tryProvider(tiktokUrl, 2);
    // log the raw result for debug (will show up in Render logs)
    console.log('provider raw result:', JSON.stringify(result && (typeof result === 'object' ? result : { result }), null, 2));

    // attempt to find download url
    let downloadUrl = null;
    let thumbnail = null;

    // if provider returns {audio, video} like the original route
    if (result && result.video) {
      downloadUrl = findDownloadUrl(result.video);
      thumbnail = result.thumbnail || result.cover || (result.video && (result.video.thumbnail || result.video.cover));
    } else {
      // try direct
      downloadUrl = findDownloadUrl(result);
      thumbnail = result && (result.thumbnail || result.cover || null);
    }

    if (!downloadUrl) {
      // give the caller as much info as possible for debugging
      ctx.status = 502;
      ctx.body = {
        ok: false,
        error: 'No download url found from provider',
        hint: 'Check the "raw" field for provider response shape',
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
 * GET /stream?url=<encoded_download_url>
 * Proxies the remote video URL and streams it to the client with a Content-Disposition
 * so the browser will download the file directly without opening another page.
 */
import { URL } from 'url';
const nodeFetch = require('node-fetch'); // if already required as scraper uses btch-downloader, this is fine

router.get('/stream', async (ctx) => {
  const source = ctx.request.query.url || ctx.request.query.source;
  if (!source) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing url query parameter' };
    return;
  }

  try {
    // Basic validation: ensure this looks like an http(s) URL
    const parsed = new URL(source);
    if (!/^https?:$/.test(parsed.protocol)) {
      ctx.status = 400;
      ctx.body = { ok: false, error: 'Invalid URL protocol' };
      return;
    }

    // Fetch the remote video. Use node-fetch to get the stream.
    const upstream = await nodeFetch(source, { method: 'GET' });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      ctx.status = 502;
      ctx.body = { ok: false, error: 'Upstream fetch failed', status: upstream.status, body: txt };
      return;
    }

    // Try to determine filename from URL or Content-Disposition
    let filename = 'tiktok_video.mp4';
    try {
      const pathParts = parsed.pathname.split('/');
      const last = pathParts[pathParts.length - 1];
      if (last && last.includes('.')) filename = last;
    } catch (e) {}

    // Set headers for download
    ctx.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
    // Optional: set cache-control if you want browsers to cache
    // ctx.set('Cache-Control', 'public, max-age=3600');

    // Pipe upstream body (ReadableStream) into koa response
    ctx.body = upstream.body; // node-fetch v2 returns a Node Readable stream — Koa will stream it
  } catch (err) {
    console.error('GET /stream error:', err && (err.stack || err));
    ctx.status = 500;
    ctx.body = { ok: false, error: 'Server error proxying video', details: String(err) };
  }
});

// ===== Stronger /stream route (Koa) =====
const { URL } = require('url');
const nodeFetch = require('node-fetch'); // ensure this is installed in package.json

router.get('/stream', async (ctx) => {
  const source = ctx.request.query.url || ctx.request.query.source;
  if (!source) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing url query parameter' };
    return;
  }

  try {
    // Basic validation
    const parsed = new URL(source);
    if (!/^https?:$/.test(parsed.protocol)) {
      ctx.status = 400;
      ctx.body = { ok: false, error: 'Invalid URL protocol' };
      return;
    }

    // Fetch upstream, follow redirects
    const upstream = await nodeFetch(source, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // Some providers block non-browser agents — use a browser UA
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': '*/*'
      },
      // optional: increase timeout if needed (node-fetch v2 doesn't have timeout here)
    });

    if (!upstream.ok) {
      const bodyText = await upstream.text().catch(() => '');
      ctx.status = 502;
      ctx.body = { ok: false, error: 'Upstream fetch failed', status: upstream.status, body: bodyText };
      return;
    }

    // Derive filename (try content-disposition header or fallback)
    let filename = 'tiktok_video.mp4';
    try {
      // try upstream Content-Disposition to extract filename
      const cd = upstream.headers.get('content-disposition');
      if (cd) {
        const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)/i);
        if (m && m[1]) {
          filename = decodeURIComponent(m[1]);
        }
      } else {
        // fallback: use last path part if it contains extension
        const parts = parsed.pathname.split('/');
        const last = parts[parts.length - 1] || '';
        if (last && last.includes('.')) filename = last;
      }
    } catch (e) {
      // ignore and use fallback filename
    }

    // Set response headers to force download
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    ctx.set('Content-Type', contentType);
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`);

    // If upstream provides length, forward it
    const upstreamLength = upstream.headers.get('content-length');
    if (upstreamLength) ctx.set('Content-Length', upstreamLength);

    // Stream upstream body directly to client (node-fetch v2 -> Readable stream)
    ctx.status = 200;
    ctx.body = upstream.body;
  } catch (err) {
    console.error('GET /stream error:', err && (err.stack || err));
    ctx.status = 500;
    ctx.body = { ok: false, error: 'Server error proxying video', details: String(err) };
  }
});
// ===== end /stream =====

app.use(router.routes());
app.use(router.allowedMethods());

app.listen(port, () => {
  console.log(`Server started on - http://localhost:${port}`);
  console.log(`Port - ${port}`);
});