# main.py - FastAPIアプリ起動・ルーティング

import json
import logging
import sys
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

# ==========================================
# 設定ファイルの読み込み
# ==========================================
CONFIG_PATH = Path(__file__).parent / "data" / "config.json"

def load_config():
    if not CONFIG_PATH.exists():
        print(
            f"[ERROR] config.json が見つかりません: "
            f"{CONFIG_PATH}"
        )
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(config: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=4, ensure_ascii=False)

# ==========================================
# config.json の自動補完
# ==========================================
def init_config():
    config  = load_config()
    changed = False

    if "network" not in config:
        netplan_path, interface = detect_netplan()
        config["network"] = {
            "netplan_path": netplan_path,
            "interface":    interface
        }
        changed = True
        print(
            f"[INFO] config.json に network キーを追記: "
            f"{netplan_path} ({interface})"
        )

    if "program" not in config:
        config["program"] = {
            "send_interval_ms": 100
        }
        changed = True
        print("[INFO] config.json に program キーを追記")

    if changed:
        save_config(config)

    return config

def detect_netplan() -> tuple[str, str]:
    import yaml

    netplan_dir = Path("/etc/netplan")
    yaml_files  = sorted(netplan_dir.glob("*.yaml"))

    if not yaml_files:
        return (
            "/etc/netplan/50-cloud-init.yaml",
            "enp5s0"
        )

    netplan_path = str(yaml_files[0])

    try:
        with open(netplan_path, "r") as f:
            netplan = yaml.safe_load(f)
        ethernets = netplan.get(
            "network", {}
        ).get("ethernets", {})
        interface = list(ethernets.keys())[0] \
            if ethernets else "enp5s0"
    except Exception:
        interface = "enp5s0"

    return netplan_path, interface

# ==========================================
# ロギングの設定
# ==========================================
def setup_logging(config: dict):
    log_dir = Path(config["log"]["directory"])
    log_dir.mkdir(parents=True, exist_ok=True)

    log_file = log_dir / \
        f"{datetime.now().strftime('%Y-%m-%d')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(
                log_file, encoding="utf-8"
            ),
            logging.StreamHandler()
        ]
    )
    return logging.getLogger(__name__)

# ==========================================
# database.json の初期化
# ==========================================
DB_PATH = Path(__file__).parent / "data" / "database.json"

def init_database(logger):
    if not DB_PATH.exists():
        logger.info(
            "database.json が存在しないため、"
            "空で作成します"
        )
        default_db = {
            "materials": {
                "video":     [],
                "audio":     [],
                "ancillary": []
            },
            "contents":          [],
            "gui1_layout":       {},
            "gui2_panels":       {},
            "rest_api_triggers": {},
            "send_interval_ms":  100
        }
        with open(DB_PATH, "w", encoding="utf-8") as f:
            json.dump(
                default_db, f,
                ensure_ascii=False, indent=2
            )
        logger.info("database.json を作成しました")
    else:
        # ==========================================
        # 既存DBのマイグレーション
        # keyboard_shortcuts キーを削除し
        # rest_api_triggers キーを保証する
        # ==========================================
        try:
            with open(DB_PATH, "r", encoding="utf-8") as f:
                db = json.load(f)

            changed = False

            # keyboard_shortcuts を削除
            if "keyboard_shortcuts" in db:
                del db["keyboard_shortcuts"]
                changed = True
                logger.info(
                    "database.json: "
                    "keyboard_shortcuts を削除しました"
                )

            # rest_api_triggers がなければ追加
            if "rest_api_triggers" not in db:
                db["rest_api_triggers"] = {}
                changed = True
                logger.info(
                    "database.json: "
                    "rest_api_triggers を追加しました"
                )

            if changed:
                with open(
                    DB_PATH, "w", encoding="utf-8"
                ) as f:
                    json.dump(
                        db, f,
                        ensure_ascii=False, indent=2
                    )
                logger.info(
                    "database.json マイグレーション完了"
                )

        except Exception as e:
            logger.warning(
                f"database.json マイグレーション"
                f"エラー: {e}"
            )

# ==========================================
# 起動処理
# ==========================================
config = init_config()
logger = setup_logging(config)
logger.info("NMOSコントローラ 起動中...")
init_database(logger)

# ==========================================
# lifespan（起動・終了処理）
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    from is04 import connect_rds_websocket

    rds_host   = config["rds"]["host"]
    query_port = config["rds"]["query_port"]

    logger.info(
        f"IS-04: RDS接続開始 "
        f"{rds_host}:{query_port}"
    )

    asyncio.create_task(
        connect_rds_websocket(rds_host, query_port)
    )

    yield
    logger.info("NMOSコントローラ 終了")

# ==========================================
# FastAPIアプリの作成
# ==========================================
app = FastAPI(
    title="NMOSコントローラ",
    lifespan=lifespan
)

# ==========================================
# 静的ファイルのマウント
# ==========================================
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)

# ==========================================
# APIルーターの登録
# ==========================================
from is04      import router as is04_router
from is05      import router as is05_router
from materials import (
    router as materials_router,
    check_sdp_files_on_startup
)
from control   import router as control_router
from gui2      import router as gui2_router
from rest_api  import router as rest_api_router  # ← 追加

check_sdp_files_on_startup(logger)

app.include_router(is04_router)
app.include_router(is05_router)
app.include_router(materials_router)
app.include_router(control_router)
app.include_router(gui2_router)
app.include_router(rest_api_router)              # ← 追加

# ==========================================
# レイアウトAPI
# ==========================================
@app.get("/api/layout/gui1")
async def get_gui1_layout():
    from materials import load_db
    db = load_db()
    return db.get("gui1_layout", {})

@app.post("/api/layout/gui1")
async def save_gui1_layout(layout: dict):
    from materials import load_db, save_db
    db = load_db()
    db["gui1_layout"] = layout
    save_db(db)
    return {"status": "ok"}

# ==========================================
# ショートカットAPI
# （keyboard_shortcuts → rest_api_triggers に統合）
# ==========================================
@app.get("/api/shortcuts")
async def get_shortcuts():
    """
    rest_api_triggers の中から
    keyboard_shortcut が設定されているものを返す
    GUI①のショートカット機能で使用
    """
    from materials import load_db
    db       = load_db()
    triggers = db.get("rest_api_triggers", {})

    shortcuts = []
    for number, t in sorted(triggers.items()):
        sc = t.get("keyboard_shortcut")
        if sc:
            shortcuts.append({
                "number": number,
                "label":  t.get("label", ""),
                "key":    sc
            })

    return shortcuts

# ==========================================
# ページルーティング
# ==========================================
@app.get("/")
async def gui1():
    return FileResponse("static/gui1/index.html")

@app.get("/system/")
async def system_gui():
    return FileResponse(
        "static/system_gui/index.html")

@app.get("/node/")
async def node_gui():
    return FileResponse("static/node_gui/index.html")

@app.get("/panel/{panel_id}/")
async def gui2(panel_id: str):
    return FileResponse("static/gui2/index.html")

# ==========================================
# 起動
# ==========================================
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=config["server"]["host"],
        port=config["server"]["port"],
        reload=False
    )