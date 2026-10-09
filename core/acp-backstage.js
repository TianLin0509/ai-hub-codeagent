'use strict';
const { CodexBackstage } = require('./codex-backstage');
const { CodexBackstageStore } = require('./codex-backstage-store');
const json = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

// ACP owns its event identities. Only the bounded storage/presentation is shared.
class AcpBackstage extends CodexBackstage {
  ensure() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('后台记录已关闭');
    if (!this.store) {
      this.store = new CodexBackstageStore(this.session.storePath ? this.session.storePath + '.backstage.sqlite' : ':memory:',
        revision => this.session.emit('backstage-updated', { revision }), error => this.failed(error));
      this.historyOrdinal = Math.min(-1, this.store.db.prepare('SELECT COALESCE(MIN(ordinal),0)-1 AS n FROM entries').get().n);
    }
    return this.store;
  }
  item(turnId, item, completed, historical = false) {
    if (!item?.id) return;
    this.capture(store => {
      const id = this.key(turnId, item.id);
      if (historical && (store.cache.has(id) || store.db.prepare('SELECT 1 FROM entries WHERE id=?').get(id))) return;
      const type = item.type === 'acpTool' ? 'mcpToolCall' : item.type === 'acpPlan' ? 'plan' : item.type;
      store.update(id, { turnId, itemId:item.id, type,
        title:item.title || (type === 'userMessage' ? '你' : type === 'agentMessage' ? this.session.label : type === 'reasoning' ? '思考' : type === 'plan' ? '执行计划' : '调用工具'),
        status:item.status === 'inProgress' ? (completed ? 'unknown' : 'running') : item.status || (completed ? 'completed' : 'running'),
        ...(historical ? {ordinal:this.historyOrdinal--, historical:true} : {}) });
      if (type === 'userMessage') store.set(id, 'text', (item.content || []).map(c => c.text ?? c.path ?? c.url ?? json(c)).join('\n'));
      if (item.text != null) store.set(id, type === 'reasoning' ? 'summary' : 'text', item.text);
      if (item.rawInput != null) store.set(id, 'details', json(item.rawInput));
      if (item.rawOutput != null) store.set(id, 'rawOutput', json(item.rawOutput));
      if (item.result != null) store.set(id, 'output', json(item.result));
      if (item.entries != null) store.set(id, 'details', json(item.entries));
      if (item.locations != null) store.set(id, 'locations', json(item.locations));
      if (completed || ['completed','failed'].includes(item.status)) store.releaseHashes(id);
    });
  }
  chunk(turnId, item, text) {
    this.capture(store => {
      const id = this.key(turnId, item.id);
      store.update(id, {turnId,itemId:item.id,type:item.type,title:item.type === 'reasoning' ? '思考' : this.session.label,status:'running'});
      store.append(id, item.type === 'reasoning' ? 'summary' : 'text', text);
    });
  }
  completed(turn, result) {
    this.capture(store => {
      for (const item of turn.items || []) {
        const id=this.key(turn.id,item.id);
        const status=item.type === 'acpTool' ? (['completed','failed'].includes(item.status) ? item.status : turn.status === 'completed' ? 'unknown' : turn.status) : turn.status;
        store.update(id,{status});store.releaseHashes(id);
      }
      const id=this.key(turn.id,'$result');
      store.update(id,{type:'turn',title:'本轮',turnId:turn.id,status:turn.status});
      store.set(id,'result',json(result || {status:turn.status,error:turn.error}));
    });
  }
  read(options = {}) {
    return {...super.read(options),capture:`保留启用后的 ${this.session.label} 消息、思考、工具结果、原生回执与诊断；较早内容来自 Hub 已保存的 ACP 历史，未采集的过程无法补录。`};
  }
}
module.exports = { AcpBackstage };
