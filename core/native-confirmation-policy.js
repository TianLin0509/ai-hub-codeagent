'use strict';

// A receipt observation budget, never a limit on model execution. Expiry means
// unknown delivery/control state: retain the writer and accept matching late
// evidence; do not replay prompts or terminate the child because time elapsed.
const NATIVE_CONFIRMATION_MS = 60_000;

module.exports = { NATIVE_CONFIRMATION_MS };
