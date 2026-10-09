'use strict';
// 用户额度意图与计划额度分开：只有用户原话能改变上限，确认计划后才生效。
const NUM='[0-9]+(?:\\.[0-9]+)?|[零一二两三四五六七八九十百半]+';
function number(value){
  if(value==='半')return 0.5;
  if(/^\d/.test(value))return Number(value);
  const digits={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  let total=0,n=0;for(const c of value){if(c==='十'||c==='百'){total+=(n||1)*(c==='十'?10:100);n=0;}else if(c in digits)n=digits[c];else return NaN;}return total+n;
}
function validate(input){
  const out={};
  for(const [key,max] of [['roundCap',30],['timeCapMin',1440]])if(input[key]!=null){
    const n=Number(input[key]);
    if(!Number.isFinite(n)||n<1||n>max||(key==='roundCap'&&!Number.isInteger(n)))throw Error(`额度 ${key} 支持 1–${max}${key==='roundCap'?' 整数轮':' 分钟'}，请明确调整；不会静默截断`);
    out[key]=n;
  }
  return out;
}
function extract(text){
  const s=String(text||'');const out={};
  const marker='(?:允许|最多|至多|不超过|不多于|上限|限额|预算|额度|只做|只跑|控制在|限制在|迭代)';
  const rounds=[...s.matchAll(new RegExp(marker+'[^。！？\\n，,]{0,12}?('+NUM+')\\s*轮(?:以内|以下|之内)?','g'))].at(-1);
  if(rounds)out.roundCap=number(rounds[1]);
  const time=[...s.matchAll(new RegExp('(?:'+marker+'|运行时间|总时间|时长)[^。！？\\n，,]{0,12}?('+NUM+')\\s*(分钟|小时)','g'))].at(-1);
  if(time)out.timeCapMin=number(time[1])*(time[2]==='小时'?60:1);
  return Object.keys(out).length?{...validate(out),sourceQuote:s.slice(0,4000)}:null;
}
function forPlan(ledger,input){
  if(ledger.budgetError)throw Error(ledger.budgetError);
  const current={roundCap:ledger.budget.roundCap,timeCapMin:ledger.budget.timeCapMs/60000};
  const intent=ledger.budgetIntent||{};
  const proposed=input||{};
  const values=validate(proposed);
  if(Object.keys(values).length){
    const quote=String(proposed.sourceQuote||'').trim();
    if(!quote||!(ledger.userMessages||[]).some(m=>m.includes(quote)))throw Error('更改额度需引用用户本群原话 sourceQuote；未指定的额度沿用默认值');
    const parsed=extract(quote);
    for(const key of Object.keys(values)){
      if(intent[key]!=null&&values[key]!==intent[key])throw Error('计划额度应以用户最近明确指定的额度为准');
      if(parsed?.[key]!=null&&values[key]!==parsed[key])throw Error('计划额度与用户自然语言指定的上限不一致');
      if(parsed?.[key]==null){
        const signal=key==='roundCap'?/轮|迭代|额度|机会/:/时间|分钟|小时|时长|耗时/;
        const numbers=[...quote.matchAll(new RegExp(NUM,'g'))].map(m=>number(m[0]));
        if(!signal.test(quote)||!numbers.some(n=>n===values[key]||(key==='timeCapMin'&&/小时/.test(quote)&&n*60===values[key])))throw Error('更改额度需引用含相应额度与数值的用户原话');
      }
    }
    return {...current,...intent,...values,sourceQuote:quote};
  }
  return {...current,...intent};
}
module.exports={extract,forPlan,validate,number};
