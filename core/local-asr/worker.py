# -*- coding: utf-8 -*-
"""Hub 本地语音识别 worker：stdin 每行一个 JSON 命令，stdout 每行一个 JSON 结果。

进程一启动就导入运行环境（约 0.9GB 内存，不占显存），收到 load 才把模型装进显卡。
释放显存靠 Hub 结束整个进程：实测进程内删除模型仍残留约 3.5GB 显存。

命令：
  {"op":"load"}                                   -> {"event":"loaded","ms":...}
  {"op":"transcribe","id":..,"pcm":[b64...],"context":"..."} -> {"id":..,"texts":[...],"ms":...}
  {"op":"embed","id":..,"pcm":"b64"}             -> {"id":..,"vector":[...],"ms":...}（声纹，CPU）
pcm 均为 16kHz 单声道 16 位小端 PCM 的 base64。
"""
import base64
import json
import os
import sys
import time

_OUT = sys.stdout
sys.stdout = sys.stderr  # 第三方库的打印一律进 stderr，stdout 只留协议行


def out(obj):
    _OUT.write(json.dumps(obj) + "\n")
    _OUT.flush()


def pcm(b64):
    import numpy as np
    return np.frombuffer(base64.b64decode(b64), dtype=np.int16).astype(np.float32) / 32768.0


def main():
    t0 = time.perf_counter()
    import numpy as np
    # HUB_LOCAL_WORKER=speaker：只做声纹（CPU，约 170MB 内存），不导入显卡识别环境，可与识别 worker 并行。
    speaker_only = os.environ.get("HUB_LOCAL_WORKER") == "speaker"
    if not speaker_only:
        import torch
        from qwen_asr import Qwen3ASRModel
    model_dir = os.environ.get("HUB_LOCAL_ASR_MODEL", "")
    language = os.environ.get("HUB_LOCAL_ASR_LANGUAGE") or None
    out({"event": "env-ready", "ms": int((time.perf_counter() - t0) * 1000)})
    import threading
    stop_prewarm = threading.Event()
    if not speaker_only and model_dir:
        # 后台把模型文件读一遍放进系统文件缓存（可被系统随时回收，不锁内存）：预读完成后装载 3.6 秒，
        # 未预读 10 秒以上。开始装模型时立即停止预读，避免两者抢硬盘（实测抢盘时装载 6～10 秒）。
        def prewarm():
            for root, _, files in os.walk(model_dir):
                for name in files:
                    if name.endswith((".safetensors", ".bin")):
                        try:
                            with open(os.path.join(root, name), "rb", buffering=0) as fh:
                                while not stop_prewarm.is_set() and fh.read(16 * 1024 * 1024):
                                    pass
                        except OSError:
                            pass

        threading.Thread(target=prewarm, daemon=True).start()
    model = None
    speaker = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = {}
        try:
            msg = json.loads(line)
            op = msg.get("op")
            t = time.perf_counter()
            if op in ("load", "transcribe") and speaker_only:
                raise RuntimeError("speaker-only worker cannot %s" % op)
            if op == "load":
                stop_prewarm.set()
                if model is None:
                    # 显卡被别的程序占着时硬装会溢出到内存，推理慢到几十秒；剩余不够就不装，让 Hub 改走 Token Plan
                    free_mb = torch.cuda.mem_get_info()[0] // (1024 * 1024)
                    need_mb = int(os.environ.get("HUB_LOCAL_ASR_MIN_FREE_MB") or 5600)
                    if free_mb < need_mb:
                        raise RuntimeError("显存不足：剩余 %d MB，需要 %d MB" % (free_mb, need_mb))
                    model = Qwen3ASRModel.from_pretrained(model_dir, dtype=torch.bfloat16, device_map="cuda:0", max_new_tokens=1024)
                    # 用 1 秒静音预热：首次推理的一次性开销不落到用户第一句话上
                    model.transcribe(audio=(np.zeros(16000, dtype=np.float32), 16000), language=language)
                    torch.cuda.synchronize()
                out({"id": msg.get("id"), "event": "loaded", "ms": int((time.perf_counter() - t) * 1000)})
            elif op == "transcribe":
                if model is None:
                    raise RuntimeError("model not loaded")
                audios = [(pcm(p), 16000) for p in msg["pcm"]]
                ctx = str(msg.get("context") or "")
                res = model.transcribe(audio=audios, context=[ctx] * len(audios), language=[language] * len(audios))
                out({"id": msg.get("id"), "texts": [r.text for r in res], "ms": int((time.perf_counter() - t) * 1000)})
            elif op == "embed":
                # pcm 为 base64 列表，每段返回一个单位化声纹向量；max_seconds 截取每段开头（够判断是谁，又省时间）
                if speaker is None:
                    import sherpa_onnx
                    speaker = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                        model=os.environ["HUB_LOCAL_SPEAKER_MODEL"], num_threads=4))
                cap = int(float(msg.get("max_seconds") or 0) * 16000)
                vectors = []
                for p in msg["pcm"]:
                    x = pcm(p)
                    if cap:
                        x = x[:cap]
                    s = speaker.create_stream()
                    s.accept_waveform(16000, x)
                    s.input_finished()
                    v = np.array(speaker.compute(s), dtype=np.float32)
                    vectors.append([round(float(e), 6) for e in v / (np.linalg.norm(v) + 1e-9)])
                out({"id": msg.get("id"), "vectors": vectors, "ms": int((time.perf_counter() - t) * 1000)})
            else:
                raise ValueError("unknown op: %s" % op)
        except Exception as e:  # 单条失败只回报这一条，进程继续服务
            out({"id": msg.get("id"), "error": (type(e).__name__ + ": " + str(e))[:300]})


if __name__ == "__main__":
    main()
