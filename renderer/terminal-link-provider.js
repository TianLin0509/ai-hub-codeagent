const {
  collectPathCandidates,
  _cleanPathCandidate,
} = require('./path-candidates.js');

function _fallbackLineTextMetrics(text) {
  const startColumns = [];
  const endColumns = [];
  for (let index = 0; index < text.length; index += 1) {
    startColumns[index] = index + 1;
    endColumns[index] = index + 1;
  }
  return { startColumns, endColumns, usedColumns: text.length };
}

// xterm link ranges use terminal cells, not JavaScript UTF-16 offsets. Chinese
// glyphs are normally two cells, combining sequences can share one cell, and a
// surrogate pair may still occupy two cells. BufferCell is authoritative after
// ConPTY/xterm layout, so derive coordinates from it. The fallback keeps the
// old behavior for lightweight test doubles and older xterm line objects.
function _lineTextMetrics(line, text, cols) {
  text = String(text || '');
  if (!line || typeof line.getCell !== 'function') return _fallbackLineTextMetrics(text);
  const startColumns = [];
  const endColumns = [];
  let offset = 0;
  let usedColumns = 0;
  const maxCols = Math.max(0, Number(cols) || 0);
  for (let cellIndex = 0; cellIndex < maxCols && offset < text.length; cellIndex += 1) {
    const cell = line.getCell(cellIndex);
    if (!cell) continue;
    const rawWidth = typeof cell.getWidth === 'function' ? Number(cell.getWidth()) : 1;
    if (rawWidth === 0) continue;
    const width = Math.max(1, Number.isFinite(rawWidth) ? rawWidth : 1);
    let chars = typeof cell.getChars === 'function' ? String(cell.getChars() || '') : '';
    if (!chars) chars = text[offset] === ' ' ? ' ' : String.fromCodePoint(text.codePointAt(offset));
    if (!text.startsWith(chars, offset)) {
      // Defensive fallback for a future xterm normalization difference. Keep
      // progressing by one displayed code point instead of shifting all later
      // ranges or returning an invalid link.
      chars = String.fromCodePoint(text.codePointAt(offset));
    }
    const endX = cellIndex + width;
    for (let unit = 0; unit < chars.length && offset + unit < text.length; unit += 1) {
      startColumns[offset + unit] = cellIndex + 1;
      endColumns[offset + unit] = endX;
    }
    offset += chars.length;
    usedColumns = Math.max(usedColumns, endX);
  }
  if (offset < text.length) {
    let nextColumn = usedColumns + 1;
    for (; offset < text.length; offset += 1, nextColumn += 1) {
      startColumns[offset] = nextColumn;
      endColumns[offset] = nextColumn;
    }
    usedColumns = endColumns.at(-1) || usedColumns;
  }
  return { startColumns, endColumns, usedColumns };
}

// When a width-2 glyph cannot fit in the final remaining terminal cell,
// ConPTY emits one explicit blank cell and continues the glyph on the wrapped
// row. xterm preserves that blank in translateToString(true), even though it is
// layout padding rather than a real space in the path. Remove exactly that
// one-cell pattern; genuine spaces elsewhere (including "My Report") remain.
function _trimWideWrapPadding(line, nextLine, text, cols) {
  text = String(text || '');
  if (!text.endsWith(' ') || !nextLine || nextLine.isWrapped !== true) return text;
  if (!line || typeof line.getCell !== 'function' || typeof nextLine.getCell !== 'function') return text;
  const lastCell = line.getCell(Math.max(0, Number(cols) - 1));
  const nextCell = nextLine.getCell(0);
  const lastWidth = lastCell && typeof lastCell.getWidth === 'function' ? Number(lastCell.getWidth()) : 0;
  const lastChars = lastCell && typeof lastCell.getChars === 'function' ? String(lastCell.getChars() || '') : '';
  const nextWidth = nextCell && typeof nextCell.getWidth === 'function' ? Number(nextCell.getWidth()) : 0;
  if (lastWidth === 1 && !lastChars.trim() && nextWidth === 2) return text.slice(0, -1);
  return text;
}

