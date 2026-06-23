const { debug } = require('puppeteer-core');
const { debugLog, infoLog, warnLog, errorLog } = require('../module/logger');
const { clickCheckboxViaCDP } = require('../module/clickCheckbox'); 

const CHALLENGE_TITLES = ['Just a moment...',
  'Please Wait... | Cloudflare',
  'Cloudflare Turnstile demo: Sample Form with Cloudflare Turnstile',
  'Maintenance - GUpload',
];


// Use CDP Accessibility tree to find and click the Turnstile checkbox.
// This is the only approach that works without modifying page behaviour:
//   - Does NOT override attachShadow (which Cloudflare detects and rejects)
//   - Does NOT rely on pierce/ (which cannot reach closed shadow roots)
//   - Works across iframes and arbitrarily nested closed shadow roots
//   - Coordinates from DOM.getBoxModel are in the main page's document space,
//     so they work correctly whether the checkbox is on the page or in an iframe


async function solveCloudflare(page) {
  // If we're not on a challenge page, nothing to solve.
  const title = await page.title().catch(() => '');
  if (!CHALLENGE_TITLES.includes(title)) return false;

  infoLog('[solveCloudflare] Challenge detected, attempting to solve ...');

  // Simulate human presence: random movements across the page before solving
  //await simulateHumanMouseMovement(page);

  const maxMs = global.timeOut || 45000;
  const deadline = Date.now() + maxMs;

  let solved = false;
  let lastNonTimeoutError = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;

    // 1) Fast solved check (handles auto-solve / solved during waits)
    const currentTitle = await page.title().catch(() => null);
    if (currentTitle != null && !CHALLENGE_TITLES.includes(currentTitle)) {
      debugLog('[solveCloudflare] Challenge resolved (title changed).');
      solved = true;
      break;
    }

    // 2) Attempt click
    const clicked = await clickCheckboxViaCDP(page).catch(err => {
      errorLog('[solveCloudflare] CDP error:', err?.message || String(err));
      return false;
    });

    if (!clicked) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    // 3) After click: wait briefly for title to change away from challenge titles
    try {
      // waitForFunction waits until the function becomes truthy or timeout occurs.
      await page.waitForFunction(
        (titles) => !titles.includes(document.title),
        { timeout: 5000, polling: 200 },
        CHALLENGE_TITLES
      );

      debugLog('[solveCloudflare] Challenge resolved (waitForFunction).');
      solved = true;
      break;

    } catch (err) {
      const name = err?.name || '';
      const msg = err?.message || String(err);

      // Puppeteer throws TimeoutError when an operation times out. 
      const isTimeout = name === 'TimeoutError' || msg.includes('Waiting failed');

      if (!isTimeout) {
        lastNonTimeoutError = err;
        // This can happen on navigation / reloads: "Execution context was destroyed..."
        debugLog(`[solveCloudflare] WaitForFunction non-timeout error (attempt ${attempt}):`, msg);
      } else {
        // Expected case: not solved yet within the short 2s window
        debugLog(`[solveCloudflare] Not solved yet (2s check timed out, attempt ${attempt}).`);
      }
    }

    // 4) Cooldown before retry: CF often refreshes/reloads the widget
    debugLog('[solveCloudflare] Solve rejected, waiting for fresh challenge...');
    // Random cooldown 1.5–3s — avoids fixed-interval patterns CF can fingerprint
    await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
  }

  // If loop ended without solved=true, it was a timeout.
  if (!solved) {
    warnLog(`[solveCloudflare] Timed out after ${maxMs}ms. Challenge NOT solved.`);
    if (lastNonTimeoutError) {
      debugLog('[solveCloudflare] Last non-timeout error:', lastNonTimeoutError?.message || String(lastNonTimeoutError));
    }
    return false;
  }

  infoLog('[solveCloudflare] ✓ Challenge solved successfully.');

  // Post-solve wait (only when solved)
  // Wait for leaving the challenge platform URL; ignore timeout.
  await page.waitForFunction(
    () => !window.location.href.includes('challenges.cloudflare.com'),
    { timeout: 5000 }
  ).catch(() => {});

  // Additional settle time for cookie write / redirect chain
  await new Promise(r => setTimeout(r, 500));

  return true;
}


async function findAcceptLanguage(page) {
  return await page.evaluate(async () => {
    const result = await fetch('https://httpbin.org/get')
      .then((res) => res.json())
      .then((res) => res.headers['Accept-Language'] || res.headers['accept-language'])
      .catch(() => null);
    return result;
  });
}

function getSource({ url, proxy }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject('Missing url parameter');

    const context = await global.browser
      .createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
      })
      .catch(() => null);

    if (!context) return reject('Failed to create browser context');

    let isResolved = false;

    const cl = setTimeout(async () => {
      if (!isResolved) {
        await context.close();
        reject('Timeout Error');
      }
    }, global.timeOut || 45000);

    infoLog(`[app] Request received for ${url} ...`)
    try {
      const page = await context.newPage();

      if (proxy?.username && proxy?.password)
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });

      let acceptLanguage = await findAcceptLanguage(page);

      await page.setRequestInterception(true);
      page.on('request', async (request) => request.continue());

      let capturedHeaders = null;
      page.on('response', async (res) => {
        try {
          if (
            [200, 302].includes(res.status()) &&
            [url, url + '/'].includes(res.url()) &&
            capturedHeaders === null
          ) {
            let headers = await res.request().headers();
            delete headers['content-type'];
            delete headers['accept-encoding'];
            delete headers['accept'];
            delete headers['content-length'];
            headers['accept-language'] = acceptLanguage;
            capturedHeaders = headers;
          }
        } catch (e) {}
      });

      await page.goto(url, { waitUntil: 'domcontentloaded' });

      await solveCloudflare(page).catch((err) => {
        warnLog('[solveCloudflare] Solver error:', err?.message || err);
      });

      if (!capturedHeaders) {
        capturedHeaders = { 'accept-language': acceptLanguage };
      }

      const cookies = await page.cookies();

      await context.close();
      isResolved = true;
      clearTimeout(cl);
      infoLog('[app] ✓ Session data extracted successfully.');
      resolve({ cookies, headers: capturedHeaders });

    } catch (e) {
      if (!isResolved) {
        await context.close();
        clearTimeout(cl);
        reject(e.message);
      }
    }
  });
}

module.exports = getSource;