'use strict';

const { ensureAndPruneCloakbrowserCache } = require('./cloakbrowserCache');

let _launch;
async function getLaunch() {
  if (!_launch) ({ launch: _launch } = await import('cloakbrowser/puppeteer'));
  return _launch;
}
const Xvfb = require('xvfb');

// Module-level Xvfb session (one per process, shared across reconnects).
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
  try {
    xvfbSession.stopSync();
    console.log('[XVFB] Stopped');
  } catch (err) {
    console.error('[XVFB] Stop error:', err?.message || err);
  } finally {
    xvfbSession = null;
  }
}

// Call once the solution has been returned to the client.
async function closeBrowser() {
  if (global.browser) {
    try { await global.browser.close(); } catch (_) {}
    global.browser = null;
  }
  stopXvfb();
}


async function createBrowser() {

  
  // Clean CloakBrowser cache once at service start:
  // ensureBinary() guarantees effective binary exists; binaryInfo() tells which version; prune others. 
  try {    
    await ensureAndPruneCloakbrowserCache({ syncUpdateAtStartup: true });
  } catch (e) {
    console.warn('[createBrowser] cache prune skipped:', e?.message || e);
  }

  const launch = await getLaunch();

  startXvfbIfNeeded();

  let attempt = 0;
  while (!global.finished) {
    attempt += 1;
    try {
      // Close any stale instance
      if (global.browser) {
        try { await global.browser.close(); } catch (_) {}
        global.browser = null;
      }

      const browser = await launch({
        headless: false,
        humanize: true,
        humanPreset: 'careful',
        //geoip: true,        
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--enable-blink-features=FakeShadowRoot',
          // optional stability flags:
          //'--disable-gpu',
        ],
      });

      global.browser = browser;

      browser.once('disconnected', () => {
        if (global.finished) return;
        console.warn('[createBrowser] Browser disconnected; will relaunch');
        // Let loop relaunch; don’t recurse
        global.browser = null;
      });

      console.log('[createBrowser] Browser ready');
      return; // browser running; exit createBrowser()
    } catch (err) {
      console.error('[createBrowser] Launch error:', err?.message || err);
      global.browser = null;

      // backoff (cap it)
      const delay = Math.min(3000 * attempt, 15000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}


createBrowser();

module.exports = { closeBrowser };