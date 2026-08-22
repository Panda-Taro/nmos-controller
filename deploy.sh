#!/bin/bash
# NMOS Controller 初回デプロイスクリプト
#
# 実行方法:
#   $ ./deploy.sh
#   (すでに ~/nmos-controller に clone 済みの場合は、そのディレクトリ内で
#    実行しても、別の場所からダウンロードして実行しても構わない)
#
# このスクリプトはrootでは実行しないこと。内部で必要な箇所のみ
# 対話的に sudo を使用する（初回デプロイのみのため NOPASSWD 化はしない）。

set -euo pipefail

REPO_URL="https://github.com/Panda-Taro/nmos-controller.git"
INSTALL_DIR="$HOME/nmos-controller"

# ==========================================
# 0. root実行チェック
# ==========================================
if [ "$(id -u)" -eq 0 ]; then
    echo "エラー: このスクリプトはroot(sudo)で実行しないでください。" >&2
    echo "一般ユーザーで実行してください（必要な箇所のみ内部でsudoを使います）。" >&2
    exit 1
fi

ACCOUNT_NAME="$(whoami)"
echo "==> 実行アカウント: ${ACCOUNT_NAME}"
echo "==> インストール先: ${INSTALL_DIR}"

# ==========================================
# 1. GitHubからclone（既存なら pull）
# ==========================================
if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "==> 既存リポジトリを検出。git pull します。"
    git -C "${INSTALL_DIR}" pull
else
    echo "==> リポジトリをcloneします。"
    git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

# ==========================================
# 2. data/, logs/, sdp/ を作成
# ==========================================
echo "==> data/, logs/, sdp/ ディレクトリを作成します。"
mkdir -p "${INSTALL_DIR}/data" "${INSTALL_DIR}/logs" "${INSTALL_DIR}/sdp"

# ==========================================
# 3. data/config.json が無ければ新規作成
#    （存在する場合は運用中の設定を壊さないため上書きしない）
# ==========================================
CONFIG_JSON="${INSTALL_DIR}/data/config.json"

if [ -f "${CONFIG_JSON}" ]; then
    echo "==> data/config.json は既に存在するためスキップします。"
else
    echo "==> data/config.json を新規作成します（ダミー値）。"
    cat > "${CONFIG_JSON}" <<EOF
{
    "rds": {
        "host": "192.168.1.100",
        "registration_port": 3210,
        "query_port": 3210,
        "node_port": 3210,
        "logging_port": 3210
    },
    "server": {
        "host": "0.0.0.0",
        "port": 80
    },
    "log": {
        "directory": "${HOME}/nmos-controller/logs"
    },
    "nmos_rds": {
        "registry_json_path": "${HOME}/nmos-rds/config/registry.json",
        "compose_directory": "${HOME}/nmos-rds"
    },
    "sdp": {
        "directory": "${HOME}/nmos-controller/sdp"
    }
}
EOF
    # "network" / "program" キーは意図的に含めない。
    # main.py の init_config() が初回起動時に自動補完する。
fi

# ==========================================
# 4. Python仮想環境の作成・依存パッケージインストール
# ==========================================
echo "==> Python仮想環境を作成します。"
# venv/ ディレクトリが存在していても、python3-venv 未インストール等の
# 原因で venv/bin/pip が無い「壊れたvenv」になっている場合があるため、
# ディレクトリの有無だけでなく venv/bin/pip の存在も確認する。
# 壊れていた場合は venv/ を削除してから作り直す。
if [ -d "${INSTALL_DIR}/venv" ] && [ ! -x "${INSTALL_DIR}/venv/bin/pip" ]; then
    echo "    既存のvenv/が壊れているため削除して再作成します。"
    rm -rf "${INSTALL_DIR}/venv"
fi

if [ ! -d "${INSTALL_DIR}/venv" ]; then
    python3 -m venv "${INSTALL_DIR}/venv"
fi

echo "==> 依存パッケージをインストールします。"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"

