// clickCheckbox.js
const { debugLog } = require('./logger'); 

// Use CDP Accessibility tree to find and click the Turnstile checkbox.
// This is the only approach that works without modifying page behaviour:
//   - Does NOT override attachShadow (which Cloudflare detects and rejects)
//   - Does NOT rely on pierce/ (which cannot reach closed shadow roots)
//   - Works across iframes and arbitrarily nested closed shadow roots
//   - Coordinates from DOM.getBoxModel are in the main page's document space,
//     so they work correctly whether the checkbox is on the page or in an iframe



// Traverse a CDP DOM node tree (returned by DOM.getDocument with pierce:true)
// looking for input[type=checkbox]. Returns ALL nodeIds found.
// MODIFIED: Skips checkboxes that have 'name' or 'id' attributes,
// since those belong to the site's native forms (e.g. "I agree to terms"),
// not to Cloudflare's injected Turnstile checkbox.

function findAllCheckboxNodeIds(node, results = []) {
  if (node.nodeName === 'INPUT') {
    const attrs = node.attributes || [];
    const typeIdx = attrs.indexOf('type');
    if (typeIdx !== -1 && attrs[typeIdx + 1] === 'checkbox') {
      const hasName = attrs.indexOf('name') !== -1;
      const hasId = attrs.indexOf('id') !== -1;
      if (!hasName && !hasId) {
        results.push(node.nodeId);
      }
    }
  }
  for (const child of node.children || []) {
    findAllCheckboxNodeIds(child, results);
  }
  for (const sr of node.shadowRoots || []) {
    findAllCheckboxNodeIds(sr, results);
  }
  return results;
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

async function clickCheckboxViaCDP(page, challengeTimeout = 15000) {
  // ── Step 1: interstitial — checkbox directly on main page ────────────────
  const pageClient = await page.createCDPSession();
  try {
    await pageClient.send('DOM.enable');
    const { root: pageRoot } = await pageClient.send('DOM.getDocument', { depth: -1, pierce: true });

    // MODIFIED: Find ALL candidate checkboxes (already filtered to exclude
    // site native ones that have name/id attributes).
    const checkboxNodeIds = findAllCheckboxNodeIds(pageRoot);

    // MODIFIED: Loop through all candidates instead of returning on the first.
    // This handles pages where the first checkbox found is hidden (display:none),
    // which would make getNodeCentre return null and previously caused an
    // immediate false return, trapping the solver in an infinite retry loop.
    for (const nodeId of checkboxNodeIds) {
      const centre = await getNodeCentre(pageClient, nodeId);
      if (!centre) {
        debugLog(`[clickCheckbox] Checkbox nodeId ${nodeId} on main page has no box model (hidden), skipping...`);
        continue;
      }

      debugLog('[clickCheckbox] Found visible interstitial checkbox on main page, nodeId:', nodeId);
      const { scrollX, scrollY, width, height } = await page.evaluate(() => ({
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const vx = centre.x - scrollX;
      const vy = centre.y - scrollY;
      const startX = width / 2; // Realistic start: viewport center
      const startY = height / 2;
      debugLog('[clickCheckbox] Clicking at viewport:', vx, vy);
      await page.mouse.move(vx, vy);
      // Bezier-like movement using Puppeteer's native API
      // const waypoints = generateBezierWaypoints(startX, startY, vx, vy);
      // for (const wp of waypoints) await page.mouse.move(wp.x, wp.y, { steps: 1 });
      // await new Promise(r => setTimeout(r, 40 + Math.random() * 60)); // Human hesitation
      await page.mouse.click(vx, vy);
      return true;
    }
  } finally {
    await pageClient.detach().catch(() => {});
  }

  // ── Step 2: Turnstile widget — checkbox inside cross-origin iframe ────────
  debugLog('[clickCheckbox] Not found on main page, waiting for challenge frame...');
  const frame = await waitForChallengeFrame(page, challengeTimeout);
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
    debugLog('[clickCheckbox] Could not find target anymore for frame URL:', frameUrl);
    return false;
  }

  const iframeClient = await iframeTarget.createCDPSession();
  try {
    await iframeClient.send('DOM.enable');
    const { root: iframeRoot } = await iframeClient.send('DOM.getDocument', { depth: -1, pierce: true });

    // MODIFIED: Find ALL candidate checkboxes inside the iframe.
    const checkboxNodeIds = findAllCheckboxNodeIds(iframeRoot);

    // MODIFIED: Loop through all candidates so we can skip hidden ones.
    for (const nodeId of checkboxNodeIds) {
      const { model } = await iframeClient.send('DOM.getBoxModel', { nodeId: nodeId })
        .catch(() => ({ model: null }));
      if (!model) {
        debugLog(`[clickCheckbox] Checkbox nodeId ${nodeId} in iframe has no box model (hidden), skipping...`);
        continue;
      }

      debugLog('[clickCheckbox] Found visible checkbox in iframe, nodeId:', nodeId);

      const checkboxIframeX = (model.content[0] + model.content[4]) / 2;
      const checkboxIframeY = (model.content[1] + model.content[5]) / 2;

      //const { scrollX, scrollY } = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }));
      const { scrollX, scrollY, width, height } = await page.evaluate(() => ({
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const x = iframeOffsetX + checkboxIframeX - scrollX;
      const y = iframeOffsetY + checkboxIframeY - scrollY;
      const startX = width / 2; // Realistic start: viewport center
      const startY = height / 2;

      debugLog('[clickCheckbox] Clicking at viewport:', x, y);
      await page.mouse.move(x, y);
      // const waypoints = generateBezierWaypoints(startX, startY, x, y);
      // for (const wp of waypoints) await page.mouse.move(wp.x, wp.y, { steps: 1 });
      // await new Promise(r => setTimeout(r, 50 + Math.random() * 70)); // Human hesitation
      await page.mouse.click(x, y);
      return true;
    }

    debugLog('[clickCheckbox] No visible checkbox found in iframe DOM');
    return false;

  } finally {
    await iframeClient.detach().catch(() => {});
  }
}

module.exports = { clickCheckboxViaCDP };