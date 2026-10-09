'use strict';
const fs=require('node:fs');
const {StringDecoder}=require('node:string_decoder');

// Qwen's local OTel exporter writes consecutive, pretty-printed JSON objects.
// An unindented closing brace terminates an object; nested braces are indented
// and literal newlines inside strings are escaped by JSON.stringify.
class QwenTelemetryTail {
  constructor(file,onEvent,onError){this.file=file;this.onEvent=onEvent;this.onError=onError;
    this.offset=0;this.pending='';this.decoder=new StringDecoder('utf8');}
  start(){this.timer=setInterval(()=>this.drain(),500);this.timer.unref?.();return this.drain();}
  async drain(){
    if(this.closed||this.reading)return;this.reading=true;let handle;
    try{
      handle=await fs.promises.open(this.file,'r');const {size}=await handle.stat();
      while(!this.closed&&this.offset<size){
        const buffer=Buffer.alloc(Math.min(65536,size-this.offset));
        const {bytesRead}=await handle.read(buffer,0,buffer.length,this.offset);if(!bytesRead)break;
        this.offset+=bytesRead;this.pending+=this.decoder.write(buffer.subarray(0,bytesRead));
        let end;while((end=this.pending.indexOf('\n}\n'))>=0){
          const text=this.pending.slice(0,end+2);this.pending=this.pending.slice(end+3);
          this.onEvent(JSON.parse(text));
        }
        if(this.pending.length>8*1024*1024)throw new Error('千问本地事件记录超出解析上限');
      }
    }catch(error){if(error.code!=='ENOENT')this.onError(error);}
    finally{await handle?.close();this.reading=false;}
  }
  close(){this.closed=true;clearInterval(this.timer);}
}
module.exports={QwenTelemetryTail};
