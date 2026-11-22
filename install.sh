#!/usr/bin/env bash
# netq 是纯前端插件：没有二进制、没有常驻服务、不需要写任何文件。
# 面板已经把 ui.js 解压到插件目录，这里只需自检。
SLUG=netq
[ -f "./ui.js" ] || { echo "[$SLUG] 安装包内缺少 ui.js" >&2; exit 1; }
printf '[%s] 纯前端插件就绪，无服务需启动\n' "$SLUG"
