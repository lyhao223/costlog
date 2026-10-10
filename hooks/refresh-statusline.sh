#!/bin/sh
# Rewrites the cached status line after a turn; the status line itself only reads that file, so it stays instant.
dir="${COSTLOG_CACHE_DIR:-$HOME/.cache/costlog}"
out="$dir/statusline.txt"
mkdir -p "$dir" || exit 0
# A turn can end many times a minute; one refresh a minute is enough for a daily total.
[ -n "$(find "$out" -mmin -1 2>/dev/null)" ] && exit 0
# Claude Code stops a hook's processes when the session ends, often right after the last turn, so the refresh
# runs in its own session where that signal does not reach it.
refresh='${COSTLOG_BIN:-npx --yes costlog} statusline > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"; rm -f "$1.tmp"'
if command -v perl > /dev/null 2>&1; then
  perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exec @ARGV' sh -c "$refresh" sh "$out" > /dev/null 2>&1
else
  nohup sh -c "$refresh" sh "$out" > /dev/null 2>&1 &
fi
exit 0
