'use strict';

/**
 * Electron reports app.isPackaged=true when the stock executable is copied and
 * renamed, even when it is still acting as the default app host and receives
 * the real source app directory in argv. process.defaultApp is the reliable
 * discriminator for that source-mode launch.
 */
function isPackagedHubRuntime({ appIsPackaged = false, defaultApp = process.defaultApp } = {}) {
  return !!appIsPackaged && !defaultApp;
}

module.exports = { isPackagedHubRuntime };
