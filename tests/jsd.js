




async function solveJSD(targetUrl) {    

    let _launch;
    async function getLaunch() {
    if (!_launch) ({ launch: _launch } = await import('cloakbrowser/puppeteer'));
    return _launch;
    }


    const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            `--fingerprint=12345`,
        ];

    const launch = await getLaunch();

    const browser = await launch({
        // Essential flags
        headless: false,              // JSD may detect headless Chromium [[1]]
        //proxy: 'http://user:pass@residential-proxy:port',  // Residential IP required
        geoip: true,                  // Auto-match timezone/locale to proxy IP [[1]]
        humanize: true,               // Human-like mouse/keyboard behavior [[1]]
        humanPreset: 'careful',
        
        // Optional: fixed fingerprint for returning visitor behavior
        args: args,
    });


    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // ✅ Reliable clearance detection
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('JSD timeout')), 30000);
            const check = setInterval(async () => {
                const cookies = await browser.cookies();
                if (cookies.some(c => c.name === 'cf_clearance')) {
                    clearTimeout(timeout);
                    clearInterval(check);
                    resolve();
                }
            }, 500);
        });

        const cookies = await browser.cookies();
        const clearance = cookies.find(c => c.name === 'cf_clearance');
        
        console.log('✓ cf_clearance:', clearance.value);
        return { cf_clearance: clearance.value, userAgent: await browser.userAgent() };

    } finally {
        await browser.close();
    }

}

await solveJSD("https://gupload.xyz/data/e/8cfc402477b9");