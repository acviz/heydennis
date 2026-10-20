#!/bin/bash
# D.E.N.N.I.S. - run from source on macOS / Linux. Double-click (macOS) or ./start.command.
# First run installs dependencies (a few hundred MB, a few minutes).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Get the LTS version from https://nodejs.org"
  echo "  (or: brew install node), then run this again."
  echo
  read -r -p "  Press Enter to close." _
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "  First run: installing dependencies. This takes a few minutes and is not stuck."
  npm install || { echo; echo "  npm install failed - the reason is above."; read -r -p "  Press Enter to close." _; exit 1; }
fi

npm start
