#!/usr/bin/env python3
"""DeepSeek V4 interactive REPL for Claude Session Hub.

Usage:
    python deepseek_repl.py                          # default: deepseek-v4-flash
    python deepseek_repl.py --model deepseek-v4-pro  # use V4 Pro
"""
import argparse
import io
import os
import sys

from openai import OpenAI


def _ensure_utf8():
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if sys.stderr.encoding and sys.stderr.encoding.lower() not in ("utf-8", "utf8"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def _load_api_key():
    return os.environ.get("DEEPSEEK_API_KEY", "")


MODEL_DISPLAY = {
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "deepseek-v4-flash": "DeepSeek V4 Flash",
    "deepseek-reasoner": "DeepSeek Reasoner (legacy)",
    "deepseek-chat": "DeepSeek Chat (legacy)",
}

HELP_TEXT = """
Commands:
  /help              Show this help
  /clear             Clear conversation history
  /model <id>        Switch model (deepseek-v4-flash, deepseek-v4-pro)
  /think [on|off]    Toggle thinking/reasoning mode
  /exit              Exit REPL
""".strip()


def main():
    _ensure_utf8()
    parser = argparse.ArgumentParser(description="DeepSeek V4 Interactive REPL")
    parser.add_argument("--model", default="deepseek-v4-pro", help="Model ID")
    parser.add_argument("--temperature", type=float, default=None, help="Sampling temperature")
    args = parser.parse_args()

    api_key = _load_api_key()
    if not api_key:
        print("Error: DEEPSEEK_API_KEY env var not set. Get a key at https://platform.deepseek.com/api_keys and `setx DEEPSEEK_API_KEY <key>`.", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")
    model = args.model
    thinking = True
    messages = []

    display = MODEL_DISPLAY.get(model, model)
    print(f"\n  {display} | 1M context | /help 查看命令\n")

    while True:
        try:
            user_input = input("ds> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            cmd_parts = user_input.split(maxsplit=1)
            cmd = cmd_parts[0].lower()

            if cmd == "/exit":
                print("Bye!")
                break
            elif cmd == "/clear":
                messages.clear()
                print("History cleared.")
                continue
            elif cmd == "/model":
                if len(cmd_parts) < 2:
                    print(f"Current model: {model}")
                    print("Available: deepseek-v4-flash, deepseek-v4-pro")
                else:
                    model = cmd_parts[1].strip()
                    display = MODEL_DISPLAY.get(model, model)
                    print(f"Switched to {display}")
                continue
            elif cmd == "/think":
                if len(cmd_parts) < 2:
                    thinking = not thinking
                else:
                    thinking = cmd_parts[1].strip().lower() in ("on", "true", "1", "yes")
                print(f"Thinking mode: {'ON' if thinking else 'OFF'}")
                continue
            elif cmd == "/help":
                print(HELP_TEXT)
                continue

        messages.append({"role": "user", "content": user_input})

        try:
            extra = {}
            if args.temperature is not None:
                extra["temperature"] = args.temperature

            stream = client.chat.completions.create(
                model=model,
                messages=messages,
                stream=True,
                **extra,
            )

            collected = []
            reasoning_chunks = []
            in_reasoning = False
            last_chunk = None

            for chunk in stream:
                last_chunk = chunk
                delta = chunk.choices[0].delta if chunk.choices else None
                if not delta:
                    continue

                reasoning = getattr(delta, "reasoning_content", None)
                if reasoning:
                    if not in_reasoning:
                        in_reasoning = True
                        print("\n[thinking] ", end="", flush=True)
                    print(reasoning, end="", flush=True)
                    reasoning_chunks.append(reasoning)
                    continue

                if in_reasoning and delta.content:
                    in_reasoning = False
                    print("\n\n", end="", flush=True)

                if delta.content:
                    print(delta.content, end="", flush=True)
                    collected.append(delta.content)

            print()

            usage = getattr(last_chunk, "usage", None) if last_chunk else None
            if usage:
                print(f"[tokens: in={usage.prompt_tokens} out={usage.completion_tokens} total={usage.total_tokens}]")

            assistant_content = "".join(collected)
            if assistant_content:
                messages.append({"role": "assistant", "content": assistant_content})

        except KeyboardInterrupt:
            print("\n[interrupted]")
            if messages and messages[-1]["role"] == "user":
                messages.pop()
        except Exception as e:
            print(f"\nError: {e}", file=sys.stderr)
            if messages and messages[-1]["role"] == "user":
                messages.pop()


if __name__ == "__main__":
    main()
