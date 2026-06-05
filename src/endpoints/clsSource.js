const { debug } = require('puppeteer-core');
const { debugLog, infoLog, warnLog, errorLog } = require('../module/logger');

const CHALLENGE_TITLES = ['Just a moment...',
  'Please Wait... | Cloudflare',
  'Cloudflare Turnstile demo: Sample Form with Cloudflare Turnstile',
  'Maintenance - GUpload',
];


function findCheckboxNodeId(node) {
  if (node.nodeName === 'INPUT') {
    const attrs = node.attributes || [];
    const typeIdx = attrs.indexOf('type');
    if (typeIdx !== -1 && attrs[typeIdx + 1] === 'checkbox') {
      return node.nodeId;
    }
  }
  for (const child of node.children || []) {
    const found = findCheckboxNodeId(child);
    if (found) return found;
  }
  for (const sr of node.shadowRoots || []) {
    const found = findCheckboxNodeId(sr);
    if (found) return found;
  }
  return null;
}

function findIframeNodeId(node) {
  if (node.nodeName === 'IFRAME') return node.nodeId;
  for (const child of node.children || []) {
    const found = findIframeNodeId(child);
    if (found) return found;
  }
  for (const sr of node.shadowRoots || []) {
    const found = findIframeNodeId(sr);
    if (found) return found;
  }
  return null;
}

async function waitForChallengeFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      
      const url = frame.url();
      if (!url || url === 'about:blank') continue; // <-- key fix

      await frame.evaluate(() => new Promise(res => {
        if (document.readyState !== 'loading') return res();
        document.addEventListener('DOMContentLoaded', res, { once: true });
      })).catch(() => {});
      return frame;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function getNodeCentre(client, nodeId) {
  await client.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
  const { model } = await client.send('DOM.getBoxModel', { nodeId })
    .catch(() => ({ model: null }));
  if (!model) return null;
  return {
    x: (model.content[0] + model.content[4]) / 2,
    y: (model.content[1] + model.content[5]) / 2,
  };
}

async function clickCheckboxViaCDP(page) {
  // ── Step 1: interstitial — checkbox directly on main page ────────────────
  const pageClient = await page.createCDPSession();
  try {
    await pageClient.send('DOM.enable');
    const { root: pageRoot } = await pageClient.send('DOM.getDocument', { depth: -1, pierce: true });

    const nodeId = findCheckboxNodeId(pageRoot);
    if (nodeId) {
      debugLog('[clickCheckbox] Found checkbox on main page, nodeId:', nodeId);
      const centre = await getNodeCentre(pageClient, nodeId);
      if (!centre) return false;
      const { scrollX, scrollY } = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }));
      const vx = centre.x - scrollX;
      const vy = centre.y - scrollY;
      debugLog('[clickCheckbox] Clicking at viewport:', vx, vy);
      await page.mouse.move(vx, vy);
      await page.mouse.click(vx, vy);
      return true;
    }
  } finally {
    await pageClient.detach().catch(() => {});
  }

  // ── Step 2: Turnstile widget — checkbox inside cross-origin iframe ────────
  debugLog('[clickCheckbox] Not found on main page, waiting for challenge frame...');
  const frame = await waitForChallengeFrame(page);
  if (!frame) { debugLog('[clickCheckbox] No challenge frame found'); return false; }
  debugLog('[clickCheckbox] Using frame:', frame.url());

  const pageClient2 = await page.createCDPSession();
  let iframeOffsetX = 0;
  let iframeOffsetY = 0;
  try {
    await pageClient2.send('DOM.enable');
    const { root } = await pageClient2.send('DOM.getDocument', { depth: -1, pierce: true });
    const iframeNodeId = findIframeNodeId(root);
    if (iframeNodeId) {
      const { model } = await pageClient2.send('DOM.getBoxModel', { nodeId: iframeNodeId })
        .catch(() => ({ model: null }));
      if (model) {
        iframeOffsetX = model.content[0];
        iframeOffsetY = model.content[1];
        debugLog('[clickCheckbox] Iframe offset in main page:', iframeOffsetX, iframeOffsetY);
      }
    } else {
      debugLog('[clickCheckbox] Iframe element not found in page DOM — offset defaults to 0,0');
    }
  } finally {
    await pageClient2.detach().catch(() => {});
  }

  const frameUrl = frame.url();
  const iframeTarget = page.browser().targets().find(t => t.url() === frameUrl);
  if (!iframeTarget) {
    debugLog('[clickCheckbox] Could not find Target for frame URL:', frameUrl);
    return false;
  }

  const iframeClient = await iframeTarget.createCDPSession();
  try {
    await iframeClient.send('DOM.enable');
    const { root: iframeRoot } = await iframeClient.send('DOM.getDocument', { depth: -1, pierce: true });
    const checkboxNodeId = findCheckboxNodeId(iframeRoot);
    if (!checkboxNodeId) {
      debugLog('[clickCheckbox] No checkbox found in iframe DOM');
      return false;
    }
    debugLog('[clickCheckbox] Found checkbox in iframe, nodeId:', checkboxNodeId);

    const { model } = await iframeClient.send('DOM.getBoxModel', { nodeId: checkboxNodeId })
      .catch(() => ({ model: null }));
    if (!model) { debugLog('[clickCheckbox] Could not get iframe checkbox box model'); return false; }

    const checkboxIframeX = (model.content[0] + model.content[4]) / 2;
    const checkboxIframeY = (model.content[1] + model.content[5]) / 2;

    const { scrollX, scrollY } = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }));
    const x = iframeOffsetX + checkboxIframeX - scrollX;
    const y = iframeOffsetY + checkboxIframeY - scrollY;

    debugLog('[clickCheckbox] Clicking at viewport:', x, y);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    return true;

  } finally {
    await iframeClient.detach().catch(() => {});
  }
}

