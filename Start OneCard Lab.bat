@echo off
rem OneCard Lab for Windows: double-click this file. A window opens and starts the lab, and the
rem lab console opens in your web browser. Close the window, or press Ctrl+C, to stop the lab.
rem (docs/DESIGN.md section 13. This file only finds Node.js; scripts\launch.cjs does the rest:
rem version check, first-time install, start.)
setlocal
cd /d "%~dp0"
if not exist "scripts\launch.cjs" goto notunzipped

where node >nul 2>nul
if not errorlevel 1 goto run
rem Installed but not on PATH yet (this window was opened before the install finished).
if not exist "%ProgramFiles%\nodejs\node.exe" goto nvm
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto run
:nvm
if not defined NVM_SYMLINK goto nonode
if not exist "%NVM_SYMLINK%\node.exe" goto nonode
set "PATH=%NVM_SYMLINK%;%PATH%"

:run
node scripts\launch.cjs %*
exit /b %errorlevel%

:nonode
chcp 65001 >nul
echo.
echo   OneCard Lab needs Node.js, and this computer does not have it yet.
echo   Install the LTS version from https://nodejs.org/en/download (the page is opening now),
echo   then double-click "Start OneCard Lab" again.
echo.
echo   OneCard Lab 需要 Node.js，这台电脑还没有安装。
echo   请从 https://nodejs.org/en/download 安装 LTS 版本（网页正在打开），
echo   装好后再双击 "Start OneCard Lab"。
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:notunzipped
chcp 65001 >nul
echo.
echo   Some files of OneCard Lab are missing next to this one. If you opened the ZIP file,
echo   unzip it first (right-click, Extract All), then double-click "Start OneCard Lab"
echo   in the unzipped folder.
echo.
echo   OneCard Lab 的文件不全。如果你是直接打开 ZIP 文件，请先解压（右键，全部解压缩），
echo   再在解压后的文件夹里双击 "Start OneCard Lab"。
echo.
pause
exit /b 1
