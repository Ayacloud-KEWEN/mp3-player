"""DeepSeek API：图片识别（视觉模型）与整篇翻译。只用标准库发请求。

密钥与模型来自环境变量（server.js 从 .env 读入后传给子进程）：
  DEEPSEEK_API_KEY、DEEPSEEK_MODEL（文字，可空）、DEEPSEEK_VISION_MODEL（视觉，可空）
模型留空时自动选择，探测结果缓存在 tools/models/deepseek.json。
"""
import base64, io, json, os, time, urllib.error, urllib.request
import models

BASE = (os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
CACHE = os.path.join(models.MODELS, "deepseek.json")


def key():
    k = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not k:
        raise SystemExit("DEEPSEEK_API_KEY manquant dans .env")
    return k


def call(path, body=None, timeout=180, retries=2):
    for attempt in range(retries + 1):
        req = urllib.request.Request(BASE + path, method="POST" if body else "GET",
                                     data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": "Bearer " + key(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 502, 503) and attempt < retries:
                time.sleep(3 * (attempt + 1)); continue
            raise RuntimeError(f"DeepSeek HTTP {e.code} : {msg}")
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(3); continue
            raise RuntimeError(f"DeepSeek injoignable : {e.reason}")


class Truncated(RuntimeError):
    pass


def chat(model, messages, json_mode=False, max_tokens=16000):
    # 识别与翻译不需要"思考"：关闭推理，更快更省，也避免推理占满输出额度导致回复为空
    body = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens, "stream": False,
            "thinking": {"type": "disabled"}}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    r = call("/chat/completions", body)
    c = r["choices"][0]
    if c.get("finish_reason") == "length":
        raise Truncated("réponse tronquée (trop longue)")
    if not (c["message"].get("content") or "").strip():
        raise RuntimeError("réponse vide")
    return c["message"]["content"]


# ---------- 模型选择 ----------
def tiny_png():
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (32, 32), "white").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def pick_models(refresh=False):
    """返回 {"text": id, "vision": id 或 None, "all": [...]}。"""
    if not refresh and os.path.exists(CACHE):
        c = json.load(open(CACHE, encoding="utf-8"))
        if c.get("key_tail") == key()[-4:]:
            return c
    ids = [m["id"] for m in call("/models").get("data", [])]
    text = os.environ.get("DEEPSEEK_MODEL") or next((i for i in ("deepseek-chat", "deepseek-flash") if i in ids), ids[0] if ids else "deepseek-chat")
    vision = os.environ.get("DEEPSEEK_VISION_MODEL") or None
    if not vision:
        # 视觉模型名称不固定：名字里带 vision/vl 的优先，然后逐个试发一张小图
        cands = sorted(ids, key=lambda i: (not any(k in i for k in ("vision", "vl")), i))
        for m in cands:
            try:
                chat(m, [{"role": "user", "content": [
                    {"type": "text", "text": "Reply OK."},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + tiny_png()}}]}], max_tokens=5)
                vision = m
                break
            except Exception:
                continue
    c = {"text": text, "vision": vision, "all": ids, "key_tail": key()[-4:], "checked": int(time.time())}
    json.dump(c, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return c


# ---------- 图片识别 ----------
def strips(path, max_side=1600):
    """长图切成上下重叠的几条，每条都足够清晰（视觉模型每张图的分辨率有限）。返回 JPEG base64 列表。"""
    from PIL import Image, ImageOps
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    w, h = img.size
    if w > max_side:
        img = img.resize((max_side, round(h * max_side / w))); w, h = img.size
    n = max(1, round(h / (w * 0.75)))          # 每条大约 4:3
    step, over = h / n, int(h * 0.04)
    out = []
    for k in range(n):
        box = (0, max(0, int(k * step) - over), w, min(h, int((k + 1) * step) + over))
        buf = io.BytesIO(); img.crop(box).save(buf, "JPEG", quality=88)
        out.append(base64.b64encode(buf.getvalue()).decode())
    return out


OCR_PROMPT = """Tu reçois les photos (découpées en bandes qui se chevauchent légèrement, dans l'ordre) d'un article en anglais ou en français.
Transcris fidèlement le TEXTE PRINCIPAL de l'article, dans sa langue d'origine, sans rien traduire ni corriger :
- fusionne les bandes en supprimant les lignes répétées à cause du chevauchement ;
- recolle les mots coupés en fin de ligne ; un paragraphe = un bloc, séparés par une ligne vide ;
- conserve la ponctuation exacte (« », guillemets, apostrophes, accents) ;
- ignore numéros de page, en-têtes/pieds de page, publicités, légendes de photos et menus.
Réponds en JSON : {"title": "titre de l'article (ou court titre résumant le texte)", "lang": "en" ou "fr", "text": "texte transcrit"}"""


def ocr(paths):
    m = pick_models()
    if not m["vision"]:
        raise RuntimeError("Aucun modèle DeepSeek avec reconnaissance d'image disponible pour ce compte")
    content = [{"type": "text", "text": OCR_PROMPT}]
    for p in paths:
        for b in strips(p):
            content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b}})
    r = json.loads(chat(m["vision"], [{"role": "user", "content": content}], json_mode=True, max_tokens=8000))
    return {"title": str(r.get("title", "")).strip(), "lang": "fr" if r.get("lang") == "fr" else "en", "text": str(r.get("text", "")).strip()}


