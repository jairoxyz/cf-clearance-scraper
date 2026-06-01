// wafsession.js
async function findAcceptLanguage(page) {
  return await page.evaluate(() => {
    return navigator.language || 
           (navigator.languages && navigator.languages[0]) || 
           'en-US';
  });
}

async function waitForClearance(context, url, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const cookies = await context.cookies(url);
    if (cookies.some(c => c.name === 'cf_clearance')) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timeout waiting for cf_clearance after ${timeout}ms`);
}

/**
 * Merges response headers with missing request headers for WAF compatibility
 */
async function buildSessionHeaders(page, url, responseHeaders, cookies, userAgent) {
  const headers = { ...responseHeaders };
  let acceptLanguage = await findAcceptLanguage(page);

  // 1. User-Agent (Critical: request-only, never in response)
  headers['user-agent'] = userAgent;

  // 2. Standard Accept headers (often missing from responses)
  //   headers['accept'] = headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
  headers['accept-language'] = acceptLanguage;
  //   headers['cache-control'] = 'max-age=0'; // Standard for navigation requests

  // 3. Cookie header (constructed from CDP cookies, including HttpOnly)
  if (cookies.length > 0) {
    headers.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  // 4. Referer & Origin for subsequent requests
  headers.referer = headers.referer || url;
  headers.origin = headers.origin || new URL(url).origin;

  // 5. Client Hints (sec-ch-*)
  try {
    const hints = await page.evaluate(() => {
      const uaData = navigator.userAgentData;
      if (!uaData) return {};
      const brands = uaData.brands?.map(b => `"${b.brand}";v="${b.version}"`);
      return {
        'sec-ch-ua': brands?.join(', '),
        'sec-ch-ua-mobile': `?${uaData.mobile ? '1' : '0'}`,
        'sec-ch-ua-platform': `"${uaData.platform}"`,
        'sec-ch-ua-full-version-list': uaData.fullVersionList?.map(b => `"${b.brand}";v="${b.version}"`).join(', '),
        'sec-ch-ua-platform-version': uaData.platformVersion ? `"${uaData.platformVersion}"` : undefined,
        'sec-ch-ua-arch': uaData.architecture ? `"${uaData.architecture}"` : undefined,
      };
    });
    Object.assign(headers, Object.fromEntries(Object.entries(hints).filter(([, v]) => v)));
  } catch {}

  // 6. Standard Sec-Fetch headers
  headers['sec-fetch-dest'] = 'document';
  headers['sec-fetch-mode'] = 'navigate';
  headers['sec-fetch-site'] = 'same-origin';

  // 7. Clean hop-by-hop & response-only headers that break forwarding
  delete headers['set-cookie'];
  delete headers['content-length'];
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  delete headers['connection'];
  delete headers['server'];
  delete headers['date'];
  delete headers['host']; // Let HTTP client handle automatically

  return headers;
}

function getSource({ url, proxy }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");
    
    const context = await global.browser
      .createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
      })
      .catch(err => {
        console.error('[app] Context creation failed:', err);
        return null;
      });
      
    if (!context) return reject("Failed to create browser context");

    let isResolved = false;
    const timeoutMs = global.timeOut || 60000;
    
    const cl = setTimeout(async () => {
      if (!isResolved) {
        console.log('[app] Timeout reached, cleaning up...');
        await context.close().catch(() => {});
        reject("Timeout Error");
      }
    }, timeoutMs);

    console.log(`[app] Request received for ${url} ...`);

    try {
      const page = await context.newPage();
      if (proxy?.username && proxy?.password) {
        await page.authenticate({ username: proxy.username, password: proxy.password });
      }

      await page.setViewport({ width: 1920, height: 1080 });

      // Navigate & capture main response
      const mainResponse = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // wait for cf_clearance
      await waitForClearance(context, url, 30000);
      console.log('[app] ✓ cf_clearance detected via CDP');

      // Extract RESPONSE headers
      const responseHeaders = mainResponse ? mainResponse.request().headers() : {};
      const cookies = await context.cookies(url);
      const userAgent = await page.evaluate(() => navigator.userAgent);

      // Merge response headers with complete session request headers
      const headers = await buildSessionHeaders(page, url, responseHeaders, cookies, userAgent);

      isResolved = true;
      clearTimeout(cl);
      
      console.log('[app] ✓ Session data extracted successfully');
      resolve({ cookies, headers });

    } catch (e) {
      console.error('[app] Error in getSource:', e);
      if (!isResolved) {
        clearTimeout(cl);
        await context.close().catch(() => {});
        reject(e.message || "Unknown error in getSource");
      }
    } finally {
      if (isResolved) {
        await context.close().catch(() => {});
      }
    }
  });
}

module.exports = getSource;