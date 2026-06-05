const LOG_VALUE = (process.env.LOG ?? process.env.DEBUG ?? '')
  .toString()
  .trim()
  .toLowerCase();

const DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes(LOG_VALUE);

function debugLog(...args) {
  if (DEBUG_ENABLED) console.log(...args);
}

function infoLog(...args) {
  console.log(...args);
}

function warnLog(...args) {
  console.warn(...args);
}

function errorLog(...args) {
  console.error(...args);
}

module.exports = { debugLog, infoLog, warnLog, errorLog, DEBUG_ENABLED };