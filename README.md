# NMOS Controller

ST 2110 / NMOS (AMWA IS-04, IS-05準拠) のコントローラーです。FastAPI製の
WebGUI + REST API + WebSocketで、NMOS-RDS(Registration & Discovery
System)と連携してSender/Receiverの接続(TAKE/LEAVE)を制御します。

Ubuntu Server上でsystemdサービスとして常時稼働させ、GitHubからの
`git pull` + サービス再起動で更新する運用を想定しています。

## システム概要

- **言語/フレームワーク**: Python 3 + FastAPI + Uvicorn
- **エントリーポイント**: `main.py`(`data/config.json` の `server.host` /
  `server.port` を読み込んで `uvicorn.run()` を実行)
- **IS-04連携** (`is04.py`): NMOS-RDSのQuery APIをHTTP GETで取得し、
  WebSocketでリアルタイム更新を受信
- **IS-05連携** (`is05.py`): Receiver/DeviceのIS-05エンドポイントに対して
  `PATCH /staged` を送信し、TAKE/LEAVEを実行
- **システム設定** (`control.py`): ネットワーク設定変更、再起動/
  シャットダウン、NMOS-RDSのDocker状態確認、番組ファイル(Join/Leave一括
  制御)など
- **GUI**: `static/gui1`(メイン操作画面)、`static/gui2`(パネル画面)、
  `static/system_gui`(システム設定)、`static/node_gui`(IS-04ノード登録)

## 初回デプロイ手順

対象環境: Ubuntu Server、一般ユーザー実行(root不可)。

```bash
# どのディレクトリから実行しても構わない
# (未clone なら ~/nmos-controller に clone、既にあれば pull する)
curl -fsSL https://raw.githubusercontent.com/Panda-Taro/nmos-controller/main/deploy.sh -o deploy.sh
chmod +x deploy.sh
./deploy.sh
```

すでに手動でcloneしている場合は、`~/nmos-controller` の中で
`./deploy.sh` を実行しても同じ結果になります。

`deploy.sh` は以下を順に行います。

1. root実行でないことを確認
2. GitHubから `~/nmos-controller` にclone(既存なら`git pull`)
3. `data/`, `logs/`, `sdp/` を作成
4. `data/config.json` が無ければダミー値で新規作成(既存なら変更しない)
5. Python仮想環境(`venv/`)を作成し `requirements.txt` をインストール
6. `/etc/netplan/*.yaml` を検出し、netplan反映用ラッパースクリプト
   (`/usr/local/bin/nmos-apply-netplan.sh`)を配置(**sudoが必要**)
7. systemdユニットファイルの `{{ACCOUNT_NAME}}` を実行ユーザー名に
   置換して `/etc/systemd/system/nmos-controller.service` に配置
   (**sudoが必要**)
8. sudoers設定ファイルの `{{ACCOUNT_NAME}}` を実行ユーザー名に置換し、
   `visudo -c` で構文チェックの上 `/etc/sudoers.d/nmos-controller` に
   配置(**sudoが必要**)
9. `systemctl daemon-reload && systemctl enable --now nmos-controller`

デプロイ完了後、**`data/config.json` の `rds.host` 等はダミー値のまま**
なので、実環境の値に書き換えてください(次項参照)。

## 更新手順

バージョンアップは自動化していません。人手で以下を実行します。

```bash
cd ~/nmos-controller
git pull
sudo systemctl restart nmos-controller
```

`requirements.txt` が変更された場合は、再起動前に依存パッケージも
更新してください。

```bash
cd ~/nmos-controller
git pull
venv/bin/pip install -r requirements.txt
sudo systemctl restart nmos-controller
```

`deploy/` 配下のテンプレート(systemdユニット、sudoers、netplan
ラッパー)が更新された場合は、`deploy.sh` を再実行してください
(`data/config.json` は既存があれば上書きされません)。

## ディレクトリ構成

