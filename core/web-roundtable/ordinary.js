'use strict';
const transport=require('../ordinary-browser-client');
async function open(provider,url,options={}){
  const lane='roundtable-'+provider+'-'+require('crypto').randomBytes(6).toString('hex');
  const binding=transport.options({identity:options.identity||'main'},options.env||process.env);
  const request=async argv=>{
    try{return await transport.call(binding,lane,argv);}
    catch(error){
      if(!['close','network-errors'].includes(argv[0])){
        try{page.networkErrors=await transport.call(binding,lane,['network-errors']);}
        catch(detailError){error.networkDetailError=detailError.message;}
      }
      throw error;
    }
  };
  const page={networkErrors:[],
    async evaluate(expression){return request(['evaluate',expression]);},
    async call(method,params={}){
      if(method==='Input.insertText')return request(['keyboard','insertText',params.text]);
      if(method==='Input.dispatchKeyEvent'){
        if(!['keyDown','keyUp'].includes(params.type))throw Error('Unsupported ordinary key event');
        return request(['keyboard',params.type==='keyDown'?'down':'up',params.key]);
      }
      if(method==='Page.navigate')return request(['goto',params.url]);
      if(method==='Runtime.evaluate')return {result:{value:await page.evaluate(params.expression)}};
      throw Error('Unsupported ordinary page command');
    }};
  try{await request(['open','about:blank']);await request(['goto',url]);}
  catch(error){await request(['close']).catch(closeError=>{error.cleanupError=closeError.message;});throw error;}
  return {page,owned:true,headless:false,browserPid:null,transport:'extension',async close(){await request(['close']);}};
}
module.exports={open};
