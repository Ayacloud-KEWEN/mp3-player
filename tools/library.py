"""双语阅读：文字识别、分句翻译、导出音频播放列表（由 server.js 调用）。

  python library.py ocr <图片...> [--engine ai|local]   → 输出 JSON {"text", "title", "lang"}
  python library.py build <文档目录> [--engine ai|local] → 读 source.txt / meta.json，分句并译成中文，写 doc.json
  python library.py ingest <文档目录> <文件或文件夹> --done <目录> [--engine ai|local]
                                              → 收件箱：识别图片/读取 txt → 翻译 → 原文件移入 --done
  python library.py export <文档目录> <输出目录> --voice fr_FR-tom-medium
                                              → 合成整篇朗读：<标题>.mp3 + .srt + .zh.srt
"""
import argparse, json, os, re, shutil, subprocess, sys, wave
import models  # 设置模型目录与 CUDA 路径

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------- 文字识别 ----------
def ocr(paths, engine="local"):
    """图片和 PDF → {"text", "title", "lang"}，按顺序拼接。
    PDF：有文字层的页直接取文字；扫描页渲染成图片再识别（DeepSeek 每次最多 4 页）。"""
    import tempfile
    segs = []      # 按顺序：("text", 文字) 或 ("img", 图片路径)
    tmp = tempfile.mkdtemp(prefix="lyra-pdf-")
    try:
        for p in paths:
            if p.lower().endswith(".pdf"):
                segs += pdf_segments(p, tmp)
            else:
                segs.append(("img", p))
        out, title, lang = [], "", ""
        k, total = 0, sum(1 for s in segs if s[0] == "img")
        i = 0
        while i < len(segs):
            if segs[i][0] == "text":
                out.append(segs[i][1]); i += 1; continue
            run = []
            while i < len(segs) and segs[i][0] == "img" and len(run) < (4 if engine == "ai" else 50):
                run.append(segs[i][1]); i += 1
            k += len(run)
            if total > 1:
                print(f"Pages {k}/{total}", flush=True)
            r = ocr_images(run, engine)
            out.append(r["text"]); title = title or r["title"]; lang = lang or r["lang"]
        return {"text": "\n\n".join(t for t in out if t.strip()), "title": title, "lang": lang}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def pdf_segments(path, tmp):
    import pymupdf
    segs = []
    with pymupdf.open(path) as doc:
        print(f"PDF : {doc.page_count} page(s)", flush=True)
        for n, page in enumerate(doc):
            # 文字层：按块取段落，块内换行合并（行尾连字符断词也接回去）
            blocks = [b[4] for b in page.get_text("blocks") if b[6] == 0]
            text = "\n\n".join(re.sub(r"\s*\n\s*", " ", re.sub(r"-\n(?=[a-zà-ÿ])", "", b)).strip() for b in blocks if b.strip())
            if len(text) >= 150:
                segs.append(("text", text))
            else:   # 扫描页：渲染为 200 dpi 图片
                f = os.path.join(tmp, f"p{n:04d}.png")
                page.get_pixmap(dpi=200).save(f)
                segs.append(("img", f))
    return segs


def ocr_images(paths, engine="local"):
    """图片 → {"text", "title", "lang"}。ai：DeepSeek 视觉模型；不可用时退回本地 EasyOCR。"""
    if engine == "ai":
        import deepseek
        try:
            return deepseek.ocr(paths)
        except Exception as e:
            print(f"DeepSeek : {e} — reconnaissance locale (EasyOCR)", flush=True)
    import easyocr
    reader = easyocr.Reader(["fr", "en"], gpu=False, verbose=False,
                            model_storage_directory=os.path.join(models.MODELS, "easyocr"))
    import numpy as np
    from PIL import Image, ImageOps
    paras = []
    for p in paths:
        # 用 PIL 读图再传像素：OpenCV 在 Windows 上打不开含中文/重音字母的路径
        img = np.array(ImageOps.exif_transpose(Image.open(p)).convert("RGB"))
        paras += reader.readtext(img, detail=0, paragraph=True)
    text = "\n\n".join(fix_ocr(p) for p in paras if p.strip())
    return {"text": text, "title": "", "lang": ""}


def fix_ocr(t):
    """EasyOCR 常见的标点问题：标点前多空格、逗号识别成分号。"""
    t = re.sub(r"\s+([.,])", r"\1", t)
    t = re.sub(r";(\s+[a-zà-ÿ])", r",\1", t)     # 分号后接小写词，多半原本是逗号
    return t


