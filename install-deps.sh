#!/bin/bash
# Install dependencies for r3 — a 3D cyberpunk front end for radare2.
# Tested on:
# - Ubuntu 26.04.1 LTS (Orbstack)
set -e

# radare2 must be installed on the host (r3 drives the real r2 binary)
if ! command -v r2 &> /dev/null; then
    echo "[!] radare2 (r2) not found in PATH."
    echo "    Install it from source:"
    echo "      git clone https://github.com/radareorg/radare2 ~/radare2"
    echo "      ~/radare2/sys/install.sh"
    exit 1
fi
echo "[+] $(r2 -v | head -1)"

# NVM installation
if ! command -v nvm &> /dev/null; then
    if [ ! -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
    fi
fi

# Ensure NVM is available even on subsequent runs
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Node.js installation
if ! command -v node &> /dev/null; then
    nvm install 22
    nvm use 22
fi
echo "[+] node $(node -v)"

# Project dependencies (three, postprocessing, troika-three-text, gsap, xterm, express, ws, vite, ...)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
npm install

echo ""
echo "Dependencies installed."
echo "  npm run dev     # start server (:3133) + vite (:5173) -> open http://localhost:5173"
echo "  npm run build   # production build"
echo "  npm start       # serve production build on http://localhost:3133"
