#!/bin/bash
# NMOS Controller: netplan設定反映用ラッパースクリプト
#
# control.py (sync_netplan) から `sudo` 経由で実行される。
# sudoers でNOPASSWD許可される唯一の対象として、
# 引数を受け取らず、固定パスの一時ファイルを固定パスのnetplan設定へ
# コピーするだけの処理に限定している（任意コマンド実行を防ぐ設計）。
#
# {{NETPLAN_PATH}} は deploy.sh がデプロイ時に、実際のサーバー上の
# netplan設定ファイルパス（/etc/netplan/*.yaml を検出した結果）へ
# 置換する。

set -euo pipefail

SRC="/tmp/nmos-netplan-new.yaml"
DST="{{NETPLAN_PATH}}"

if [ ! -f "$SRC" ]; then
    echo "エラー: 一時ファイルが見つかりません: $SRC" >&2
    exit 1
fi

cp "$SRC" "$DST"