# ---------- 整篇翻译 ----------
TR_PROMPT = """Tu es un traducteur professionnel {src}→chinois simplifié pour un apprenant chinois qui lit le texte original en parallèle.
On te donne les phrases d'un article, numérotées, dans l'ordre. Traduis CHAQUE phrase en chinois simplifié naturel et fidèle,
en tenant compte du contexte de tout l'article (pronoms, termes, noms propres cohérents ; noms propres usuels en chinois).
Une traduction par phrase, même nombre d'éléments, même ordre ; ne fusionne ni ne coupe aucune phrase ; ponctuation chinoise.
Réponds en JSON : {{"zh": ["traduction 1", "traduction 2", ...]}}"""


def translate(sentences, src, log=print, batch=60):
    """逐句对齐翻译；每批带上前文作为上下文。返回与 sentences 等长的列表（失败的位置为 None）。"""
    m = pick_models()["text"]
    lang = "anglais" if src == "en" else "français"
    out = [None] * len(sentences)

    def run(b, n):
        """翻译 sentences[b:b+n]；回复被截断时对半拆开再试。"""
        part = sentences[b:b + n]
        ctx = " ".join(sentences[max(0, b - 8):b])
        user = (f"Contexte précédent (ne pas traduire) : {ctx}\n\n" if ctx else "") + \
               json.dumps({"phrases": [{"n": i + 1, "texte": s} for i, s in enumerate(part)]}, ensure_ascii=False)
        for attempt in range(2):
            try:
                r = json.loads(chat(m, [{"role": "system", "content": TR_PROMPT.format(src=lang)},
                                        {"role": "user", "content": user}], json_mode=True))
                zh = [str(x).strip() for x in r.get("zh", [])]
                if len(zh) == len(part):
                    out[b:b + n] = zh
                    return
                log(f"  nombre de traductions incorrect ({len(zh)}/{len(part)}), nouvel essai")
            except Truncated:
                if n > 1:
                    run(b, n // 2); run(b + n // 2, n - n // 2)
                    return
            except Exception as e:
                log(f"  erreur : {e}")

    for b in range(0, len(sentences), batch):
        run(b, min(batch, len(sentences) - b))
        log(f"[{min(b + batch, len(sentences))}/{len(sentences)}]")
    return out


if __name__ == "__main__":
    import sys
    print(json.dumps(pick_models(refresh="--refresh" in sys.argv), ensure_ascii=False, indent=1))
