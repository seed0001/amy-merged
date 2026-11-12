// Some local coder templates return a whole JSON tool call as content rather than
// Ollama native tool_calls. Accept only an exact object naming an offered tool.
export function codingToolCalls(message,tools){
  if(message?.tool_calls?.length)return message.tool_calls;
  const raw=String(message?.content||'').trim().replace(/^```json\s*([\s\S]*?)\s*```$/,'$1');
  let call;try{call=JSON.parse(raw);}catch{return [];}
  if(!call || Array.isArray(call) || Object.keys(call).some(key=>!['name','arguments'].includes(key)))return [];
  if(!tools.some(tool=>tool.function?.name===call.name) || !call.arguments || typeof call.arguments!=='object' || Array.isArray(call.arguments))return [];
  return [{type:'function',function:call}];
}
