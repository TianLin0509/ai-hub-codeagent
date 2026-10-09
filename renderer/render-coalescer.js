'use strict';

function createRenderCoalescer(render, options = {}) {
  if (typeof render !== 'function') throw new TypeError('render must be a function');
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  let timer = null;
  let requests = 0;
  let renders = 0;

  function run() {
    timer = null;
    renders += 1;
    render();
  }

  function schedule() {
    requests += 1;
    if (timer !== null) return;
    timer = setTimer(run, delayMs);
  }

  function flush() {
    if (timer === null) return false;
    clearTimer(timer);
    run();
    return true;
  }

  function cancel() {
    if (timer === null) return false;
    clearTimer(timer);
    timer = null;
    return true;
  }

  function stats() {
    return { requests, renders, pending: timer !== null, delayMs };
  }

  return { schedule, flush, cancel, stats };
}

module.exports = { createRenderCoalescer };
