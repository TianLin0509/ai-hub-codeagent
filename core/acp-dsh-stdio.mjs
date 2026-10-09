// Thin native DSH extension. Execution remains in the upstream ACP plugin;
// fork delegates to DSH's validated session store and durability checkpoint.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { TransformStream, WritableStream } from 'node:stream/web';
export const name = 'ai-hub-acp-stdio';
export const inject = ['acpServer','sessions','agents','agentPresets'];
export function apply(ctx) {
  const require = createRequire(process.env.AI_HUB_DSH_BRIDGE + '/package.json');
  const { ndJsonStream } = require('@agentclientprotocol/sdk');
  const raw = ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin));
  const writer = raw.writable.getWriter();
  const initialization = new Set();
  const readable = raw.readable.pipeThrough(new TransformStream({
    async transform(message,controller) {
      if (message.method === 'initialize') initialization.add(message.id);
      if (message.method !== 'session/fork') { controller.enqueue(message); return; }
      try {
        const source=ctx.sessions.get(message.params?.sessionId);
        if(!source)throw new Error('Fork source is not live in this native Harness');
        await ctx.sessions.flush(source);
        const seed=source.snapshotEvents();
        const preset=(await ctx.agentPresets.resolve(source.header.agentPreset)).id;
        // AgentRegistry.create owns the persistent writer. SessionStore alone
        // only creates an in-memory session, even when another flush listener exists.
        const handle=await ctx.agents.create({sessionId:randomUUID(),seed,inheritedEventCount:seed.length,
          meta:{cwd:source.header.cwd,parentSession:source.id,isSeeded:true,agentPreset:preset},
          agentOptions:{provider:process.env.DSH_PROVIDER,model:message.params.modelId || process.env.DSH_MODEL},
          setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,preset);}});
        const child=handle.agent.session;
        try {if(!await ctx.sessions.flush(child))throw new Error('Native fork has no durability listener');}
        finally {await handle.dispose();}
        await writer.write({jsonrpc:'2.0',id:message.id,result:{sessionId:String(child.id)}});
      }catch(error){await writer.write({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:error.message}});}
    }
  }));
  const writable=new WritableStream({
    async write(message) {
      if(initialization.delete(message.id) && message.result?.agentCapabilities) {
        message.result.agentCapabilities.sessionCapabilities={...message.result.agentCapabilities.sessionCapabilities,fork:{}};
        message.result.agentCapabilities._meta={...message.result.agentCapabilities._meta,hubNativeFork:true};
      }
      await writer.write(message);
    },
    close(){return writer.close();},abort(reason){return writer.abort(reason);}
  });
  return ctx.get('acpServer').connect({readable,writable});
}
