#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}"
if [[ ! -f dist/router-cli.js || ! -f web/dist/index.html ]]; then
  print 'Build the router first. See README.md for setup commands.'
  read -r '?Press Return to close.'
  exit 1
fi
exec node dist/router-cli.js dashboard --open
