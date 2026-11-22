#!/usr/bin/env bash
SLUG=netq
[ -f "./ui.js" ] || { echo "[$SLUG] 升级包内缺少 ui.js" >&2; exit 1; }
printf '[%s] 升级完成\n' "$SLUG"
