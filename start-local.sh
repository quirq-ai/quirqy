#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -f node_modules/next/package.json ]; then
  npm install
fi
exec npm run dev
