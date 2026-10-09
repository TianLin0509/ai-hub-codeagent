#!/usr/bin/env python3
"""Claude Session Hub lifecycle notifier.

Reads CC's JSON payload from stdin to extract:
  - session_id       -> Hub saves as ccSessionId for future `--resume`
  - cwd              -> Hub saves as launch cwd for dormant wake
  - transcript_path  -> Hub reads the JSONL to get the last user message
                        on Stop events (transcript is authoritative when
                        the agent loop has actually finished)
  - prompt           -> Only on UserPromptSubmit; the raw just-submitted
                        text. Preferred over transcript read for the
                        prompt event because the new entry may not yet
                        be flushed to disk when this hook fires.
  - lifecycle fields -> Stop background tasks, StopFailure errors,
                        PermissionRequest tool name, and Notification type.
                        Payloads are bounded before crossing loopback HTTP.
"""
import os, sys, json, urllib.request

def truncate_utf8(value, max_bytes):
    text = str(value)
    encoded = text.encode('utf-8')
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max(0, max_bytes - 3)].decode('utf-8', 'ignore') + '…'

sid = os.environ.get('CLAUDE_HUB_SESSION_ID', '')
if not sid:
    sys.exit(0)

port = os.environ.get('CLAUDE_HUB_PORT', '3456')
token = os.environ.get('CLAUDE_HUB_TOKEN', '')
event = sys.argv[1] if len(sys.argv) > 1 else 'stop'

cc_session_id = None
cwd = None
transcript_path = None
prompt = None
tool_name = None
tool_input = None
tool_result = None
tool_call_id = None
turn_id = None
agent_id = None
agent_type = None
task_id = None
task_subject = None
hook_event_name = None
background_tasks = []
session_crons = []
error_type = None
error_details = None
last_assistant_message = None
notification_type = None
notification_message = None
notification_title = None
payload = {}
try:
    # Read raw bytes and decode as UTF-8 explicitly. On Chinese Windows
    # sys.stdin defaults to cp936, which mangles UTF-8 Chinese characters
    # in the `prompt` field into garbage like "继续" -> "缁х画".
    raw = sys.stdin.buffer.read() if hasattr(sys.stdin, 'buffer') else sys.stdin.read().encode('latin-1', 'replace')
    stdin_data = raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else raw
    if stdin_data:
        payload = json.loads(stdin_data)
        cc_session_id = payload.get('session_id')
        cwd = payload.get('cwd')
        transcript_path = payload.get('transcript_path')
        prompt = payload.get('prompt')
        tool_name = payload.get('tool_name')
        tool_input = payload.get('tool_input')
        tool_result = payload.get('tool_response') or payload.get('tool_output')
        tool_call_id = payload.get('tool_use_id') or payload.get('tool_call_id')
        turn_id = payload.get('turn_id')
        agent_id = payload.get('agent_id')
        agent_type = payload.get('agent_type') or payload.get('agent_name')
        task_id = payload.get('task_id') or payload.get('id')
        task_subject = payload.get('subject') or payload.get('description')
        hook_event_name = payload.get('hook_event_name')
        background_tasks = payload.get('background_tasks') or []
        session_crons = payload.get('session_crons') or []
        error_type = payload.get('error')
        error_details = payload.get('error_details')
        last_assistant_message = payload.get('last_assistant_message')
        notification_type = payload.get('notification_type')
        notification_message = payload.get('message')
        notification_title = payload.get('title')
except Exception:
    pass

