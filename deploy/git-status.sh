#!/bin/bash
cd "$1" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree &>/dev/null || exit 0

branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)
dirty=""
git diff --quiet --ignore-submodules HEAD 2>/dev/null || dirty="*"

last_commit=$(git log -1 --format=%cr 2>/dev/null)

ab=$(git rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
if [ -n "$ab" ]; then
  behind=$(echo "$ab" | cut -f1)
  ahead=$(echo "$ab" | cut -f2)
  sync=""
  [ "$ahead" -gt 0 ] && sync="↑${ahead}"
  [ "$behind" -gt 0 ] && sync="${sync}↓${behind}"
  [ -z "$sync" ] && sync="✓"
else
  sync="no upstream"
fi

echo "${branch}${dirty} (${last_commit}) ${sync}"
