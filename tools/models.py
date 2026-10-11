"""模型管理：所有模型都放在 tools/models/ 下，首次使用时自动下载 / 转换。"""
import os, glob, site, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
os.environ.setdefault("HF_HOME", os.path.join(MODELS, ".hf"))  # 下载缓存也放在程序目录

# Windows 下让 pip 安装的 CUDA 库可被找到
for sp in site.getsitepackages():
    for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]

# 翻译模型：专用语言对优先，其他语言对用 NLLB（多语种）
TRANSLATORS = {
    ("en", "fr"): "Helsinki-NLP/opus-mt-tc-big-en-fr",
}
NLLB = os.environ.get("LYRA_NLLB", "facebook/nllb-200-distilled-1.3B")
NLLB_CODES = {"en": "eng_Latn", "fr": "fra_Latn", "zh": "zho_Hans", "de": "deu_Latn",
              "es": "spa_Latn", "it": "ita_Latn", "ja": "jpn_Jpan", "ru": "rus_Cyrl"}


def whisper_path(name="large-v3"):
    """返回本地 faster-whisper 模型目录（没有则下载）。"""
    dst = os.path.join(MODELS, f"faster-whisper-{name}")
    if not os.path.exists(os.path.join(dst, "model.bin")):
        from huggingface_hub import snapshot_download
        print(f"Téléchargement du modèle de reconnaissance {name} (~3 Go, une seule fois)…", flush=True)
        snapshot_download(f"Systran/faster-whisper-{name}", local_dir=dst)
    return dst


def translator_path(src, tgt):
    """返回 (CTranslate2 模型目录, 是否 NLLB)。目录里同时保存分词器，运行时无需联网。"""
    hf = TRANSLATORS.get((src, tgt))
    nllb = hf is None
    if nllb:
        if src not in NLLB_CODES or tgt not in NLLB_CODES:
            raise SystemExit(f"Paire de langues non prise en charge : {src}→{tgt}")
        hf = NLLB
    dst = os.path.join(MODELS, hf.split("/")[1])
    if not os.path.exists(os.path.join(dst, "model.bin")):
        print(f"Téléchargement et conversion du modèle de traduction {hf} (une seule fois)…", flush=True)
        from ctranslate2.converters import TransformersConverter
        from transformers import AutoTokenizer
        tmp = dst + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        TransformersConverter(hf).convert(tmp, quantization="float16")
        AutoTokenizer.from_pretrained(hf).save_pretrained(tmp)
        os.replace(tmp, dst)
    # 转换完成后删掉原始下载，节省空间（Windows 上刚转换完文件可能被占用，下次运行时再删）
    shutil.rmtree(os.path.join(os.environ["HF_HOME"], "hub", "models--" + hf.replace("/", "--")), ignore_errors=True)
    return dst, nllb
