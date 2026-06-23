const { debugLog, errorLog } = require('./logger'); 

// Traverse a CDP DOM node tree (returned by DOM.getDocument with pierce:true)
// looking for input[type=checkbox]. Returns the nodeId if found.


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

async function clickCheckboxViaCDP(page, challengeTimeout = 15000) {
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
      //const { scrollX, scrollY } = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }));
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
  } catch (e) {
    errorLog(e.message);
  
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

  } finally {
    await iframeClient.detach().catch(() => {});
  }
}

// Simulate random human-like mouse movement across the page before solving.
// Generates random waypoints within the visible viewport with random pauses.
// async function simulateHumanMouseMovement(page) {
//   try {
//     const { width, height } = await page.evaluate(() => ({
//       width:  window.innerWidth,
//       height: window.innerHeight,
//     }));
 
//     const moves = 2 + Math.floor(Math.random() * 4); // 2–5 movements
//     for (let i = 0; i < moves; i++) {
//       const x = Math.floor(50 + Math.random() * (width  - 100));
//       const y = Math.floor(50 + Math.random() * (height - 100));
//       const steps = 3 + Math.floor(Math.random() * 8); // 3–9 steps per move
//       await page.mouse.move(x, y, { steps });
//       await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 200)));
//     }
//   } catch (_) {}
// }

/**
 * Generate bezier-like waypoints between two points
 * Uses Puppeteer's native mouse.move() (CloakBrowser-compatible)
 */
// function generateBezierWaypoints(startX, startY, endX, endY, pointCount = 5) {
//   const waypoints = [];
  
//   // Randomized control points for natural curve variation
//   const cp1x = startX + (endX - startX) * (0.25 + Math.random() * 0.3);
//   const cp1y = startY + (endY - startY) * (0.1 + Math.random() * 0.4);
//   const cp2x = startX + (endX - startX) * (0.7 + Math.random() * 0.25);
//   const cp2y = startY + (endY - startY) * (0.6 + Math.random() * 0.35);
  
//   for (let i = 0; i <= pointCount; i++) {
//     const t = i / pointCount;
//     const t1 = 1 - t;
    
//     // Cubic bezier formula
//     const x = t1**3 * startX + 3 * t1**2 * t * cp1x + 3 * t1 * t**2 * cp2x + t**3 * endX;
//     const y = t1**3 * startY + 3 * t1**2 * t * cp1y + 3 * t1 * t**2 * cp2y + t**3 * endY;
    
//     waypoints.push({ x: Math.round(x), y: Math.round(y) });
//   }
  
//   return waypoints;
// }


module.exports = {
  clickCheckboxViaCDP
};