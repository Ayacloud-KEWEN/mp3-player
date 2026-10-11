# Lyra 听读 —— 外语学习音频播放器

零依赖 Node.js（≥16）服务，手机浏览器访问 `http://树莓派IP:10020`。

## 目录约定
```
MEDIA_DIR/
  英语听力/            ← 每个子目录 = 一个播放列表（按文件名自然排序连续播放）
    lesson01.mp3
    lesson01.srt       ← 同名字幕（.srt / .vtt / .lrc）自动加载
```

## 树莓派部署
```bash
cp .env.example .env      # 修改 MEDIA_DIR
node server.js
```
开机自启（systemd）：`/etc/systemd/system/lyra.service`
```ini
[Unit]
Description=Lyra player
After=network.target
[Service]
WorkingDirectory=/home/pi/mp3-player
ExecStart=/usr/bin/node server.js
Restart=always
User=pi
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now lyra`

## 功能
- 大播放键、一键慢速（默认 0.8×，可设置）、倍速 0.5–2×（保持音调）
- 字幕滚动同步；点句跳转，长按句子复读
- 单句复读 / A-B 区间复读，次数 2/3/5/10/∞，每遍间停顿（可"按句长"留出跟读时间）
- 跟读模式：每句后自动停顿再继续
- 盲听模式：字幕模糊，点击才显示（听写/精听）
- 收藏句子 ✦，之后一键回到并复读
- 记住播放列表/曲目/进度/设置；锁屏与耳机线控（上/下一句）；定时停止；明暗主题

## 双语阅读（电脑版）
电脑上打开 `http://localhost:10020/read.html`（或设置 ☰ → Outils →「📖 Lecture bilingue」）：
- 「+ Nouveau texte」：粘贴英语/法语文字、拖入 .txt，或拍照/截图（拖入、选择或 Ctrl+V 粘贴）自动识别文字（EasyOCR）。识别后可先修改再创建
- 自动分句并译成中文（NLLB 1.3B，离线）
- 三种显示：Côte à côte（左右对照）/ Alterné（逐句交替）/ Original seul（只看原文，点「文」或按 T 显示译文）
- 朗读：句子旁 ▶ 朗读单句；「▶ Lire」连续朗读并高亮；「Répéter」每句后停顿跟读；可选 0.8/1.0/1.2 倍速
- 点单词：Piper 朗读/慢速、词典链接、加入日常句子
- 「⤓ Playlist audio」：整篇合成为 `lectures/<标题>/` 下的 MP3 + 原文字幕 + 中文字幕，拷到树莓派后手机即可边听边看
- 键盘：↑↓ 上一句/下一句，空格 朗读/暂停，T 显示译文，Esc 关闭查词

### DeepSeek 识别与翻译、收件箱 books/
- 在 `.env` 填 `DEEPSEEK_API_KEY=`（见 `.env.example`），阅读页左下角「IA」点「Vérifier」：自动选择账号可用的文字 / 图片模型
- 把文章照片或 .txt 放进 `books/`（一个子文件夹 = 一篇多页文章），阅读页左侧「BOÎTE」点「Traiter maintenant」：
  DeepSeek 识别正文（长图自动切条）→ 判断语言、起标题 → 带上下文整篇逐句翻译；处理完的原文件移到 `books/_traité/`
- 导入页可选「Moteur : DeepSeek / local」；已有文章可「↻ Retraduire」
- DeepSeek 不可用或失败时自动退回本地 EasyOCR / NLLB；密钥只在本机 `.env`，不会发给浏览器或上传

## 查单词发音
播放时点一下**当前这句**字幕 → 句子拆成单词（并暂停）；点单词弹出卡片：
- ▶ Original：从录音中截出这个词的原声（需要 `<名>.words.json`，由新版生成字幕工具自动生成；旧字幕需重新生成一次）
- ▶ Voix / ▶ Lent：Piper 标准朗读（法语 tom，英语 en_GB-alan，`PIPER_VOICE_EN` 可换）
- 链接：Google 翻译、维基词典、Forvo、WordReference、Larousse
- 法语可一键把单词加入「Vocabulaire」分组，或把整句加入日常句子

## 日常句子（随时记录法语句子并跟读）
播放列表抽屉顶部的「✎ Gérer les phrases du quotidien」：
- 输入法语句子 → 自动用 Piper 男声合成；每个分组生成一个播放列表（名称前带 ✦），可单句复读、慢速、跟读、盲听
- 分组：+ Groupe 新建，可改名、删除；句子可编辑、试听、上下移动、移到其他分组
- 数据保存在 `MEDIA_DIR/.phrases/`，所有设备共享

树莓派上首次使用前安装 Piper（约 1 分钟）：
```bash
sh tools/setup-pi.sh
sudo systemctl restart lyra
```
换声音：在 `.env` 里设置 `PIPER_VOICE`（见 `.env.example`）。

## 电脑版：生成字幕与翻译（在界面上操作）
需要 NVIDIA 显卡的 Windows 电脑。所有东西都在程序目录里：Python 环境在 `tools/.venv`，模型在 `tools/models/`。

1. 首次安装环境：双击 `tools/setup.bat`
2. 启动：双击 `start-pc.bat`（会开启工具并打开浏览器）。也可以在 `.env` 里写 `ENABLE_TOOLS=1` 再 `node server.js`
3. 打开设置 ☰ →「Outils · ordinateur」：选播放列表、音频语言，然后点
   - Générer les sous-titres —— 用 Whisper large-v3 生成 `<名>.srt`
   - Traduire EN → FR —— OPUS-MT，生成 `<名>.fr.srt`
   - Traduire EN → 中文 / FR → 中文 —— NLLB-200 1.3B，生成 `<名>.zh.srt`
   任务排队执行，进度实时显示；完成后当前播放的字幕会自动更新
4. 把生成的 `.srt` 拷到树莓派上同一目录即可

模型首次使用时自动下载（Whisper ~3GB，NLLB ~2.6GB，OPUS-MT ~0.5GB）。
工具默认只允许本机浏览器使用；树莓派上不要开启 `ENABLE_TOOLS`。

命令行用法同样可用：
```bash
tools/.venv/Scripts/python tools/gen_subs.py <目录> --lang en
tools/.venv/Scripts/python tools/translate_subs.py <目录> --src en --tgt zh
```

### 播客订阅（电脑版）
设置 ☰ →「Outils · ordinateur」→ PODCASTS：粘贴 Apple Podcasts 链接或 RSS 地址，选择下载最近几期，点「S’abonner」。
- 节目下载到 `fra/podcasts/<节目名>/`（可用 `.env` 的 `PODCAST_DIR` 修改），文件名带发布日期
- 「Nouveautés」下载新出的几期；「Épisodes」列出最近 30 期，可单独下载
- 下载后在同一面板选择该播放列表，音频语言选 Français，生成字幕和译文，再拷到树莓派
- 播放列表支持多层文件夹（如 `fra/podcasts/On va déguster`），每个含音频的文件夹都是一个列表

> 英文原版书建议用 **EN → 中文** 直接翻译；经法语中转（FR → 中文）会损失意思，适合本身就是法语的音频。
