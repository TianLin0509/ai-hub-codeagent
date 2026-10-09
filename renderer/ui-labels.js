'use strict';
const EFFORTS = Object.freeze({none:'无',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'超高'});
function effortLabel(value) { const raw = String(value || '').trim(); return EFFORTS[raw.toLowerCase()] || raw || '未确认'; }
function speedLabel(value) { const raw = String(value || '').trim(); return /^(standard|default)$/i.test(raw) ? '标准' : /^fast$/i.test(raw) ? 'Fast' : raw || '未确认'; }
module.exports = { effortLabel, speedLabel };
