'use strict';
// ACP form elicitation uses the restricted MCP primitive schema. Reject
// unsupported forms rather than silently dropping a requested field.
function validateValue(value, schema, name) {
  if (!schema || typeof schema !== 'object') throw new Error('无效的提问字段：' + name);
  if (schema.oneOf) {
    if (!schema.oneOf.some(s => Object.hasOwn(s, 'const') && s.const === value)) throw new Error('请选择有效答案：' + name);
    return;
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some(s => Object.hasOwn(s, 'const') && s.const === value)) throw new Error('请选择有效答案：' + name);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error('请选择有效答案：' + name);
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') throw new Error('请填写文字：' + name);
      if (schema.minLength != null && value.length < schema.minLength) throw new Error('答案过短：' + name);
      if (schema.maxLength != null && value.length > schema.maxLength) throw new Error('答案过长：' + name);
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) throw new Error('请填写有效数字：' + name);
      if (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum) throw new Error('数字超出范围：' + name);
      break;
    case 'boolean': if (typeof value !== 'boolean') throw new Error('请填写是或否：' + name); break;
    case 'array':
      if (!Array.isArray(value)) throw new Error('请填写多选答案：' + name);
      if (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems) throw new Error('选项数量不符：' + name);
      if (schema.uniqueItems && new Set(value).size !== value.length) throw new Error('答案不能重复：' + name);
      value.forEach(v => validateValue(v, schema.items, name)); break;
    default: throw new Error('未支持的提问类型：' + schema.type);
  }
}
function validateElicitation(result, schema) {
  if (!['accept','decline','cancel'].includes(result?.action)) throw new Error('提问响应无效');
  if (result.action !== 'accept') return { action: result.action };
  if (schema?.type !== 'object') throw new Error('未支持的提问表单');
  const content = result.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('提问回答无效');
  for (const name of schema.required || []) if (!Object.hasOwn(content,name)) throw new Error('请回答：' + name);
  for (const [name,value] of Object.entries(content)) {
    if (!Object.hasOwn(schema.properties || {},name)) throw new Error('未知提问字段：' + name);
    validateValue(value,schema.properties[name],name);
  }
  return { action:'accept', content };
}
module.exports = { validateElicitation };
