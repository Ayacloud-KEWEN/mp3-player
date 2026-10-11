"""Piper 语音合成助手（由 server.js 调用）。

从 stdin 读入 JSON：{"voice": "fr_FR-tom-medium", "speaker": null, "items": [{"text": "...", "out": "path.wav"}]}
模型只加载一次，逐句合成为 WAV，每完成一句输出一行 "ok <out>"。
声音模型放在 tools/models/piper/，缺失时自动下载。
"""
import json, os, sys, wave
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES = os.path.join(HERE, "models", "piper")


def main():
    job = json.load(sys.stdin)
    voice = job.get("voice") or "fr_FR-tom-medium"
    model = os.path.join(VOICES, voice + ".onnx")
    if not os.path.exists(model):
        print(f"Téléchargement de la voix {voice}…", flush=True)
        from piper.download_voices import download_voice
        os.makedirs(VOICES, exist_ok=True)
        download_voice(voice, Path(VOICES))

    from piper import PiperVoice, SynthesisConfig
    v = PiperVoice.load(model)
    cfg = SynthesisConfig(speaker_id=job.get("speaker"))
    for it in job["items"]:
        tmp = it["out"] + ".part"
        with wave.open(tmp, "wb") as w:
            v.synthesize_wav(it["text"], w, syn_config=cfg)
        os.replace(tmp, it["out"])
        print("ok " + it["out"], flush=True)


if __name__ == "__main__":
    sys.exit(main())
