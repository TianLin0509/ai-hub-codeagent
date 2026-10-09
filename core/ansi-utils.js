// core/ansi-utils.js

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor, scroll)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (title, hyperlinks)
    .replace(/\x1b\][^\x07\x1b]*/g, '')        // unterminated OSC (ConPTY truncation)
    .replace(/\x1b[()][AB012]/g, '')            // charset switches
    .replace(/\x1b[=>Nc7-9]/g, '')              // misc escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // control chars (keep \n \r \t)
}

module.exports = { stripAnsi };
