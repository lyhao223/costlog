#!/bin/sh
# Rewrites the cached status line after a turn; the status line itself only reads that file, so it stays instant.
dir="${COSTLOG_CACHE_DIR:-$HOME/.cache/costlog}"
out="$dir/statusline.txt"
mkdir -p "$dir" || exit 0
# A turn can end many times a minute; one refresh a minute is enough for a daily total.
[ -n "$(find "$out" -mmin -1 2>/dev/null)" ] && exit 0
${COSTLOG_BIN:-npx --yes costlog} statusline > "$out.tmp" 2>/dev/null && mv "$out.tmp" "$out"
rm -f "$out.tmp"
exit 0
