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
router.post('/api/download', async (ctx) => {
  const body = ctx.request.body || {};
  const tiktokUrl = body.tiktokUrl || body.url || ctx.request.query.url;
  if (!tiktokUrl) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'Missing tiktokUrl in request body or url query' };
    return;
  }

  try {
    const result = await scraper.ttdl(tiktokUrl);

    const video = result && result.video ? result.video : result;
    let downloadUrl = null;
    let thumbnail = null;

    if (typeof video === 'string') {
      downloadUrl = video;
    } else if (video && typeof video === 'object') {
      downloadUrl = video.noWatermark || video.no_watermark || video.url || video.playAddr || video.download || (video.urls && video.urls[0]) || null;
      thumbnail = video.thumbnail || video.cover || result.thumbnail || null;
    }

    if (!downloadUrl) {
      // return raw for debugging if no usable URL found
      ctx.status = 502;
      ctx.body = { ok: false, error: 'No download URL found from provider', raw: result };
      return;
    }

    ctx.body = { ok: true, downloadUrl, thumbnail, raw: result };
  } catch (err) {
    console.error('POST /api/download error:', err && (err.stack || err));
    ctx.status = 502;
    ctx.body = { ok: false, error: 'Provider error', details: String(err) };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

app.listen(port, () => {
  console.log(`Server started on - http://localhost:${port}`);
  console.log(`Port - ${port}`);
});