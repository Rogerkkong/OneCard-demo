#!/usr/bin/env bash
# Start OneCard Lab (docs/DESIGN.md §13). Linux: ./start-onecard-lab.sh, or "Run in Terminal"
# from the file manager. macOS: double-click "Start OneCard Lab.command", which runs this file.
#
# It finds Node.js, also where a double-click does not look (nvm, Volta, fnm, asdf, Homebrew),
# then scripts/launch.cjs checks the version, installs the libraries the first time and starts
# the lab in the web browser. Close the window, or press Ctrl+C, to stop the lab.

cd "$(dirname "$0")" || exit 1
[ -t 1 ] && printf '\033]0;OneCard Lab\007' # the window's title, to find it again

if [ ! -f scripts/launch.cjs ]; then
  echo
  echo "  Some files of OneCard Lab are missing next to this one. Unzip the whole folder first,"
  echo "  then start it from the unzipped folder."
  echo "  OneCard Lab 的文件不全。请先把整个文件夹解压，再从解压后的文件夹启动。"
  echo
  read -r -p "Press Enter to close. / 按 Enter 关闭。" _ || true
  exit 1
fi

has_node() { command -v node >/dev/null 2>&1; }
# 22.13 or newer, asked in syntax any Node.js understands
new_enough() { "$1" -e 'var v=process.versions.node.split(".");process.exit(+v[0]>22||(+v[0]==22&&+v[1]>=13)?0:1)' >/dev/null 2>&1; }

# A double-click from Finder (or a file manager) does not always read the shell setup that puts
# node on PATH, and an older Node.js may come first there: then look in the usual places too, and
# take the first Node.js that is new enough (else keep the one on PATH, or take the first one
# found, and launch.cjs says it is too old).
if ! has_node || ! new_enough node; then
  nvm_node=""
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    nvm_node=$(export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; command -v node 2>/dev/null)
  fi
  first=""
  for dir in "${nvm_node%/node}" "$HOME/.volta/bin" \
    "$HOME/.fnm/aliases/default/bin" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin" \
    "$HOME/.local/share/fnm/aliases/default/bin" \
    "$HOME/.asdf/shims" \
    /opt/homebrew/bin /usr/local/bin /opt/local/bin; do
    [ -n "$dir" ] && [ -x "$dir/node" ] || continue
    [ -n "$first" ] || first="$dir"
    if new_enough "$dir/node"; then
      first="$dir"
      break
    fi
  done
  [ -z "$first" ] || PATH="$first:$PATH"
fi
export PATH

if ! has_node; then
  cat <<'EOF'

  OneCard Lab needs Node.js, and this computer does not have it yet.
  Install the LTS version from https://nodejs.org/en/download (the page is opening now),
  then start OneCard Lab again.

  OneCard Lab 需要 Node.js，这台电脑还没有安装。
  请从 https://nodejs.org/en/download 安装 LTS 版本（网页正在打开），
  装好后再启动 OneCard Lab。

EOF
  if [ "$(uname)" = Darwin ]; then
    open "https://nodejs.org/en/download" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "https://nodejs.org/en/download" >/dev/null 2>&1 &
  fi
  read -r -p "Press Enter to close. / 按 Enter 关闭。" _ || true
  exit 1
fi

exec node scripts/launch.cjs "$@"
