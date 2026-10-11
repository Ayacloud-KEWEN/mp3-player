"""把字幕逐句翻译成另一种语言，输出 <名>.<tgt>.srt（时间轴不变，逐句对应）。离线运行。

用法: python translate_subs.py <目录> --src en --tgt fr [--force] [--cpu]

源字幕选择：若存在 <名>.<src>.srt（如之前翻译出的 .fr.srt）则用它，否则用原字幕 <名>.srt。
模型放在 tools/models/，首次使用自动下载并转换。
"""
import argparse, os, re, sys
import models  # 设置模型目录与 CUDA 路径，须在 ctranslate2 之前导入
import ctranslate2
from transformers import AutoTokenizer

AUDIO = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac", ".webm"}


def read_srt(path):
    cues = []
    with open(path, encoding='utf-8-sig') as f:
        for block in re.split(r'\n\s*\n', f.read().replace('\r', '').strip()):
            lines = block.split('\n')
            ti = next((i for i, l in enumerate(lines) if '-->' in l), None)
            if ti is not None:
                cues.append((lines[ti], ' '.join(l.strip() for l in lines[ti + 1:])))
    return cues


FULLWIDTH = str.maketrans({',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；'})


def split_long(text, max_words=18, min_words=6):
    """超过 max_words 个词的句子在逗号/分号后切开，每段至少 min_words 个词。"""
    words = text.split()
    if len(words) <= max_words:
        return [text]
    out, cur = [], []
    for k, w in enumerate(words):
        cur.append(w)
        rest = len(words) - k - 1
        if w.endswith((',', ';', ':')) and len(cur) >= min_words and rest >= min_words:
            out.append(' '.join(cur)); cur = []
    if cur:
        out.append(' '.join(cur))
    return out


def jobs(folder, src, tgt, force):
    # 只处理所选文件夹本身（子文件夹是独立的播放列表）
    root = folder
    for names in [os.listdir(root)]:
        lower = {n.lower(): n for n in names}
        for n in sorted(names):
            base, ext = os.path.splitext(n)
            if ext.lower() not in AUDIO:
                continue
            dst = os.path.join(root, f"{base}.{tgt}.srt")
            if os.path.exists(dst) and not force:
                continue
            for cand in (f"{base}.{src}.srt", f"{base}.srt"):
                if cand.lower() in lower:
                    yield os.path.join(root, lower[cand.lower()]), dst
                    break


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--src', default='en')
    ap.add_argument('--tgt', default='fr')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--cpu', action='store_true')
    a = ap.parse_args()

    todo = list(jobs(a.dir, a.src, a.tgt, a.force))
    if not todo:
        print("Rien à traduire (traductions déjà présentes ou sous-titres manquants)", flush=True)
        return
    path, nllb = models.translator_path(a.src, a.tgt)
    tok = AutoTokenizer.from_pretrained(path, **({"src_lang": models.NLLB_CODES[a.src]} if nllb else {}))
    tr = ctranslate2.Translator(path, device='cpu' if a.cpu else 'cuda')
    prefix = [[models.NLLB_CODES[a.tgt]]] if nllb else None

    for i, (src, dst) in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {os.path.basename(src)} → {os.path.basename(dst)}", flush=True)
        cues = read_srt(src)
        # NLLB 遇到长句容易漏译后半句：先在逗号处切成小段分别翻译，再拼回去
        pieces, owner = [], []
        for n, (_, t) in enumerate(cues):
            for p in (split_long(t) if nllb else [t]):
                pieces.append(p); owner.append(n)
        toks = [tok.convert_ids_to_tokens(tok.encode(t)) for t in pieces]
        res = tr.translate_batch(toks, max_batch_size=32, beam_size=4, max_decoding_length=400, disable_unk=True,
                                 target_prefix=prefix * len(toks) if prefix else None)
        parts = [[] for _ in cues]
        for n, r in zip(owner, res):
            h = r.hypotheses[0]
            if nllb and h and h[0] == models.NLLB_CODES[a.tgt]:
                h = h[1:]  # 去掉目标语言标记
            parts[n].append(tok.decode(tok.convert_tokens_to_ids(h), skip_special_tokens=True).strip())
        out = []
        for ps in parts:
            if a.tgt in ('zh', 'ja'):  # 中日文用全角标点，片段之间用全角逗号
                ps = [x.rstrip('.,;，。；') if k < len(ps) - 1 else x for k, x in enumerate(ps)]
                text = re.sub(r'\s*([，。？！：；])\s*', r'\1', '，'.join(ps).translate(FULLWIDTH))
            else:
                text = ' '.join(ps)
            out.append(text)
        tmp = dst + '.part'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write('\n'.join(f'{n}\n{tl}\n{t}\n' for n, ((tl, _), t) in enumerate(zip(cues, out), 1)))
        os.replace(tmp, dst)
        print(f"    -> {len(out)} phrases", flush=True)


if __name__ == '__main__':
    sys.exit(main())
