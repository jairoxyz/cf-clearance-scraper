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
let preparedPromise = null;
function prepareOnce() {
  // Promise-based "once" is concurrency-safe: multiple callers share the same in-flight promise.
  if (!preparedPromise) {
    preparedPromise = (async () => {
      try {
        await ensureAndPruneCloakbrowserCache({ syncUpdateAtStartup: true });
        console.log('[Cloakbrowser] Cache prepared');
      } catch (e) {
        console.warn('[Cloakbrowser] Cache prune skipped:', e?.message || e);
      }
    })();
  }
  return preparedPromise;
}

/**
 * Call at service startup (index.js) so:
 * - Xvfb is up before any request
 * - cache prune runs exactly once at startup
 */
async function initAtStartup() {
    await prepareOnce();
    startXvfbIfNeeded();  
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
 * Close only default-context about:blank pages to remove the extra blank window/tab.
 * Headed Chromium often starts with about:blank. 
 */
async function closeDefaultAboutBlankPages(browser) {
  try {
    const defaultCtx = browser.defaultBrowserContext?.();
    if (!defaultCtx) return;

    const pages = await defaultCtx.pages();
    for (const p of pages || []) {
      try {
        if (p.url() === 'about:blank') await p.close();
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * createBrowserFacade({ getLimit, onInc, onDec, getCount })
 *
 * Exposes createBrowserContext(options) so your code can keep:
 *   const ctx = await global.browser.createBrowserContext({ proxyServer })
 *   ...
 *   await ctx.close()
 *
 * Puppeteer contexts (non-default) are closeable. 【1-c9d4ea】
 */
function createBrowserFacade(hooks = {}) {
  const limiter = createLimiter(hooks.getLimit);

  return {
    async createBrowserContext(options = {}) {
      // Xvfb is started at service startup via initAtStartup(), but this is idempotent.
      startXvfbIfNeeded();

      // enforce browserLimit
      const releaseSlot = await limiter.acquire();
      try { hooks.onInc?.(); } catch (_) {}

      const fingerprintSeed = options.fingerprintSeed 
        || `cf-${Buffer.from(options.proxyServer || 'default').toString('base64').slice(0, 16)}`;

      const launch = await getLaunch();

      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-blink-features=FakeShadowRoot',
        `--fingerprint=${fingerprintSeed}`,
      ];

      const proxyServer = normalizeProxyServer(options.proxyServer);
      if (proxyServer) {
        // Chromium proxy configured via command-line flag --proxy-server 【2-9c1544】
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
          launchOptions: {
            slowMo: 30, // Subtle delay between CDP commands (ms)
          },
        });

        // Wait for CloakBrowser patches to fully apply
        await new Promise(r => setTimeout(r, 300));

        // Create a non-default context (isolated). 【1-c9d4ea】
        context = await browser.createBrowserContext();

        // --- Seed a page in THIS context so we have a real window/tab right away ---
        const originalNewPage = context.newPage.bind(context);
        let seedPage = null;
        let seedUsed = false;
        try {
          seedPage = await originalNewPage(); // creates the actual visible tab in this context
        } catch (_) {}

        // Make the FIRST caller's context.newPage() reuse the seed page (prevents 2 tabs)
        context.newPage = async (...npArgs) => {
          if (!seedUsed && seedPage && !seedPage.isClosed()) {
            seedUsed = true;
            return seedPage;
          }
          return originalNewPage(...npArgs);
        };

        // Remove the extra blank window/tab created by launch() (default context about:blank) 
        await closeDefaultAboutBlankPages(browser);

        // Patch close() to also close the owning browser + update counters + release slot
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

module.exports = { createBrowserFacade, prepareOnce, initAtStartup, shutdown };