function createTerminalLinkRegistrar({ getCwd, openPathInHub, onContextMenu, onError }) {
  const activeLinkGroups = new Map();

  function registerLinkInGroup(fullPath, link) {
    let set = activeLinkGroups.get(fullPath);
    if (!set) { set = new Set(); activeLinkGroups.set(fullPath, set); }
    set.add(link);
  }

  function unregisterLinkFromGroup(fullPath, link) {
    const set = activeLinkGroups.get(fullPath);
    if (!set) return;
    set.delete(link);
    if (set.size === 0) activeLinkGroups.delete(fullPath);
  }

  function setGroupUnderline(fullPath, value) {
    const set = activeLinkGroups.get(fullPath);
    if (!set) return;
    for (const link of set) {
      if (link.decorations) link.decorations.underline = value;
    }
  }

  function registerLocalPathLinks(terminal, sessionId) {
    // A visual wrap often lands exactly after '/', '\\', '?', '&' or '='.
    // Those are valid URL/path continuation characters; rejecting them before
    // the shared candidate parser sees the joined token splits valid links.
    const LINK_BOUNDARY_RE = /[^\r\n\s'"`<>|]/;
    let provider = null;
    let hoveredLink = null;
    let pressedLink = null;
    let attachedElement = null;
    let renderDisposable = null;
    let providerRegistration = null;
    let disposed = false;
    const ownedLinks = new Set();
    const activationStats = {
      activations: 0,
      fallbackActivations: 0,
      hovers: 0,
      leaves: 0,
      failures: 0,
    };

    const releasePressedLink = (pressed = pressedLink) => {
      if (pressed && pressed.manuallyResolved) pressed.link.dispose?.();
      if (pressed === pressedLink) pressedLink = null;
    };
    const resolveLinkAtEvent = (event) => {
      try {
        const mouseService = terminal._core?._mouseService || terminal._core?._linkifier?._mouseService;
        const element = terminal.element;
        if (!provider || !mouseService || !element) return null;
        const coords = mouseService.getCoords(event, element, terminal.cols, terminal.rows);
        if (!coords) return null;
        const position = {
          x: coords[0],
          y: coords[1] + (Number(terminal.buffer.active.viewportY) || 0),
        };
        let selected = null;
        provider.provideLinks(position.y, (links) => {
          for (const link of links || []) {
            const start = link.range.start.y * terminal.cols + link.range.start.x;
            const end = link.range.end.y * terminal.cols + link.range.end.x;
            const point = position.y * terminal.cols + position.x;
            if (!selected && start <= point && point <= end) selected = link;
            else link.dispose?.();
          }
        });
        return selected;
      } catch (error) {
        console.debug('[terminal-link] pointer revalidation skipped:', error && error.message);
        return null;
      }
    };
    const capturePressedLink = (event) => {
      if (event.button !== 0) return;
      const revalidated = resolveLinkAtEvent(event);
      const link = revalidated || (hoveredLink && !hoveredLink._disposed ? hoveredLink : null);
      if (!link) return;
      pressedLink = {
        link,
        activationCount: activationStats.activations,
        manuallyResolved: !!revalidated,
        x: Number(event.clientX) || 0,
        y: Number(event.clientY) || 0,
      };
    };
    const onPointerDown = (event) => {
      releasePressedLink();
      capturePressedLink(event);
    };
    const onMouseDown = (event) => {
      // A preceding PointerEvent already froze the link before focus redraw.
      if (pressedLink) return;
      releasePressedLink();
      capturePressedLink(event);
    };
    const onClick = (event) => {
      const pressed = pressedLink;
      pressedLink = null;
      if (!pressed || event.button !== 0) return;
      if (Math.abs((Number(event.clientX) || 0) - pressed.x) > 5
          || Math.abs((Number(event.clientY) || 0) - pressed.y) > 5) {
        releasePressedLink(pressed);
        return;
      }
      const eventSnapshot = {
        button: 0,
        clientX: Number(event.clientX) || 0,
        clientY: Number(event.clientY) || 0,
        ctrlKey: !!event.ctrlKey,
        altKey: !!event.altKey,
        metaKey: !!event.metaKey,
        shiftKey: !!event.shiftKey,
      };
      // xterm 5.5 requires the exact same current-link wrapper on mousedown and
      // mouseup. Revalidate the real buffer cell on pointerdown, let xterm run
      // first, then fall back only when no activation occurred anywhere.
      setTimeout(() => {
        if (disposed || pressed.link._disposed || activationStats.activations !== pressed.activationCount) {
          releasePressedLink(pressed);
          return;
        }
        activationStats.fallbackActivations += 1;
        void Promise.resolve(pressed.link.activate(eventSnapshot)).finally(() => releasePressedLink(pressed));
      }, 0);
    };
    const attachElement = () => {
      const element = terminal.element;
      if (disposed || !element || attachedElement === element) return false;
      if (attachedElement) {
        attachedElement.removeEventListener('pointerdown', onPointerDown, true);
        attachedElement.removeEventListener('mousedown', onMouseDown, true);
        attachedElement.removeEventListener('click', onClick, true);
      }
      attachedElement = element;
      // pointerdown fires before focus can redraw the cursor and emit
      // link.leave. Keep mousedown as a compatibility fallback for runtimes
      // without PointerEvent support.
      attachedElement.addEventListener('pointerdown', onPointerDown, true);
      attachedElement.addEventListener('mousedown', onMouseDown, true);
      // Capture is intentional. xterm's own Web/OSC link handlers can stop a
      // bubbling click after focus redraw. Freezing the Hub link first makes a
      // normal single click as reliable as the card-view path handler.
      attachedElement.addEventListener('click', onClick, true);
      return true;
    };
    const isHeuristicCont = (prevLine, currentLine) => {
      if (!prevLine || !currentLine) return false;
      const cols = terminal.cols;
      const prevTrim = _trimWideWrapPadding(
        prevLine,
        currentLine,
        prevLine.translateToString(true),
        cols,
      );
      const prevMetrics = _lineTextMetrics(prevLine, prevTrim, cols);
      const prevLast = prevTrim[prevTrim.length - 1];
      const curRaw = currentLine.translateToString(false);
      const curTokenMatch = curRaw.match(/^\s*([^\s'"`<>|]+)/);
      const curFirst = curTokenMatch && curTokenMatch[1] ? curTokenMatch[1][0] : null;
      if (!(prevLast && curFirst
        && LINK_BOUNDARY_RE.test(prevLast)
        && LINK_BOUNDARY_RE.test(curFirst))) return false;

      if (prevMetrics.usedColumns >= cols) return true;

      const prevToken = (prevTrim.match(/[^\s'"`<>|]+$/) || [''])[0];
      const curToken = curTokenMatch && curTokenMatch[1] ? curTokenMatch[1] : '';
      if (!prevToken || !curToken) return false;
      const joined = _cleanPathCandidate(prevToken + curToken);
      const cwd = typeof getCwd === 'function' ? getCwd(sessionId) : null;
      if (collectPathCandidates(joined, cwd).length === 0) return false;

      const nearRightEdge = prevMetrics.usedColumns >= Math.max(20, cols - 8);
      // Without xterm's isWrapped flag, proximity to the right edge is the
      // evidence that this was a visual wrap. A path-looking token alone is not
      // enough: otherwise the next independent output line gets swallowed into
      // a perfectly valid but incorrect URL/path.
      return nearRightEdge;
    };

    provider = {
      provideLinks(lineNumber, callback) {
        const buf = terminal.buffer.active;
        const line = buf.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }

        let groupIdx = lineNumber - 1;
        while (groupIdx > 0) {
          const cur = buf.getLine(groupIdx);
          if (cur && cur.isWrapped) { groupIdx--; continue; }
          const prev = buf.getLine(groupIdx - 1);
          if (isHeuristicCont(prev, cur)) { groupIdx--; continue; }
          break;
        }
        const groupLine = groupIdx + 1;

        let text = '';
        const lineWidths = [];
        const linePrefixSkips = [];
        const lineColumnMaps = [];
        for (let i = groupIdx; ; i++) {
          const l = buf.getLine(i);
          if (!l) break;
          let heuristicCont = false;
          if (i > groupIdx) {
            const prev = buf.getLine(i - 1);
            heuristicCont = !l.isWrapped && isHeuristicCont(prev, l);
            if (!l.isWrapped && !heuristicCont) break;
          }
          const nextLine = buf.getLine(i + 1);
          const raw = _trimWideWrapPadding(
            l,
            nextLine,
            l.translateToString(true),
            terminal.cols,
          );
          const metrics = _lineTextMetrics(l, raw, terminal.cols);
          const prefixSkip = heuristicCont ? ((raw.match(/^\s+/) || [''])[0].length) : 0;
          const lt = prefixSkip ? raw.slice(prefixSkip) : raw;
          text += lt;
          lineWidths.push(lt.length);
          linePrefixSkips.push(prefixSkip);
          lineColumnMaps.push({
            startColumns: metrics.startColumns.slice(prefixSkip),
            endColumns: metrics.endColumns.slice(prefixSkip),
          });
        }

        const cwd = typeof getCwd === 'function' ? getCwd(sessionId) : null;
        // CLI 与卡片共用同一解析器，避免双反斜杠/空格/drive-relative
        // 只在某一视图被修复、另一视图继续失效。
        const candidates = collectPathCandidates(text, cwd);

        const links = [];
        for (const c of candidates) {
          let cum = 0;
          for (let i = 0; i < lineWidths.length; i++) {
            const lineStart = cum;
            const lineEnd = cum + lineWidths[i];
            cum = lineEnd;
            if (c.end < lineStart || c.start >= lineEnd) continue;
            const yLine = groupLine + i;
            if (yLine !== lineNumber) continue;
            const segStartOff = Math.max(c.start, lineStart);
            const segEndOff = Math.min(c.end, lineEnd - 1);
            const prefixSkip = linePrefixSkips[i] || 0;
            const localStart = segStartOff - lineStart;
            const localEnd = segEndOff - lineStart;
            const columnMap = lineColumnMaps[i];
            const startX = columnMap.startColumns[localStart]
              || localStart + 1 + prefixSkip;
            const endX = columnMap.endColumns[localEnd]
              || localEnd + 1 + prefixSkip;
            const fullPath = c.openPath;
            const linkObj = {
              range: {
                start: { x: startX, y: yLine },
                end: { x: endX, y: yLine },
              },
              text: fullPath,
              decorations: { pointerCursor: true, underline: true },
            };
            linkObj._activationSeq = 0;
            linkObj._disposed = false;
            linkObj.activate = async (event) => {
              linkObj._activationSeq += 1;
              activationStats.activations += 1;
              try {
                if (event && event.button === 2 && typeof onContextMenu === 'function') {
                  onContextMenu(fullPath, event.clientX, event.clientY);
                  return;
                }
                const result = await openPathInHub(fullPath, { cwd, requireExistsForRel: false });
                if (result && result.ok === false) throw new Error(result.error || 'path open failed');
                return result;
              } catch (error) {
                activationStats.failures += 1;
                console.warn('[terminal-link] activation failed:', fullPath, error);
                if (typeof onError === 'function') {
                  onError(`路径打开失败：${String(error && error.message || error)}`);
                }
                return { ok: false, error: String(error && error.message || error) };
              }
            };
            linkObj.hover = () => {
              hoveredLink = linkObj;
              activationStats.hovers += 1;
              setGroupUnderline(fullPath, true);
            };
            linkObj.leave = () => {
              if (hoveredLink === linkObj) hoveredLink = null;
              activationStats.leaves += 1;
              setGroupUnderline(fullPath, true);
            };
            linkObj.dispose = () => {
              if (linkObj._disposed) return;
              linkObj._disposed = true;
              if (hoveredLink === linkObj) hoveredLink = null;
              // A manually revalidated pointerdown link is provider-owned and
              // remains live until click; an xterm-disposed hover link is never
              // eligible for fallback because _disposed is checked above.
              unregisterLinkFromGroup(fullPath, linkObj);
              ownedLinks.delete(linkObj);
            };
            registerLinkInGroup(fullPath, linkObj);
            ownedLinks.add(linkObj);
            links.push(linkObj);
          }
        }
        callback(links.length > 0 ? links : undefined);
      },
    };
    provider.attachElement = attachElement;
    provider.getActivationStats = () => ({ ...activationStats });
    provider.dispose = () => {
      if (disposed) return;
      disposed = true;
      renderDisposable?.dispose?.();
      providerRegistration?.dispose?.();
      for (const link of [...ownedLinks]) link.dispose?.();
      ownedLinks.clear();
      if (attachedElement) {
        attachedElement.removeEventListener('pointerdown', onPointerDown, true);
        attachedElement.removeEventListener('mousedown', onMouseDown, true);
        attachedElement.removeEventListener('click', onClick, true);
      }
      hoveredLink = null;
      releasePressedLink();
      attachedElement = null;
    };
    providerRegistration = terminal.registerLinkProvider(provider);
    if (!attachElement() && typeof terminal.onRender === 'function') {
      renderDisposable = terminal.onRender(() => {
        if (attachElement()) {
          renderDisposable?.dispose?.();
          renderDisposable = null;
        }
      });
    }
    return provider;
  }

  return registerLocalPathLinks;
}

module.exports = { createTerminalLinkRegistrar, _lineTextMetrics, _trimWideWrapPadding };
