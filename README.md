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

### WebGUIの画面構成

`http://<サーバー>/` を開くと、1つのブラウザタブの中で
「Control」「Node GUI」「System」の3画面をタブで切り替えられます
(枠ページ `static/gui1/index.html` が各画面をiframeで表示)。

| タブ | 画面 | 備考 |
|---|---|---|
| Control | `static/gui1/control.html` | メイン操作画面(Source/DestinationのTAKE/LEAVE) |
| Node GUI | `/node/` | IS-04リソースの閲覧・素材登録 |
| System | `/system/` | 番組ファイル・パネル・SDP・RESTトリガー・システム設定 |

- 表示中のタブはURL末尾(`#control` / `#node` / `#system`)に保持され、
  リロードしても同じタブが開きます。
- Controlタブに戻ると、Node GUI/Systemでの素材登録・編集を反映するため
  Control画面を再読み込みします。Node GUI/Systemタブを開いたときは、
  一覧のみを読み直します(絞り込みや開いているタブ等は保持)。
- GUI②(パネル画面 `/panel/{panel_id}/`)はタブレット等での単独表示用の
  ため、従来どおり別ページです。

### Control画面の操作モード

ヘッダー右側の「モード [TAKE][Direct]」で切り替えます。画面を開くたびに
TAKEモードから始まります(安全のため選択したモードは記憶しません)。

- **TAKEモード**: Source/Destinationを選択(順不同)し、中央のTAKEボタンで実行。
- **Directモード**: Source/Destinationの両方を選択した時点で即実行
  (中央のモード表示が水色で点灯し、TAKEボタンは押せなくなります)。
  実行後はDestinationを選択したままSourceのみ解除されるため、同じ
  DestinationへSourceを1クリックで次々に切り替えられます。選択中の
  Destination、またはSource/Destinationペイン内の空欄部をクリックすると
  選択を解除します。実行中のクリック、およびカード並べ替えのドラッグ
  直後のクリックは無視します。
- LEAVEはどちらのモードでも、Destinationのみを選択してLEAVEボタンで実行します。

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
   (`venv/bin/pip` が無い壊れたvenvが残っている場合は削除して再作成)
6. `/etc/netplan/*.yaml` を検出し、そのファイルを`sudo chmod o+r`で
   読み取り可能にする(**sudoが必要**。検証環境向けの簡易対応。
   さらに `nmos_rds.registry_json_path` が指すファイルが存在すれば
   `sudo chmod o+rw` で読み書き可能にする。
   後述「ネットワーク設定変更(netplan)の仕組み」参照)
7. netplan反映用ラッパースクリプト
   (`/usr/local/bin/nmos-apply-netplan.sh`)を配置(**sudoが必要**)
8. systemdユニットファイルの `{{ACCOUNT_NAME}}` を実行ユーザー名に
   置換して `/etc/systemd/system/nmos-controller.service` に配置
   (**sudoが必要**)
9. sudoers設定ファイルの `{{ACCOUNT_NAME}}` を実行ユーザー名に置換し、
   `visudo -c` で構文チェックの上 `/etc/sudoers.d/nmos-controller` に
   配置(**sudoが必要**)
10. `systemctl daemon-reload && systemctl enable --now nmos-controller`

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
| `rds.registration_port` | RDSのRegistration API ポート | `3210`(既定値) |
| `rds.query_port` | RDSのQuery API ポート | `3211`(既定値) |
| `rds.node_port` | RDSのNode APIポート | `3212`(既定値) |
| `rds.logging_port` | RDSのLogging APIポート | `3213`(既定値) |
| `server.host` | 本サービスのListenアドレス | `0.0.0.0`(固定でよい) |
| `server.port` | 本サービスのListenポート | `80`(要件により固定) |
| `log.directory` | ログ出力先 | `$HOME/nmos-controller/logs` |
| `nmos_rds.registry_json_path` | RDS側`registry.json`のパス | `$HOME/nmos-rds/registry.json` |
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

また、netplan設定ファイルは通常 `root:root` / `600`(root以外は
読み取り不可)で生成されるため、非rootで動作する本サービスは現在の
IP/GW表示(`GET /api/system/network`)すら読み取れません。**本システムは
検証用途でセキュリティ要件が低いため**、`deploy.sh` が検出したnetplan
ファイルに対して `sudo chmod o+r` を実行し、世界読み取り可能にする
簡易対応をしています(書き込み権限は付与していません)。本番運用に
転用する場合は、より権限を絞った方式(読み取り専用の別ファイルへの
コピー配置など)への見直しを推奨します。

同様に、NMOS-RDS側の `nmos_rds.registry_json_path`(`registry.json`)
についても、`deploy.sh` は存在する場合に限り `sudo chmod o+rw` で
世界読み書き可能にします。現在のNMOS-RDS構成では `compose.yaml` で
`registry.json` を`:ro`(読み取り専用)でコンテナにマウントしており、
RDSのDockerコンテナ自身がこのファイルを書き換えることは無いため、
ホスト側で作成した所有者(`tv-asahi`等)のまま書き込み可能な状態に
なっているのが通常で、**このchmodは本来不要な保険的対応**です。
将来的な構成変更等でroot所有になってしまった場合に備えて残して
あります。NMOS-RDSが本サービスより後にデプロイされ、まだ
`registry.json` が存在しない場合はこのステップはスキップされるため、
NMOS-RDSデプロイ後に手動で`chmod`するか、`deploy.sh`を再実行して
ください。