try:
    if event == 'tool-use':
        raise SystemExit(0)
    else:
        url = f'http://127.0.0.1:{port}/api/hook/{event}'
        body = {'sessionId': sid, 'token': token}
        if cc_session_id:
            body['claudeSessionId'] = cc_session_id
        if cwd:
            body['cwd'] = cwd
        if transcript_path:
            body['transcriptPath'] = transcript_path
        if prompt:
            body['prompt'] = prompt
        if hook_event_name:
            body['hookEventName'] = str(hook_event_name)[:80]
        # SessionStart 的来源（startup / resume / clear / compact / fork）决定
        # Hub 是否允许把会话改绑到新线程。
        if event == 'session-start' and payload.get('source'):
            body['source'] = str(payload.get('source'))[:40]
        # SessionEnd 的原因（clear / prompt_input_exit / logout …）：只有已绑定的会话
        # 自己宣布结束之后，Hub 才接受随后的新身份（见 core/claude-identity-switch.js）。
        if event == 'session-end' and payload.get('reason'):
            body['reason'] = str(payload.get('reason'))[:40]
        if event in ('session-start', 'session-end') and agent_id:
            body['agentId'] = str(agent_id)[:180]
        # /clear、/compact 的确认归属（core/claude-local-command-acks.js）：prompt_id 标识执行周期，
        # PreCompact 的 trigger（manual / auto）与 custom_instructions（/compact 的参数）决定确认哪条提交。
        if event in ('session-start', 'session-end', 'pre-compact') and payload.get('prompt_id'):
            body['promptId'] = str(payload.get('prompt_id'))[:120]
        if event == 'pre-compact':
            if payload.get('trigger'):
                body['trigger'] = str(payload.get('trigger'))[:20]
            if isinstance(payload.get('custom_instructions'), str):
                body['customInstructions'] = payload.get('custom_instructions')[:2000]
        if event == 'instructions-loaded':
            body['instructionPath'] = str(payload.get('file_path') or '')[:8192]
            body['loadReason'] = str(payload.get('load_reason') or '')[:80]
            body['memoryType'] = str(payload.get('memory_type') or '')[:80]
            if agent_id:
                body['agentId'] = str(agent_id)[:180]
        if isinstance(background_tasks, list):
            body['backgroundTasks'] = [
                {
                    'id': str(item.get('id', ''))[:120],
                    'type': str(item.get('type', ''))[:80],
                    'status': str(item.get('status', ''))[:80],
                    'description': str(item.get('description', ''))[:160],
                }
                for item in background_tasks[:8]
                if isinstance(item, dict)
            ]
        if isinstance(session_crons, list):
            body['sessionCrons'] = [
                {
                    'id': str(item.get('id', ''))[:120],
                    'schedule': str(item.get('schedule', ''))[:120],
                    'recurring': bool(item.get('recurring', False)),
                }
                for item in session_crons[:8]
                if isinstance(item, dict)
            ]
        if error_type:
            body['error'] = str(error_type)[:160]
        if error_details:
            body['errorDetails'] = str(error_details)[:1000]
        if last_assistant_message:
            body['lastAssistantMessage'] = str(last_assistant_message)[:1200]
        if notification_type:
            body['notificationType'] = str(notification_type)[:160]
        if notification_message:
            body['message'] = str(notification_message)[:1000]
        if notification_title:
            body['title'] = str(notification_title)[:300]
        if tool_name:
            body['toolName'] = str(tool_name)[:160]
        if tool_call_id:
            body['toolCallId'] = str(tool_call_id)[:180]
        if turn_id:
            body['turnId'] = str(turn_id)[:180]
        if event in ('tool-start', 'tool-complete', 'tool-failed') and tool_input is not None:
            try:
                encoded_input = json.dumps(tool_input, ensure_ascii=False)
                body['toolInput'] = tool_input if len(encoded_input.encode('utf-8')) <= 3000 else truncate_utf8(encoded_input, 3000)
            except Exception:
                body['toolInput'] = truncate_utf8(tool_input, 3000)
        if event in ('tool-complete', 'tool-failed') and tool_result is not None:
            try:
                encoded_result = tool_result if isinstance(tool_result, str) else json.dumps(tool_result, ensure_ascii=False)
                body['toolResult'] = truncate_utf8(encoded_result, 6000)
            except Exception:
                body['toolResult'] = truncate_utf8(tool_result, 6000)
        if agent_id:
            body['agentId'] = str(agent_id)[:180]
        if agent_type:
            body['agentType'] = str(agent_type)[:160]
        if task_id:
            body['taskId'] = str(task_id)[:180]
        if task_subject:
            body['taskSubject'] = str(task_subject)[:500]
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data, {'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=3).read()
except Exception:
    pass  # hub not running is non-fatal