// Simulate random human-like mouse movement across the page before solving.
// Generates random waypoints within the visible viewport with random pauses.
async function simulateHumanMouseMovement(page) {
  try {
    const { width, height } = await page.evaluate(() => ({
      width:  window.innerWidth,
      height: window.innerHeight,
    }));
 
    const moves = 2 + Math.floor(Math.random() * 4); // 2–5 movements
    for (let i = 0; i < moves; i++) {
      const x = Math.floor(50 + Math.random() * (width  - 100));
      const y = Math.floor(50 + Math.random() * (height - 100));
      const steps = 3 + Math.floor(Math.random() * 8); // 3–9 steps per move
      await page.mouse.move(x, y, { steps });
      await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 200)));
    }
  } catch (_) {}
}

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
      debugLog('[solveCloudflare] CDP error:', err?.message || String(err));
      return false;
    });

    if (!clicked) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    // 3) After click: wait briefly for title to change away from challenge titles
    try {
      // waitForFunction waits until the function becomes truthy or timeout occurs. 【1-0c7b5e】
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

      await page.setRequestInterception(true);
      page.on('request', async (request) => request.continue());

      let responseReceived = false;
      page.on('response', async (res) => {
        try {
          if (
            [200, 302].includes(res.status()) &&
            [url, url + '/'].includes(res.url()) &&
            !responseReceived
          ) {
            responseReceived = true;
            // Headers captured for logging/debugging only (not returned)
            let headers = await res.request().headers();
            debugLog('[app] Response captured:', res.status(), res.url());
          }
        } catch (e) {}
      });

      // Navigate to target
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await solveCloudflare(page).catch((err) => {
        warnLog('[solveCloudflare] Solver error:', err?.message || err);
      });

      // Small buffer for dynamic content to render
      //await new Promise(r => setTimeout(r, 1500));

      // Return page content instead of headers/cookies
      const html = await page.content();

      await context.close();
      isResolved = true;
      clearTimeout(cl);
      
      infoLog('[app] ✓ Page content extracted successfully.');
      resolve(html);

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