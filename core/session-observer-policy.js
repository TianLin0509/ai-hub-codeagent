'use strict';
// Common policy for native session views. Provider protocols still own their
// exact submission/approval identities; observing cannot acquire side effects.
function isSessionViewer(session) {
  return (session?.nativeSharedControl || session?.codexSharedControl)?.role === 'viewer';
}
module.exports = { isSessionViewer };
