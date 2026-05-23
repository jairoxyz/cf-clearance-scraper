'use strict';

const { ensureAndPruneCloakbrowserCache } = require('./cloakbrowserCache');
const Xvfb = require('xvfb');

let _launch;
async function getLaunch() {
  if (!_launch) ({ launch: _launch } = await import('cloakbrowser/puppeteer'));
  return _launch;
}

// ---------- XVFB (headed Linux) ----------
let xvfbSession = null;
function startXvfbIfNeeded() {
  if (process.platform !== 'linux') return;
  if (xvfbSession) return;

  process.env.DISPLAY = process.env.DISPLAY || ':99';
  try {
    xvfbSession = new Xvfb({
      silent: true,
      xvfb_args: ['-screen', '0', '1920x1080x24', '-ac'],
    });
    xvfbSession.startSync();
    console.log('[XVFB] Started');
  } catch (err) {
    console.error('[XVFB] Start error:', err?.message || err);
    xvfbSession = null;
  }
}

function stopXvfb() {
  if (!xvfbSession) return;
  try { xvfbSession.stopSync(); } catch (_) {}
  xvfbSession = null;
  console.log('[XVFB] Stopped');
}

// ---------- One-time cache prep ----------
let prepared = false;
async function prepareOnce() {
  if (prepared) return;
  prepared = true;
  try {
    await ensureAndPruneCloakbrowserCache({ syncUpdateAtStartup: true });
  } catch (e) {
    console.warn('[Cloakbrowser] cache prune skipped:', e?.message || e);
  }
}

// ---------- Simple concurrency limiter ----------
function createLimiter(getLimit) {
  let running = 0;
  const queue = [];

  async function acquire() {
    const limit = Math.max(1, Number(getLimit?.() ?? 1));
    if (running < limit) {
      running++;
      return () => release();
    }
    return new Promise((resolve) => {
      queue.push(() => {
        running++;
        resolve(() => release());
      });
    });
  }

  function release() {
    running = Math.max(0, running - 1);
    const next = queue.shift();
    if (next) next();
  }

  function stats() {
    return { running, queued: queue.length };
  }

  return { acquire, stats };
}

function normalizeProxyServer(proxyServer) {
  if (!proxyServer) return null;
  return proxyServer.includes('://') ? proxyServer : `http://${proxyServer}`;
}

/**
 * createBrowserFacade({ getLimit, onInc, onDec, getCount })
 *
 * Exposes a compatible createBrowserContext(options) method so existing code can keep:
 *   await global.browser.createBrowserContext({ proxyServer })
 *   ...
 *   await context.close()
 *
 * In Puppeteer, BrowserContext is closeable for non-default contexts. 【2-1370ea】【1-64e0a7】
 */
function createBrowserFacade(hooks = {}) {
  const limiter = createLimiter(hooks.getLimit);

  return {
    async createBrowserContext(options = {}) {
      //await prepareOnce();
      startXvfbIfNeeded();

      // enforce browserLimit
      const releaseSlot = await limiter.acquire();

      // increment your counters
      try { hooks.onInc?.(); } catch (_) {}

      const launch = await getLaunch();

      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-blink-features=FakeShadowRoot',
      ];

      const proxyServer = normalizeProxyServer(options.proxyServer);
      if (proxyServer) {
        // Chromium proxy configured via command-line flag --proxy-server 【3-981f4f】
        args.push(`--proxy-server=${proxyServer}`);
      }

      let browser;
      let context;

      try {
        browser = await launch({
          headless: false,
          humanize: true,
          humanPreset: 'careful',
          args,
        });

        context = await browser.createBrowserContext(); // non-default context 【2-1370ea】

        // Patch context.close() to also close the owning browser + update counters + release slot
        const originalClose = context.close.bind(context);
        let done = false;

        context.close = async (...closeArgs) => {
          if (done) return;
          done = true;
          try { await originalClose(...closeArgs); } catch (_) {}
          try { await browser.close(); } catch (_) {}

          try { hooks.onDec?.(); } catch (_) {}
          releaseSlot();
        };

        return context;
      } catch (err) {
        // If we failed before returning context, cleanup and release slot/counter
        try { if (context) await context.close(); } catch (_) {}
        try { if (browser) await browser.close(); } catch (_) {}

        try { hooks.onDec?.(); } catch (_) {}
        releaseSlot();

        throw err;
      }
    },

    // Optional: expose stats if you ever want to log
    _stats() {
      return {
        limiter: limiter.stats(),
        browserLength: hooks.getCount?.(),
        browserLimit: hooks.getLimit?.(),
      };
    },
  };
}

async function shutdown() {
  stopXvfb();
}

module.exports = { createBrowserFacade, prepareOnce, shutdown };