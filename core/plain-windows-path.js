'use strict';

// Rust canonicalize (Codex hooks) reports the extended spelling \\?\C:\... for
// the same file other code records as C:\... . A path is a session identity, so
// every comparison must see one spelling; UNC keeps its \\server\share form.
function plainWindowsPath(value) {
  if (typeof value !== 'string' || !value.startsWith('\\\\?\\')) return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return '\\\\' + value.slice(8);
  return /^[A-Za-z]:\\/.test(value.slice(4)) ? value.slice(4) : value;
}

module.exports = { plainWindowsPath };