# ==========================================
# 5. netplanファイルパスの検出
#    main.py の detect_netplan() と同じ方式
#    （/etc/netplan/*.yaml をソートして先頭を採用）で検出する。
#    この検出結果を nmos-apply-netplan.sh の反映先として固定する。
# ==========================================
echo "==> netplan設定ファイルを検出します。"
NETPLAN_PATH="$(ls /etc/netplan/*.yaml 2>/dev/null | sort | head -n1 || true)"
if [ -z "${NETPLAN_PATH}" ]; then
    NETPLAN_PATH="/etc/netplan/50-cloud-init.yaml"
    echo "    /etc/netplan/*.yaml が見つからないため既定値を使用します: ${NETPLAN_PATH}"
else
    echo "    検出結果: ${NETPLAN_PATH}"
fi

# netplan設定ファイルは通常 root:root / 600 (root以外読み取り不可)で
# 生成されるため、非rootで動作する本サービスは現在のIP/GW表示すら
# 読み取れない。本システムは検証用途でセキュリティ要件が低いため、
# 簡易対応として世界読み取り可能にする（書き込み権限は付与しない）。
echo "==> netplan設定ファイルを読み取り可能にします（検証環境向け簡易対応、sudoが必要です）。"
sudo chmod o+r "${NETPLAN_PATH}"

# ==========================================
# 6. nmos-apply-netplan.sh を /usr/local/bin/ に配置
# ==========================================
echo "==> netplan反映ラッパースクリプトを配置します（sudoが必要です）。"
TMP_APPLY_SCRIPT="$(mktemp)"
sed "s|{{NETPLAN_PATH}}|${NETPLAN_PATH}|g" \
    "${INSTALL_DIR}/deploy/nmos-apply-netplan.sh" > "${TMP_APPLY_SCRIPT}"
sudo install -o root -g root -m 755 \
    "${TMP_APPLY_SCRIPT}" /usr/local/bin/nmos-apply-netplan.sh
rm -f "${TMP_APPLY_SCRIPT}"

# ==========================================
# 7. systemdユニットファイルの配置（{{ACCOUNT_NAME}} を置換）
# ==========================================
echo "==> systemdユニットファイルを配置します（sudoが必要です）。"
TMP_SERVICE="$(mktemp)"
sed "s|{{ACCOUNT_NAME}}|${ACCOUNT_NAME}|g" \
    "${INSTALL_DIR}/deploy/nmos-controller.service" > "${TMP_SERVICE}"
sudo install -o root -g root -m 644 \
    "${TMP_SERVICE}" /etc/systemd/system/nmos-controller.service
rm -f "${TMP_SERVICE}"

# ==========================================
# 8. sudoers設定ファイルの配置（{{ACCOUNT_NAME}} を置換、visudo -c チェック）
# ==========================================
echo "==> sudoers設定ファイルを配置します（sudoが必要です）。"
TMP_SUDOERS="$(mktemp)"
sed "s|{{ACCOUNT_NAME}}|${ACCOUNT_NAME}|g" \
    "${INSTALL_DIR}/deploy/nmos-controller.sudoers" > "${TMP_SUDOERS}"

echo "    visudo -c で構文チェックします。"
sudo visudo -c -f "${TMP_SUDOERS}"

sudo install -o root -g root -m 440 \
    "${TMP_SUDOERS}" /etc/sudoers.d/nmos-controller
rm -f "${TMP_SUDOERS}"

# ==========================================
# 9. systemdサービスの有効化・起動
# ==========================================
echo "==> systemdサービスを有効化・起動します（sudoが必要です）。"
sudo systemctl daemon-reload
sudo systemctl enable --now nmos-controller

# ==========================================
# 完了メッセージ
# ==========================================
echo ""
echo "===================================================="
echo " デプロイが完了しました。"
echo ""
echo " 状態確認:   systemctl status nmos-controller"
echo " ログ確認:   journalctl -u nmos-controller -f"
echo ""
echo " data/config.json の rds.host / 各ポート番号等は"
echo " ダミー値で作成されています。実環境に合わせて"
echo " WebGUI（システム設定画面）または直接編集の上、"
echo " sudo systemctl restart nmos-controller"
echo " で反映してください。"
echo "===================================================="
