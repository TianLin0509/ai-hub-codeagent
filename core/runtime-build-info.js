'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
let cached;
function runtimeBuildInfo() {
  if (cached) return cached;
  const root = path.resolve(__dirname, '..');
  const hash = createHash('sha256');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  // The release version also covers transitive backend helpers. A fix to a
  // helper outside this source list must not leave an old broker immortal.
  hash.update(version);
  // Read once: changing package.json cannot change a process's loaded code.
  for (const file of ['core/codex-runtime-broker.js', 'core/codex-native-session.js',
    'core/codex-backstage.js', 'core/codex-backstage-store.js', 'main/codex-app-server-client.js',
    'core/claude-native-session.js', 'core/claude-broker-session.js',
    'core/shared-content-codec.js', 'main/codex-runtime-broker-process.js']) {
    hash.update(file).update(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'));
  }
  cached = Object.freeze({ version, fingerprint: hash.digest('hex') });
  return cached;
}
module.exports = { runtimeBuildInfo };
