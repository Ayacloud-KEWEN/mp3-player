#!/bin/sh
# 树莓派：安装"日常句子"所需的 Piper 语音合成（只需运行一次）
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install piper-tts
# 预先下载默认法语男声（也可在 .env 里用 PIPER_VOICE 换别的声音，首次使用时自动下载）
.venv/bin/python -m piper.download_voices --download-dir models/piper "${PIPER_VOICE:-fr_FR-tom-medium}"
echo "完成。重启服务：sudo systemctl restart lyra"
