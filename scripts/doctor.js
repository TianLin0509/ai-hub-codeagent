'use strict';
// Source-install diagnostic. Exit 0 = runtime complete, 2 = something required is
// missing, 1 = the diagnostic itself failed. Never reads credentials.
try {
  const result = require('../core/community-setup').inspectSetup({ probePolicy: process.platform === 'win32' });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ready ? 0 : 2;
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 2, ready: false, error: error.message }));
  process.exitCode = 1;
}
