const { clickCheckboxViaCDP } = require("../module/clickCheckbox");
const { debugLog, infoLog, errorLog } = require('../module/logger');

function solveTurnstileMax({ url, proxy }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

    const context = await global.browser
      .createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
      })
      .catch(() => null);

    if (!context) return reject("Failed to create browser context");

    let isResolved = false;

    var cl = setTimeout(async () => {
      if (!isResolved) {
        await context.close();
        reject("Timeout Error");
      }
    }, global.timeOut || 30000);

    infoLog(`[app] Request received for ${url} ...`)

    try {
      const page = await context.newPage();

      if (proxy?.username && proxy?.password)
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
        
      // Inject script to poll the Turnstile JS API directly
      await page.evaluateOnNewDocument(() => {
        let token = null;
        async function waitForToken() {
          while (!token) {
            try {
              // Added a safety check to ensure the turnstile object exists before calling getResponse()
              //if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                token = window.turnstile.getResponse();
              //}
            } catch (e) {}
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          var c = document.createElement("input");
          c.type = "hidden";
          c.name = "cf-response";
          c.value = token;
          document.body.appendChild(c);
        }
        waitForToken();
      });

      await page.goto(url, {
        waitUntil: "domcontentloaded",
      });

      // ── Polling Loop ────────────────────────────────────────────────
      const maxMs = global.timeOut || 30000;
      const deadline = Date.now() + maxMs;
      let token = null;
      let attempts = 0;

      while (Date.now() < deadline) {
        token = await page.evaluate(() => {
          try {
            const el = document.querySelector('[name="cf-response"]');
            return el ? el.value : null;
          } catch (e) {
            return null;
          }
        }).catch(() => null);

        // If we successfully grabbed a valid token, break out
        if (token && token.length > 10) {
          //console.log("[solveTurnstileMax] Token found in DOM!");
          break;
        }

        attempts++;
        
        // Wait ~10 seconds before attempting to click. 
        // This gives Managed/Invisible challenges time to auto-solve.
        if (attempts >= 7) {
          debugLog('[solveTurnstileMin] Challenge not auto-solved, trying to click checkbox ...');
          await clickCheckboxViaCDP(page, 2000).catch(err => {
              errorLog('[solveTurnstileMin] Click solver error:', err.message);
              return false;
          });
        }

        await new Promise(r => setTimeout(r, 1000));
      }

      isResolved = true;
      clearTimeout(cl);
      await context.close();
      
      if (!token || token.length < 10) return reject("[solveTurnstileMax] Failed to get token");
      
      infoLog("[solveTurnstileMax] Token solved successfully.");
      return resolve(token);
    } catch (e) {
      console.log(e);

      if (!isResolved) {
        await context.close();
        clearTimeout(cl);
        reject(e.message);
      }
    }
  });
}

module.exports = solveTurnstileMax;