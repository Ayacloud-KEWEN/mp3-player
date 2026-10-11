@echo off
rem 电脑版工具环境安装：在程序目录 tools\.venv 中创建 Python 环境（需已安装 Python 3.10+ 与 NVIDIA 显卡驱动）
cd /d "%~dp0"
python -m venv .venv || goto :err
.venv\Scripts\python -m pip install -r requirements.txt || goto :err
rem torch 仅用于首次转换翻译模型，CPU 版即可
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu || goto :err
echo.
echo 完成。模型会在第一次使用时自动下载到 tools\models\。
pause
exit /b 0
:err
echo 安装失败，请查看上面的错误信息。
pause
exit /b 1
