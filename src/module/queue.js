// queue.js
const { debugLog, infoLog, warnLog, errorLog } = require('../module/logger');
class RequestQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.useQueue = false;
  }

  async init() {
    let shouldUseQueue = false;
    let reason = '';

    // Check 1: Try to read from cloakbrowser binaryInfo
    try {
      const { binaryInfo } = await import('cloakbrowser');
      const info = await binaryInfo();
      
      debugLog('[queue] binaryInfo tier:', info?.tier);
      
      if (info?.tier === 'pro') {
        shouldUseQueue = true;
        reason = 'CloakBrowser Pro tier detected';
      }
    } catch (e) {
      debugLog('[queue] ⚠ Could not read binaryInfo:', e.message);
    }

    // Check 2: Fallback to environment variable
    if (!shouldUseQueue && process.env.CLOAKBROWSER_LICENSE_KEY) {
      shouldUseQueue = true;
      reason = 'CLOAKBROWSER_LICENSE_KEY environment variable set';
    }

    this.useQueue = shouldUseQueue;

    if (this.useQueue) {
      infoLog(`[queue] ✓ Sequential mode enabled (${reason})`);
    } else {
      infoLog('[queue] ✓ Concurrent mode enabled (no queue)');
    }
  }

  async enqueue(fn, moduleName = 'unknown') {
    if (!this.useQueue) {
      return fn();
    }

    const queueLength = this.queue.length;
    debugLog(`[queue] ${moduleName} - ${queueLength === 0 ? 'Starting immediately' : `Queued (position ${queueLength + 1})`}`);

    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, moduleName });
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const { fn, resolve, reject, moduleName } = this.queue.shift();

    debugLog(`[queue] ▶ Processing: ${moduleName}`);
    const startTime = Date.now();

    try {
      const result = await fn();
      debugLog(`[queue] ✓ ${moduleName} completed in ${Date.now() - startTime}ms`);
      resolve(result);
    } catch (error) {
      debugLog(`[queue] ✗ ${moduleName} failed in ${Date.now() - startTime}ms:`, error?.message || error);
      reject(error);
    } finally {
      this.isProcessing = false;
      this.processNext();
    }
  }
}

module.exports = new RequestQueue();