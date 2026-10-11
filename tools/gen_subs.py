"""批量为音频生成 .srt 字幕（faster-whisper，需 NVIDIA GPU 或用 --cpu）。

用法: python gen_subs.py <音频目录> [--model large-v3] [--lang en] [--force] [--cpu]
已有同名 .srt 的文件会跳过（除非 --force）。模型存放在 tools/models/，首次使用自动下载。
"""
import argparse, os, re, sys
import models  # 设置模型目录与 CUDA 路径
from faster_whisper import WhisperModel

AUDIO = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac", ".webm"}


def ts(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


END = re.compile(r"""[.!?…。！？]["'”’)\]]*$""")

ABBR = re.compile(r"(Mr|Mrs|Ms|Dr|St|No|Prof|Jr|Sr|vs|etc|M|Mme|Mlle|Mgr|[A-Z])\.")

# 引导 whisper 输出完整标点
PROMPT = {
    "en": "Hello, Mr. Smith. How are you? \"Fine,\" he said. It's a lovely day.",
    "fr": "Bonjour, M. Dupont. Comment allez-vous ? « Très bien », dit-il. Il fait beau aujourd'hui.",
}


def sentences(words, max_len):
    """按词时间戳切句：句末标点、长停顿（标题等）、或超过 max_len 秒时在逗号处断开。"""
    out, cur = [], []

    def emit(ws):
        # 仍超长（通常是缺标点的段落）：在最长停顿处递归切开
        dur = ws[-1].end - ws[0].start
        # 两侧都至少保留 max_len/3，避免切出一个词一条的碎片
        ok = [j for j in range(1, len(ws))
              if ws[j - 1].end - ws[0].start >= max_len / 3 and ws[-1].end - ws[j].start >= max_len / 3]
        if dur > max_len and ok:
            k = max(ok, key=lambda j: ws[j].start - ws[j - 1].end)
            emit(ws[:k]); emit(ws[k:])
            return
        text = "".join(w.word for w in ws).strip()
        text = re.sub(r"""^"'""", '"', text)   # whisper 常把开引号写成 "'
        if text:
            out.append((ws[0].start, ws[-1].end, text))

    def flush():
        if cur:
            emit(list(cur))
            cur.clear()

    last = None
    for w in words:
        t = w.word.strip()
        # whisper 在分段边界偶尔重复同一个词
        if last and t == last.word.strip() and w.start - last.end < 0.3:
            continue
        abbr = last is not None and ABBR.fullmatch(last.word.strip())
        if cur and w.start - cur[-1].end > 1.2 and not abbr:   # 明显停顿：标题与正文之间等
            flush()
        # 没有标点的超长段：在稍长的停顿处断开
        if cur and w.start - cur[0].start > max_len * 1.5 and w.start - cur[-1].end > 0.35:
            flush()
        cur.append(w)
        last = w
        if END.search(t) and not ABBR.fullmatch(t):
            flush()
        elif cur[-1].end - cur[0].start > max_len and t.endswith((",", ";", ":")):
            flush()
    flush()
    # 合并："said Ron." 这类小写开头的尾巴，以及缺句末标点的碎片
    merged = []
    for st, en, text in out:
        if merged and (not END.search(merged[-1][2]) or text[:1].islower())                 and en - merged[-1][0] <= max_len and not merged[-1][2].isupper():
            merged[-1] = (merged[-1][0], en, merged[-1][2] + " " + text)
        else:
            merged.append((st, en, text))
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--lang", default=None, help="如 en / fr / ja；默认自动检测")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--max", type=float, default=20, help="超过此秒数的长句在逗号处断开")
    a = ap.parse_args()

    files = []
    # 只处理所选文件夹本身（子文件夹是独立的播放列表）
    root = a.dir
    for names in [os.listdir(root)]:
        for n in sorted(names):
            if os.path.splitext(n)[1].lower() in AUDIO:
                srt = os.path.join(root, os.path.splitext(n)[0] + ".srt")
                if a.force or not os.path.exists(srt):
                    files.append((os.path.join(root, n), srt))
    if not files:
        print("Aucun fichier à traiter (sous-titres déjà présents)", flush=True)
        return

    model = WhisperModel(models.whisper_path(a.model), device="cpu" if a.cpu else "cuda",
                         compute_type="int8" if a.cpu else "float16")
    for i, (src, srt) in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {os.path.basename(src)}", flush=True)
        segs, info = model.transcribe(src, language=a.lang, vad_filter=True, beam_size=5,
                                      condition_on_previous_text=True, word_timestamps=True,
                                      initial_prompt=PROMPT.get(a.lang or '', None))
        words, last = [], -10
        for s in segs:
            words += s.words or []
            pct = int(s.end / max(info.duration, 1) * 100)
            if pct >= last + 10:  # 每 10% 报告一次进度
                last = pct
                print(f"    {pct}%", flush=True)
        out = [f"{n}\n{ts(st)} --> {ts(en)}\n{text}\n"
               for n, (st, en, text) in enumerate(sentences(words, a.max), 1)]
        n = len(out)
        tmp = srt + ".part"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(out))
        os.replace(tmp, srt)
        print(f"    -> {n} phrases, langue {info.language}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
