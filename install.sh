#!/usr/bin/env sh
# One-line install, no clone needed:
#   curl -fsSL https://raw.githubusercontent.com/yjacket/omo-limitless/master/install.sh | sh
# Run from a clone (sh install.sh) it copies the local files instead.
set -e

tarball="https://codeload.github.com/yjacket/omo-limitless/tar.gz/refs/heads/master"
agent="${OMO_CODING_AGENT_DIR:-${SENPI_CODING_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.omo/agent}}}"
ext="$agent/extensions"
dst="$ext/omo-limitless"
tmp="$ext/omo-limitless.tmp-$$"
work=""
trap 'rm -rf "$tmp" ${work:+"$work"}' EXIT

if [ -f "$0" ] && [ -f "$(dirname "$0")/extension/limitless.mjs" ]; then
	src="$(cd "$(dirname "$0")" && pwd)/extension"
else
	work="$(mktemp -d)"
	curl -fsSL "$tarball" | tar -xz -C "$work"
	src="$work/omo-limitless-master/extension"
fi
mkdir -p "$ext"
rm -rf "$tmp"
cp -R "$src" "$tmp"
rm -rf "$dst"
mv "$tmp" "$dst"
# index.js is the entry omo loads, so it goes in last: the folder is never loadable half-copied.
cp "$dst/limitless.mjs" "$dst/index.js"
echo "installed -> $dst"
echo "Type /reload in running omo sessions."