# ---------- 分段与分句 ----------
ABBR = {"mr", "mrs", "ms", "dr", "st", "prof", "jr", "sr", "vs", "etc", "e.g", "i.e", "cf", "no", "p", "pp",
        "m", "mme", "mlle", "mm", "mgr", "av", "bd", "env", "fig", "vol", "ch", "art"}


def paragraphs(text):
    text = text.replace("\r", "").replace("­", "")
    blocks = re.split(r"\n\s*\n", text) if re.search(r"\n\s*\n", text) else text.split("\n")
    out = []
    for b in blocks:
        b = re.sub(r"-\n(?=[a-zà-ÿ])", "", b)        # 换行处的连字符断词
        b = re.sub(r"\s*\n\s*", " ", b)
        b = re.sub(r"[ \t]+", " ", b).strip()
        if b:
            out.append(b)
    return out


def sentences(par):
    """按句末标点切句；跳过缩写（M. Dupont、Mr. Smith、e.g.）和单个大写字母缩写。"""
    out, start = [], 0
    # 句末标点之后可带收尾引号/括号（法语引号前有空格："? »"）
    for m in re.finditer(r"\s?[.!?…]+(?:\s?[»\"”’')\]])*(?=\s+[«\"“‘(\[—–-]?\s*[A-ZÀ-ÖØ-Þ0-9])", par):
        before = par[start:m.start()].split()
        last = before[-1].lower().rstrip(".") if before else ""
        is_time = last == "h" and len(before) > 1 and before[-2].isdigit()   # « 8 h. » 是时间，不是缩写
        if m.group().strip().startswith(".") and not is_time and (last in ABBR or re.fullmatch(r"[a-z]", last)):
            continue
        out.append(par[start:m.end()].strip())
        start = m.end()
    tail = par[start:].strip()
    if tail:
        out.append(tail)
    return out


