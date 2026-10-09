'use strict';

function beginPromptDelivery(clientSubmissionId) {
  return { clientSubmissionId, status: 'pending', dismissed: false };
}

function applyPromptReceipt(state, receipt) {
  if (!state || !receipt || state.clientSubmissionId !== receipt.clientSubmissionId) return false;
  if (state.status === 'confirmed' || state.status === 'content-mismatch') return false;
  if (!['confirmed', 'unconfirmed', 'queued', 'failed', 'content-mismatch'].includes(receipt.status)) return false;
  state.status = receipt.status;
  return true;
}

module.exports = { beginPromptDelivery, applyPromptReceipt };
