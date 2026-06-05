// wafsession for CF challenges incl. JSD

const { debugLog, infoLog } = require('../module/logger');

async function findAcceptLanguage(page) {
  return await page.evaluate(() => 
    navigator.language || navigator.languages?.[0] || 'en-US'
  );
}

async function waitForClearance(context, url, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const cookies = await context.cookies(url);
    if (cookies.some(c => c.name === 'cf_clearance')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timeout waiting for cf_clearance');
}

// build session headers for non request interception JSD flow
async function buildSessionHeaders(page, url, responseHeaders, cookies, userAgent) {
  const headers = { ...responseHeaders };
  const targetUrl = new URL(url);

  // User-Agent and accept headers
  headers['user-agent'] = userAgent;
  headers['accept'] = headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  headers['accept-language'] = headers['accept-language'] || await findAcceptLanguage(page);
  headers['cache-control'] = 'max-age=0';

  // header cookie
  if (cookies.length > 0) {
    headers.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  // referer anmd origin
  headers.referer = headers.referer || url;
  headers.origin = headers.origin || targetUrl.origin;

  // Client Hints (sec-ch-*)
  try {
    const uaData = await page.evaluate(() => {
      const d = navigator.userAgentData;
      if (!d) return null;
      return {
        brands: d.brands, mobile: d.mobile, platform: d.platform,
        fullVersionList: d.fullVersionList, platformVersion: d.platformVersion,
        architecture: d.architecture, bitness: d.bitness, model: d.model
      };
    });
    if (uaData?.brands) {
      headers['sec-ch-ua'] = uaData.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
      headers['sec-ch-ua-mobile'] = `?${uaData.mobile ? '1' : '0'}`;
      if (uaData.platform) headers['sec-ch-ua-platform'] = `"${uaData.platform}"`;
      if (uaData.fullVersionList) headers['sec-ch-ua-full-version-list'] = uaData.fullVersionList.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
      if (uaData.platformVersion) headers['sec-ch-ua-platform-version'] = `"${uaData.platformVersion}"`;
      if (uaData.architecture) headers['sec-ch-ua-arch'] = `"${uaData.architecture}"`;
      if (uaData.bitness) headers['sec-ch-ua-bitness'] = `"${uaData.bitness}"`;
      if (uaData.model) headers['sec-ch-ua-model'] = `"${uaData.model}"`;
    }
  } catch {}

  // Standard Sec-Fetch headers
  headers['sec-fetch-dest'] = 'document';
  headers['sec-fetch-mode'] = 'navigate';
  headers['sec-fetch-site'] = 'same-origin';

  // Clean hop-by-hop & response-only headers that break forwarding
  delete headers['content-length'];
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  delete headers['connection'];
  delete headers['server'];
  delete headers['date'];
  delete headers['host'];

  return headers;
}

function getSource({ url, proxy }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");
    
    const context = await global.browser
      .createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
      })
      .catch(() => null);
      
    if (!context) return reject("Failed to create browser context");

    let isResolved = false;
    const cl = setTimeout(async () => {
      if (!isResolved) {
        await context.close().catch(() => {});
        reject("Timeout Error");
      }
    }, global.timeOut || 60000);

    infoLog(`[app] Request received for ${url} ...`);

    try {
      const page = await context.newPage();
      if (proxy?.username && proxy?.password) {
        await page.authenticate({ username: proxy.username, password: proxy.password });
      }
      await page.setViewport({ width: 1920, height: 1080 });

      // Enable interception as in original code
      await page.setRequestInterception(true);
      const reqHandler = (req) => req.continue().catch(() => {});
      page.on("request", reqHandler);

      // JSD Detection state & promise (properly scoped)
      let jsdDetected = false;
      let resolveDetection;
      const detectionPromise = new Promise((res) => {
        resolveDetection = res;
        // Auto-resolve false after 5s if no JSD signals found
        setTimeout(() => {
          if (!jsdDetected) resolveDetection(false);
        }, 5000);
      });

      // Response handler: JSD detection + EXACT original non-JSD flow
      const respHandler = async (res) => {
        if (isResolved) return;

        // fast JSD URL detection
        const isJSDUrl = res.url().includes('/cdn-cgi/challenge-platform/') && 
                         (res.url().includes('/scripts/jsd/') || res.url().includes('/jsd/oneshot/'));
        if (isJSDUrl) {
          jsdDetected = true;
          resolveDetection(true);
          return;
        }

        // fallback JSD content detection (document only)
        if (res.request().resourceType() === 'document' && res.status() === 200) {
          try {
            const html = await res.text();
            if (/\/scripts\/jsd\/[^"']+\/main\.js/.test(html) || /\/jsd\/oneshot\//.test(html)) {
              jsdDetected = true;
              resolveDetection(true);
              return;
            }
          } catch {}
        }

        // ORIGINAL NON-JSD FLOW 
        if (
          [200, 302].includes(res.status()) &&
          [url, url + "/"].includes(res.url())
        ) {
          await page.waitForNavigation({ waitUntil: "load", timeout: 5000 }).catch(() => {});
          const cookies = await context.cookies(url);
          // get headers from intercepted response request
          let headers = await res.request().headers();
          delete headers["content-type"];
          delete headers["accept-encoding"];
          delete headers["accept"];
          delete headers["content-length"];
          headers["accept-language"] = await findAcceptLanguage(page);

          // Signal detection is done (non-JSD path) so we don't wait 5s unnecessarily
          if (!jsdDetected) resolveDetection(false);

          await context.close();
          isResolved = true;
          clearTimeout(cl);

          infoLog('[app] ✓ Session data extracted successfully');
          resolve({ cookies, headers });
        }
      };

      page.on("response", respHandler);

      // Initial navigate 
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for async detection to settle
      const hasJSD = await detectionPromise;

      // Branch to JSD flow if detected & not already resolved
      if (hasJSD && !isResolved) {
        debugLog('[app] JSD detected. Disabling interception & reloading...');
        
        // Cleanly disable interception & remove listeners
        await page.setRequestInterception(false);
        page.off("request", reqHandler);
        page.off("response", respHandler);
        
        // Reload normally (JSD runs freely without CDP interception overhead)
        const mainResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for cf_clearance
        await waitForClearance(context, url, 30000);
        debugLog('[app] CF_CLEARANCE detected via CDP');

        const responseHeaders = mainResponse ? await mainResponse.request().headers() : {};
        const cookies = await context.cookies(url);
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const headers = await buildSessionHeaders(page, url, responseHeaders, cookies, userAgent);

        isResolved = true;
        clearTimeout(cl);
        await context.close();

        infoLog('[app] ✓ Session data extracted successfully.');
        resolve({ cookies, headers });
      }
      // If !hasJSD, the original respHandler already resolved or will resolve

    } catch (e) {
      if (!isResolved) {
        clearTimeout(cl);
        await context.close().catch(() => {});
        reject(e.message || "Unknown error in getSource");
      }
    }
  });
}

module.exports = getSource;