def build(docdir, engine="local"):
    meta = json.load(open(os.path.join(docdir, "meta.json"), encoding="utf-8"))
    text = open(os.path.join(docdir, "source.txt"), encoding="utf-8").read()
    src = meta.get("lang", "en")
    paras = [sentences(p) for p in paragraphs(text)]
    flat = [s for p in paras for s in p]
    print(f"{len(paras)} paragraphes, {len(flat)} phrases", flush=True)

    zh = [None] * len(flat)
    if engine == "ai":
        import deepseek
        try:
            print("Traduction DeepSeek…", flush=True)
            zh = deepseek.translate(flat, src, log=lambda m: print(m, flush=True))
        except Exception as e:
            print(f"DeepSeek : {e}", flush=True)
    missing = [i for i, z in enumerate(zh) if not z]
    if missing:
        if engine == "ai":
            print(f"Traduction locale pour {len(missing)} phrase(s)", flush=True)
        for i, z in zip(missing, local_translate([flat[i] for i in missing], src)):
            zh[i] = z

    k, doc = 0, []
    for p in paras:
        doc.append([[s, zh[k + j]] for j, s in enumerate(p)])
        k += len(p)
    tmp = os.path.join(docdir, "doc.json.part")
    json.dump({"paragraphs": doc}, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, os.path.join(docdir, "doc.json"))
    meta["engine"] = engine if not missing or engine == "local" else "ai+local"
    json.dump(meta, open(os.path.join(docdir, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print("Terminé", flush=True)


def local_translate(flat, src):
    """本地 NLLB 逐句翻译（引语分开、长句切分、过短重译）。"""
    import ctranslate2
    from transformers import AutoTokenizer
    import translate_subs as ts

    path, nllb = models.translator_path(src, "zh")
    tok = AutoTokenizer.from_pretrained(path, src_lang=models.NLLB_CODES[src])
    tr = ctranslate2.Translator(path, device="cuda")
    tgt = models.NLLB_CODES["zh"]

    QUOTES = "«»“”\""

    def tx(texts):
        # 引语片段：去掉引号再翻译（引号会干扰模型），译文再加上中文引号
        quoted = [t.strip()[:1] in "«“\"" for t in texts]
        bare = [t.strip().strip(QUOTES + " ").replace(" ", " ") if q else t for t, q in zip(texts, quoted)]
        res = tr.translate_batch([tok.convert_ids_to_tokens(tok.encode(p)) for p in bare],
                                 max_batch_size=32, beam_size=4, max_decoding_length=400, disable_unk=True,
                                 target_prefix=[[tgt]] * len(texts))
        out = []
        for r, q in zip(res, quoted):
            h = r.hypotheses[0]
            o = tok.decode(tok.convert_tokens_to_ids(h[1:] if h and h[0] == tgt else h), skip_special_tokens=True).strip()
            out.append(f"“{o.strip(QUOTES)}”" if q else o)
        return out

    def too_short(src_text, zh_text):
        # NLLB 偶尔只译出前半句：中文字数明显少于原文应有的长度
        return len(src_text.split()) >= 6 and len(re.sub(r"\W", "", zh_text)) < len(src_text) * 0.2

    zh = []
    for b in range(0, len(flat), 64):  # 分批翻译以便报告进度
        batch = flat[b:b + 64]
        pieces, owner = [], []
        for n, t in enumerate(batch):
            # 引语与叙述分开翻译（NLLB 常漏译 « … » s'exclame X 里的引语），长句再在逗号处切开
            # 直引号 "…" 也一样：开引号前、闭引号后切开
            for q in re.split(r"(?<=[»”])\s+|(?<=[,.!?…]\")\s+|\s+(?=[«“])|\s+(?=\"\w)", t):
                for p in ts.split_long(q, max_words=12, min_words=4):
                    pieces.append(p); owner.append(n)
        outs = tx(pieces)
        # 译文过短的片段：在每个逗号处切开重译
        for j, (p, o) in enumerate(zip(pieces, outs)):
            if too_short(p, o):
                subs = [x for x in re.split(r"(?<=[,;:])\s+", p) if x.strip()]
                if len(subs) > 1:
                    outs[j] = re.sub(r"([：；，:;,])，", r"\1", "，".join(x.rstrip(",;，；") for x in tx(subs)))
        parts = [[] for _ in batch]
        for n, o in zip(owner, outs):
            parts[n].append(o)
        for ps in parts:
            out = ""
            for k, x in enumerate(ps):
                x = x.translate(ts.FULLWIDTH)
                if k < len(ps) - 1:
                    x = x.rstrip(",;，；")
                # 片段之间补逗号；前一段已以句末标点或引号结尾则不补
                out += x if not out or re.search(r"[。！？…」』”»\"：；，]$", out) else "，" + x
            zh.append(re.sub(r"\s*([，。？！：；])\s*", r"\1", out))
        print(f"[{min(b + 64, len(flat))}/{len(flat)}]", flush=True)
    return zh


# ---------- 收件箱：一个文件或一个文件夹 = 一篇文章 ----------
IMG = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".pdf")


def ingest(docdir, item, done, engine):
    if os.path.isdir(item):
        files = sorted(os.path.join(item, f) for f in os.listdir(item) if not f.startswith("."))
    else:
        files = [item]
    imgs = [f for f in files if f.lower().endswith(IMG)]
    txts = [f for f in files if f.lower().endswith((".txt", ".md"))]
    if not imgs and not txts:
        raise SystemExit("Aucune image ni fichier texte")
    parts, title, lang = [], "", ""
    for t in txts:
        parts.append(open(t, encoding="utf-8-sig", errors="replace").read().strip())
    if imgs:
        print(f"Reconnaissance du texte ({len(imgs)} image(s))…", flush=True)
        r = ocr(imgs, engine)
        parts.append(r["text"]); title, lang = r["title"], r["lang"]
    text = "\n\n".join(p for p in parts if p)
    if not text.strip():
        raise SystemExit("Aucun texte reconnu")
    meta = json.load(open(os.path.join(docdir, "meta.json"), encoding="utf-8"))
    meta["title"] = title or meta.get("title") or os.path.splitext(os.path.basename(item))[0]
    meta["lang"] = lang or guess_lang(text)
    open(os.path.join(docdir, "source.txt"), "w", encoding="utf-8").write(text)
    json.dump(meta, open(os.path.join(docdir, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"« {meta['title']} » ({meta['lang']}), {len(text)} caractères", flush=True)
    build(docdir, engine)
    # 处理成功：原文件移到已处理文件夹（重名时加序号）
    os.makedirs(done, exist_ok=True)
    base = os.path.basename(item.rstrip("/\\")); dst = os.path.join(done, base); n = 2
    while os.path.exists(dst):
        stem, ext = os.path.splitext(base); dst = os.path.join(done, f"{stem} ({n}){ext}"); n += 1
    shutil.move(item, dst)


def guess_lang(t):
    w = re.findall(r"[a-zàâçéèêëîïôûùœ'’]+", t.lower())[:600]
    fr = sum(1 for x in w if x in {"le", "la", "les", "des", "une", "est", "et", "je", "vous", "que", "qui", "pas", "pour", "dans", "sur", "avec", "il", "elle", "du", "au"} or re.search(r"[àâçéèêëîïôûùœ]", x))
    en = sum(1 for x in w if x in {"the", "and", "is", "was", "you", "he", "she", "it", "of", "to", "in", "that", "for", "with", "they", "are", "have", "not", "but"})
    return "fr" if fr > en else "en"


# ---------- 导出音频播放列表 ----------
def ts_(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def export(docdir, outdir, voice, speaker):
    from piper import PiperVoice, SynthesisConfig
    meta = json.load(open(os.path.join(docdir, "meta.json"), encoding="utf-8"))
    doc = json.load(open(os.path.join(docdir, "doc.json"), encoding="utf-8"))
    model = os.path.join(models.MODELS, "piper", voice + ".onnx")
    if not os.path.exists(model):
        from pathlib import Path
        from piper.download_voices import download_voice
        print(f"Téléchargement de la voix {voice}…", flush=True)
        download_voice(voice, Path(os.path.dirname(model)))
    v = PiperVoice.load(model)
    cfg = SynthesisConfig(speaker_id=speaker)

    os.makedirs(outdir, exist_ok=True)
    name = safe(meta.get("title") or "texte")
    wav_path = os.path.join(outdir, name + ".wav.part")
    total = sum(len(p) for p in doc["paragraphs"])
    src_srt, zh_srt, t, n = [], [], 0.4, 0
    with wave.open(wav_path, "wb") as out:
        rate = None
        for pi, para in enumerate(doc["paragraphs"]):
            for s, z in para:
                chunks = list(v.synthesize(s, syn_config=cfg))
                if rate is None:
                    rate = chunks[0].sample_rate
                    out.setnchannels(1); out.setsampwidth(2); out.setframerate(rate)
                    out.writeframes(b"\0\0" * int(0.4 * rate))
                pcm = b"".join(c.audio_int16_bytes for c in chunks)
                dur = len(pcm) / 2 / rate
                n += 1
                src_srt.append(f"{n}\n{ts_(t)} --> {ts_(t + dur)}\n{s}\n")
                zh_srt.append(f"{n}\n{ts_(t)} --> {ts_(t + dur)}\n{z}\n")
                gap = 0.8
                out.writeframes(pcm + b"\0\0" * int(gap * rate))
                t += dur + gap
                print(f"[{n}/{total}]", flush=True)
            out.writeframes(b"\0\0" * int(0.7 * rate))   # 段落之间多停一会儿
            t += 0.7

    # 转为 MP3，体积约为 WAV 的 1/10，便于拷到树莓派
    mp3 = os.path.join(outdir, name + ".mp3")
    exe = shutil.which("ffmpeg")
    if not exe:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([exe, "-nostdin", "-v", "error", "-y", "-i", wav_path, "-ac", "1", "-b:a", "64k", mp3], check=True)
    os.remove(wav_path)
    with open(os.path.join(outdir, name + ".srt"), "w", encoding="utf-8") as f:
        f.write("\n".join(src_srt))
    with open(os.path.join(outdir, name + ".zh.srt"), "w", encoding="utf-8") as f:
        f.write("\n".join(zh_srt))
    print(f"Terminé : {os.path.basename(outdir)}/{name}.mp3 ({int(t // 60)} min {int(t % 60)} s)", flush=True)


def safe(s):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", s).strip().rstrip(".")[:80] or "texte"


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("ocr"); o.add_argument("images", nargs="+"); o.add_argument("--engine", default="local")
    b = sub.add_parser("build"); b.add_argument("docdir"); b.add_argument("--engine", default="local")
    g = sub.add_parser("ingest"); g.add_argument("docdir"); g.add_argument("item"); g.add_argument("--done", required=True)
    g.add_argument("--engine", default="ai")
    e = sub.add_parser("export"); e.add_argument("docdir"); e.add_argument("outdir")
    e.add_argument("--voice", required=True); e.add_argument("--speaker", type=int, default=None)
    a = ap.parse_args()
    if a.cmd == "ocr":
        print(json.dumps(ocr(a.images, a.engine), ensure_ascii=False), flush=True)
    elif a.cmd == "build":
        build(a.docdir, a.engine)
    elif a.cmd == "ingest":
        ingest(a.docdir, a.item, a.done, a.engine)
    else:
        export(a.docdir, a.outdir, a.voice, a.speaker)


if __name__ == "__main__":
    sys.exit(main())