```
~/nmos-controller/
├── main.py, control.py, is04.py, is05.py,
│   materials.py, gui2.py, rest_api.py   # アプリケーション本体
├── static/                               # WebGUI(HTML/JS/CSS)
├── deploy/                               # デプロイ用テンプレート
│   ├── nmos-controller.service           # systemdユニット({{ACCOUNT_NAME}}含む)
│   ├── nmos-controller.sudoers           # sudoers設定({{ACCOUNT_NAME}}含む)
│   └── nmos-apply-netplan.sh             # netplan反映ラッパー({{NETPLAN_PATH}}含む)
├── deploy.sh                             # 初回デプロイスクリプト
├── requirements.txt
├── .gitignore
├── README.md
├── venv/                                 # Python仮想環境 ※Git管理外
├── data/                                 # ※Git管理外(deploy.shが作成)
│   ├── config.json                       # 環境依存設定(IP/ポート等)
│   ├── database.json                     # 素材・GUIレイアウト等の運用データ
│   └── contents/                         # 保存された番組ファイル
├── logs/                                 # ※Git管理外。日次ログ出力先
└── sdp/                                  # ※Git管理外。アップロードされたSDPファイル
```

`data/`, `logs/`, `sdp/` はディレクトリ自体は`deploy.sh`が作成しますが、
**中身はGit管理外**です(`.gitignore`参照)。IPアドレスや放送局内の
運用データなど、公開リポジトリに含めてはならない情報を含むためです。

`data/database.json` はファイルが存在しない場合、`main.py` の
`init_database()` が初回起動時に自動生成します(`deploy.sh`側での
特別な対応は不要)。

## data/config.json の項目説明

`deploy.sh` が初回作成する値はすべて**ダミー**です。運用開始前に
実環境の値へ書き換えてください(WebGUIのシステム設定画面、または
直接編集のいずれでも可。直接編集後は `sudo systemctl restart
nmos-controller` が必要)。

| キー | 説明 | 初回デプロイ時の値 |
|---|---|---|
| `rds.host` | NMOS-RDSのIPアドレス。**要編集** | `192.168.1.100`(ダミー) |
| `rds.registration_port` | RDSのRegistration API ポート | `3210`(ダミー) |
| `rds.query_port` | RDSのQuery API ポート | `3210`(ダミー) |
| `rds.node_port` | RDSのNode APIポート | `3210`(ダミー) |
| `rds.logging_port` | RDSのLogging APIポート | `3210`(ダミー) |
| `server.host` | 本サービスのListenアドレス | `0.0.0.0`(固定でよい) |
| `server.port` | 本サービスのListenポート | `80`(要件により固定) |
| `log.directory` | ログ出力先 | `$HOME/nmos-controller/logs` |
| `nmos_rds.registry_json_path` | RDS側`registry.json`のパス | `$HOME/nmos-rds/config/registry.json` |
| `nmos_rds.compose_directory` | RDSのdocker-composeディレクトリ | `$HOME/nmos-rds` |
| `sdp.directory` | アップロードされたSDPファイルの保存先 | `$HOME/nmos-controller/sdp` |

上記に加えて、`network`(netplanパス・インターフェース名)と
`program`(送信間隔)のキーは**`deploy.sh`では作成しません**。
`main.py` の `init_config()` が初回起動時にOS環境から自動検出・
自動補完します。

## ネットワーク設定変更(netplan)の仕組み

本サービスは非rootユーザーで動作するため、`/etc/netplan/*.yaml` へ
直接書き込むことができません。そのため `control.py` の
`sync_netplan()` は以下の2段階で反映します。

1. 新しい設定内容を一時ファイル(`/tmp/nmos-netplan-new.yaml`)に書き出す
2. `sudo /usr/local/bin/nmos-apply-netplan.sh` を実行し、一時ファイルを
   実際のnetplanパスへコピーさせる

`nmos-apply-netplan.sh` は引数を受け取らず、固定パスの一時ファイルを
固定パスのnetplan設定へcpするだけの単純なスクリプトです。`sudoers`
では、このスクリプト・`reboot`・`shutdown -h now` の3コマンドのみを
個別にNOPASSWD許可しています(ワイルドカードや`ALL`は使用していません)。
