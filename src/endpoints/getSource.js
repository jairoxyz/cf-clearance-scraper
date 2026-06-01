// getSource with JSD challenge solver added

async function waitForClearance(context, url, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const cookies = await context.cookies(url);
    if (cookies.some(c => c.name === 'cf_clearance')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timeout waiting for cf_clearance');
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

    console.log(`[app] Request received for ${url} ...`);

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

        // ✅ ORIGINAL NON-JSD FLOW (adapted to return HTML content)
        if (
          [200, 302].includes(res.status()) &&
          [url, url + "/"].includes(res.url())
        ) {
          await page.waitForNavigation({ waitUntil: "load", timeout: 5000 }).catch(() => {});
          
          // ✅ Return page content instead of headers/cookies
          const html = await page.content();

          // Signal detection is done (non-JSD path) so we don't wait 5s unnecessarily
          if (!jsdDetected) resolveDetection(false);

          await context.close();
          isResolved = true;
          clearTimeout(cl);

          console.log('[app] ✓ Page content extracted successfully');
          resolve(html);
        }
      };

      page.on("response", respHandler);

      // Initial navigate 
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for async detection to settle
      const hasJSD = await detectionPromise;

      // Branch to JSD flow if detected & not already resolved
      if (hasJSD && !isResolved) {
        console.log('[app] JSD detected. Disabling interception & reloading...');
        
        // Cleanly disable interception & remove listeners
        await page.setRequestInterception(false);
        page.off("request", reqHandler);
        page.off("response", respHandler);
        
        // Reload normally (JSD runs freely without CDP interception overhead)
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait for cf_clearance
        await waitForClearance(context, url, 30000);
        console.log('[app] ✓ cf_clearance detected via CDP');

        // ✅ Small buffer for DOM to fully render post-challenge
        await new Promise(r => setTimeout(r, 1000));
        
        // ✅ Return page content instead of headers/cookies
        const html = await page.content();

        isResolved = true;
        clearTimeout(cl);
        await context.close();

        console.log('[app] ✓ Page content extracted successfully');
        resolve(html);
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