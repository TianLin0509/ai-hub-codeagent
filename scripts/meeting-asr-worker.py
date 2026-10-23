"""Local-only CPU transcription; stdout is a JSON-lines protocol."""
import json
import sys
import wave
import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        with wave.open(request["file"], "rb") as source:
            if source.getsampwidth() != 2:
                raise ValueError("Expected PCM16 WAV")
            rate = source.getframerate()
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            samples = samples.reshape(-1, source.getnchannels()).mean(axis=1)
            if rate != 16000:
                samples = np.interp(np.arange(round(len(samples) * 16000 / rate)) * rate / 16000, np.arange(len(samples)), samples).astype(np.float32)
        segments, _ = model.transcribe(samples, beam_size=5, vad_filter=True,
            initial_prompt="无线通信，PPT，CodeAgent，AI Hub，MIMO，SINR，OLLA，MCS，吞吐量，高负载，低负载，基线。")
        result = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments]
        print(json.dumps({"id": request["id"], "segments": result}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"id": request.get("id"), "error": str(exc)}, ensure_ascii=False), flush=True)
