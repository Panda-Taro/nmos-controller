# control.py - システム設定API

import json
import glob
import logging
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

# ==========================================
# パス定数
# ==========================================
CONFIG_PATH   = Path("data/config.json")
DATABASE_PATH = Path("data/database.json")

# 本サービスは非rootユーザーで動作するため、/etc/netplan/*.yaml へ
# 直接書き込むことができない。そのため、一時ファイルに書き出した上で
# sudoers でNOPASSWD許可された固定のラッパースクリプトをsudo実行し、
# 実際のnetplanパスへ反映する（詳細は sync_netplan() 参照）。
NETPLAN_TMP_PATH     = Path("/tmp/nmos-netplan-new.yaml")
NETPLAN_APPLY_SCRIPT = "/usr/local/bin/nmos-apply-netplan.sh"

# ==========================================
# ユーティリティ
# ==========================================
def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(config: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=4, ensure_ascii=False)

def sync_registry(config: dict):
    """
    config.json の rds.* を registry.json に反映する
    """
    registry_path = Path(
        config["nmos_rds"]["registry_json_path"]
    )
    if not registry_path.exists():
        raise FileNotFoundError(
            f"registry.json が見つかりません: "
            f"{registry_path}"
        )
    with open(registry_path, "r", encoding="utf-8") as f:
        registry = json.load(f)

    rds = config["rds"]
    registry["host_address"]      = rds["host"]
    registry["host_addresses"]    = [rds["host"]]
    registry["registration_port"] = rds["registration_port"]
    registry["query_port"]        = rds["query_port"]
    registry["node_port"]         = rds["node_port"]
    registry["logging_port"]      = rds["logging_port"]

    with open(registry_path, "w", encoding="utf-8") as f:
        json.dump(
            registry, f, indent=2, ensure_ascii=False
        )

def sync_netplan(config: dict, new_ip: str,
                 subnet: int, gateway: str):
    """
    netplan yaml を更新する

    本サービスは非rootユーザー({{ACCOUNT_NAME}})で動作しており、
    /etc/netplan/*.yaml は通常root所有・root書き込み専用のため、
    直接 open(..., "w") で書き込むことはできない。
    そのため以下の2段階で反映する。
      ① 新しい設定内容を一時ファイル(NETPLAN_TMP_PATH)に書き出す
      ② sudoers でNOPASSWD許可された固定のラッパースクリプト
         (NETPLAN_APPLY_SCRIPT)を `sudo` 実行し、一時ファイルを
         実際のnetplanパスへコピーさせる
    ラッパースクリプトは引数を受け取らず、固定の一時ファイルパスから
    固定のnetplanパスへ cp するだけの単純な処理に限定されている
    （任意コマンド実行を防ぐための設計）。
    """
    try:
        import yaml
    except ImportError:
        raise RuntimeError(
            "PyYAML がインストールされていません。"
            "pip install pyyaml を実行してください。"
        )

    netplan_path = Path(
        config["network"]["netplan_path"]
    )
    interface = config["network"]["interface"]

    if not netplan_path.exists():
        raise FileNotFoundError(
            f"netplan ファイルが見つかりません: "
            f"{netplan_path}"
        )

    with open(netplan_path, "r") as f:
        netplan = yaml.safe_load(f)

    # IPアドレス・GW を更新
    eth = netplan.setdefault(
        "network", {}
    ).setdefault(
        "ethernets", {}
    ).setdefault(interface, {})

    eth["addresses"] = [f"{new_ip}/{subnet}"]
    eth["routes"]    = [{"to": "default", "via": gateway}]

    # ① 新しい設定内容を一時ファイルに書き出す
    #    （nameservers 等の既存キーは維持したまま）
    with open(NETPLAN_TMP_PATH, "w") as f:
        yaml.dump(
            netplan, f,
            default_flow_style=False,
            allow_unicode=True
        )

    # ② ラッパースクリプトをsudo実行し、実際のnetplanパスへ反映する
    result = subprocess.run(
        ["sudo", NETPLAN_APPLY_SCRIPT],
        capture_output=True,
        text=True,
        timeout=10
    )
    if result.returncode != 0:
        raise RuntimeError(
            "netplan反映スクリプトの実行に失敗しました: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )

# ==========================================
# 【1】ネットワーク設定 取得
# ==========================================
@router.get("/api/system/network")
async def get_network():
    """
    現在のネットワーク設定を返す
    （config.json + netplan.yaml から取得）
    """
    try:
        import yaml
        config = load_config()

        # config.json からポート情報取得
        rds    = config.get("rds", {})
        server = config.get("server", {})

        # netplan から IP・サブネット・GW を取得
        netplan_path = Path(
            config["network"]["netplan_path"]
        )
        interface = config["network"]["interface"]

        ip_address = rds.get("host", "")
        subnet     = 24
        gateway    = ""

        if netplan_path.exists():
            with open(netplan_path, "r") as f:
                netplan = yaml.safe_load(f)
            eth = netplan.get(
                "network", {}
            ).get(
                "ethernets", {}
            ).get(interface, {})

            # addresses: ["192.168.10.252/24"]
            addresses = eth.get("addresses", [])
            if addresses:
                parts      = addresses[0].split("/")
                ip_address = parts[0]
                subnet     = int(parts[1]) \
                    if len(parts) > 1 else 24

            # routes: [{to: default, via: ...}]
            routes = eth.get("routes", [])
            for r in routes:
                if r.get("to") == "default":
                    gateway = r.get("via", "")
                    break

        return JSONResponse(content={
            "ip_address":        ip_address,
            "subnet":            subnet,
            "gateway":           gateway,
            "interface":         interface,
            "registration_port": rds.get(
                "registration_port", 3210),
            "query_port":        rds.get(
                "query_port", 3211),
            "node_port":         rds.get(
                "node_port", 3212),
            "logging_port":      rds.get(
                "logging_port", 3213),
            "server_port":       server.get("port", 80)
        })

    except Exception as e:
        logger.error(f"ネットワーク設定取得エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"ネットワーク設定取得エラー: {e}"
        )

# ==========================================
# 【2】ネットワーク設定 保存 + 再起動
# ==========================================
class NetworkUpdateRequest(BaseModel):
    ip_address:        str
    subnet:            int
    gateway:           str
    registration_port: int
    query_port:        int
    node_port:         int
    logging_port:      int

@router.post("/api/system/network")
async def update_network(req: NetworkUpdateRequest):
    """
    ① config.json 更新
    ② registry.json 更新
    ③ netplan.yaml 更新
    ④ sudo reboot 実行
    """
    try:
        config = load_config()

        # ① config.json 更新
        config["rds"]["host"]              = req.ip_address
        config["rds"]["registration_port"] = \
            req.registration_port
        config["rds"]["query_port"]        = req.query_port
        config["rds"]["node_port"]         = req.node_port
        config["rds"]["logging_port"]      = req.logging_port
        save_config(config)
        logger.info(
            f"config.json 更新: IP={req.ip_address}"
        )

        # ② registry.json 更新
        sync_registry(config)
        logger.info("registry.json 更新完了")

        # ③ netplan.yaml 更新
        sync_netplan(
            config,
            req.ip_address,
            req.subnet,
            req.gateway
        )
        logger.info("netplan.yaml 更新完了")

        # ④ sudo reboot（非同期・少し遅延させる）
        subprocess.Popen(
            ["sudo", "reboot"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        logger.info("サーバー再起動を開始します")

        return JSONResponse(content={
            "status":  "ok",
            "message": "設定を保存しました。再起動します。",
            "new_ip":  req.ip_address
        })

    except Exception as e:
        logger.error(f"ネットワーク設定保存エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"設定保存エラー: {e}"
        )

# ==========================================
# 【3】config.json 取得
# ==========================================
@router.get("/api/system/config")
async def get_config():
    try:
        return JSONResponse(content=load_config())
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"config.json 読み込みエラー: {e}"
        )

# ==========================================
# 【4】config.json エクスポート
# ==========================================
@router.get("/api/system/export/config")
async def export_config():
    if not CONFIG_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="config.json が見つかりません"
        )
    return FileResponse(
        path=str(CONFIG_PATH),
        filename="config.json",
        media_type="application/json"
    )

# ==========================================
# 【5】database.json エクスポート
# ==========================================
@router.get("/api/system/export/database")
async def export_database():
    if not DATABASE_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="database.json が見つかりません"
        )
    return FileResponse(
        path=str(DATABASE_PATH),
        filename="database.json",
        media_type="application/json"
    )

# ==========================================
# 【6】config.json インポート
# ==========================================
@router.post("/api/system/import/config")
async def import_config(file: UploadFile):
    try:
        content    = await file.read()
        new_config = json.loads(content)

        for key in ["rds", "server"]:
            if key not in new_config:
                raise ValueError(
                    f"必須キー '{key}' がありません"
                )

        with open(CONFIG_PATH, "w",
                  encoding="utf-8") as f:
            json.dump(
                new_config, f,
                indent=4, ensure_ascii=False
            )

        return JSONResponse(content={
            "status":  "ok",
            "message": "config.json をインポートしました"
        })
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400,
            detail=f"JSONフォーマットエラー: {e}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"インポートエラー: {e}"
        )

# ==========================================
# 【7】database.json インポート
# ==========================================
@router.post("/api/system/import/database")
async def import_database(file: UploadFile):
    try:
        content = await file.read()
        new_db  = json.loads(content)

        with open(DATABASE_PATH, "w",
                  encoding="utf-8") as f:
            json.dump(
                new_db, f,
                indent=4, ensure_ascii=False
            )

        return JSONResponse(content={
            "status":  "ok",
            "message": "database.json をインポートしました"
        })
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400,
            detail=f"JSONフォーマットエラー: {e}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"インポートエラー: {e}"
        )

# ==========================================
# 【8】ログ取得（最新100件）
# ==========================================
@router.get("/api/system/logs")
async def get_logs():
    try:
        config  = load_config()
        log_dir = Path(config["log"]["directory"])

        if not log_dir.exists():
            return JSONResponse(content={
                "lines":   [],
                "message": "ログディレクトリが存在しません"
            })

        # 日付ログを新しい順に取得
        log_files = sorted(
            log_dir.glob("*.log"),
            reverse=True
        )

        if not log_files:
            return JSONResponse(content={
                "lines":   [],
                "message": "ログファイルがありません"
            })

        # 最新ファイルから100件取得
        # 足りなければ前日分も読む
        all_lines = []
        for log_file in log_files:
            with open(log_file, "r",
                      encoding="utf-8") as f:
                lines = f.readlines()
            all_lines = lines + all_lines
            if len(all_lines) >= 100:
                break

        latest = [
            l.rstrip() for l in all_lines[-100:]
        ]

        return JSONResponse(content={
            "lines":   latest,
            "total":   len(all_lines),
            "showing": len(latest)
        })

    except Exception as e:
        logger.error(f"ログ取得エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"ログ取得エラー: {e}"
        )

# ==========================================
# 【9】ログエクスポート
# ==========================================
@router.get("/api/system/export/logs")
async def export_logs():
    try:
        config    = load_config()
        log_dir   = Path(config["log"]["directory"])
        today_log = log_dir / \
            f"{datetime.now().strftime('%Y-%m-%d')}.log"

        if today_log.exists():
            return FileResponse(
                path=str(today_log),
                filename=today_log.name,
                media_type="text/plain"
            )

        # 当日ログがなければ最新ファイル
        log_files = sorted(
            log_dir.glob("*.log"), reverse=True
        )
        if log_files:
            return FileResponse(
                path=str(log_files[0]),
                filename=log_files[0].name,
                media_type="text/plain"
            )

        raise HTTPException(
            status_code=404,
            detail="ログファイルが見つかりません"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"ログエクスポートエラー: {e}"
        )

# ==========================================
# 【10】NMOS-RDS 状態確認
# ==========================================
@router.get("/api/system/rds/status")
async def get_rds_status():
    try:
        config      = load_config()
        compose_dir = config["nmos_rds"]["compose_directory"]

        result = subprocess.run(
            ["docker", "compose", "ps"],
            cwd=compose_dir,
            capture_output=True,
            text=True,
            timeout=10
        )
        return JSONResponse(content={
            "stdout":     result.stdout,
            "stderr":     result.stderr,
            "returncode": result.returncode
        })
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="タイムアウトしました"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"RDS状態確認エラー: {e}"
        )

# ==========================================
# 【11】NMOS-RDS ログ確認
# ==========================================
@router.get("/api/system/rds/logs")
async def get_rds_logs():
    try:
        config      = load_config()
        compose_dir = config["nmos_rds"]["compose_directory"]

        result = subprocess.run(
            ["docker", "compose", "logs", "--tail=50"],
            cwd=compose_dir,
            capture_output=True,
            text=True,
            timeout=15
        )
        return JSONResponse(content={
            "stdout":     result.stdout,
            "stderr":     result.stderr,
            "returncode": result.returncode
        })
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="タイムアウトしました"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"RDSログ取得エラー: {e}"
        )

# ==========================================
# 【12-1】サーバー再起動
# ==========================================
@router.post("/api/system/reboot")
async def system_reboot():
    try:
        subprocess.Popen(
            ["sudo", "reboot"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        logger.info("サーバー再起動を実行")
        return JSONResponse(content={
            "status":  "ok",
            "message": "再起動を開始します..."
        })
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"再起動エラー: {e}"
        )

# ==========================================
# 【12-2】サーバーシャットダウン  ← ★追加
# ==========================================
@router.post("/api/system/shutdown")
async def system_shutdown():
    try:
        subprocess.Popen(
            ["sudo", "shutdown", "-h", "now"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        logger.info("サーバーシャットダウンを実行")
        return JSONResponse(content={
            "status":  "ok",
            "message": "シャットダウンを開始します..."
        })
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"シャットダウンエラー: {e}"
        )

# ==========================================
# 【13】設定初期化
# ==========================================
@router.post("/api/system/reset")
async def system_reset():
    try:
        empty_db = {
            "materials": {
                "video":     [],
                "audio":     [],
                "ancillary": []
            },
            "contents":           [],
            "gui1_layout":        {},
            "gui2_panels":        {},
            "rest_api_triggers":  {},
            "send_interval_ms":   100
        }
        with open(DATABASE_PATH, "w",
                  encoding="utf-8") as f:
            json.dump(
                empty_db, f,
                indent=4, ensure_ascii=False
            )
        logger.info("database.json を初期化しました")
        return JSONResponse(content={
            "status":  "ok",
            "message": "database.json を初期化しました"
        })
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"初期化エラー: {e}"
        )

# ==========================================
# 【14】送信間隔 取得
# ==========================================
@router.get("/api/system/program-interval")
async def get_program_interval():
    try:
        config   = load_config()
        interval = config.get(
            "program", {}
        ).get("send_interval_ms", 100)
        return JSONResponse(content={
            "send_interval_ms": interval
        })
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"取得エラー: {e}"
        )

# ==========================================
# 【15】送信間隔 保存
# ==========================================
class IntervalRequest(BaseModel):
    send_interval_ms: int

@router.post("/api/system/program-interval")
async def set_program_interval(req: IntervalRequest):
    try:
        if req.send_interval_ms < 0:
            raise ValueError("0以上の値を指定してください")

        config = load_config()
        if "program" not in config:
            config["program"] = {}
        config["program"]["send_interval_ms"] = \
            req.send_interval_ms
        save_config(config)
        logger.info(
            f"送信間隔を {req.send_interval_ms}ms に設定"
        )
        return JSONResponse(content={
            "status":  "ok",
            "message": f"送信間隔を "
                       f"{req.send_interval_ms}ms "
                       f"に設定しました"
        })
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"保存エラー: {e}"
        )

# ==========================================
# 【番組ファイル機能】
# ==========================================

import asyncio
from datetime import datetime
from pathlib import Path

# 番組ファイル保存ディレクトリ
CONTENTS_DIR = Path("data/contents")

# 進捗状態（メモリ上で管理）
_load_status = {
    "running":       False,
    "current":       0,
    "total":         0,
    "current_label": "",
    "aborted":       False,
    "error":         ""
}

# 実行中タスク参照（中止用）
_load_task: asyncio.Task = None


def ensure_contents_dir():
    CONTENTS_DIR.mkdir(parents=True, exist_ok=True)


def load_database() -> dict:
    with open(DATABASE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_all_materials(db: dict) -> dict:
    """
    database.json の全素材を resource_id をキーにした辞書で返す
    """
    mat_map = {}
    for cat in ["video", "audio", "ancillary"]:
        for item in db.get("materials", {}).get(cat, []):
            rid = item.get("resource_id", "")
            if rid:
                mat_map[rid] = item
    return mat_map


# ==========================================
# 【番組】一覧取得
# ==========================================
@router.get("/api/programs")
async def list_programs():
    """
    data/contents/ 内の番組ファイル一覧を返す
    """
    try:
        ensure_contents_dir()
        programs = []
        for f in sorted(CONTENTS_DIR.glob("*.json")):
            try:
                with open(f, "r", encoding="utf-8") as fp:
                    data = json.load(fp)
                programs.append({
                    "name":       data.get("name", f.stem),
                    "created_at": data.get("created_at", ""),
                    "updated_at": data.get("updated_at", ""),
                    "count":      len(data.get("connections", []))
                })
            except Exception:
                continue
        return JSONResponse(content=programs)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 【番組】新規保存
# ==========================================
class ProgramSaveRequest(BaseModel):
    name: str


@router.post("/api/programs")
async def save_program_new(req: ProgramSaveRequest):
    """
    名前を受け取り、IS-05から現在の接続状態を取得して保存する
    同名ファイルが存在する場合は 409 を返す
    """
    try:
        ensure_contents_dir()
        name     = req.name.strip()
        if not name:
            raise HTTPException(
                status_code=400, detail="番組名を入力してください"
            )

        file_path = CONTENTS_DIR / f"{name}.json"
        if file_path.exists():
            raise HTTPException(
                status_code=409,
                detail=f"「{name}」は既に存在します"
            )

        # IS-05から現在の接続状態を取得
        from is05 import fetch_all_active_connections
        active_map = await fetch_all_active_connections()

        # database.json からラベル情報を取得
        db      = load_database()
        mat_map = get_all_materials(db)

        connections = []
        for receiver_id, info in active_map.items():
            sender_id      = info.get("sender_id")
            receiver_label = info.get("receiver_label", "")
            sender_label   = ""
            if sender_id and sender_id in mat_map:
                sender_label = mat_map[sender_id].get("label", "")

            connections.append({
                "receiver_id":    receiver_id,
                "receiver_label": receiver_label,
                "sender_id":      sender_id,
                "sender_label":   sender_label,
                "action":         "join" if sender_id else "leave"
            })

        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        program_data = {
            "name":        name,
            "created_at":  now,
            "updated_at":  now,
            "connections": connections
        }

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(program_data, f, indent=2, ensure_ascii=False)

        logger.info(f"番組ファイル新規保存: {name} ({len(connections)}件)")
        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{name}」を保存しました（{len(connections)}件）"
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"番組ファイル保存エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 【番組】上書き保存
# ==========================================
@router.put("/api/programs/{name}")
async def save_program_overwrite(name: str):
    """
    既存番組ファイルをIS-05の現在状態で上書き保存する
    """
    try:
        ensure_contents_dir()
        file_path = CONTENTS_DIR / f"{name}.json"
        if not file_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"「{name}」が見つかりません"
            )

        # IS-05から現在の接続状態を取得
        from is05 import fetch_all_active_connections
        active_map = await fetch_all_active_connections()

        db      = load_database()
        mat_map = get_all_materials(db)

        # created_at を既存から引き継ぐ
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            created_at = existing.get(
                "created_at",
                datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            )
        except Exception:
            created_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

        connections = []
        for receiver_id, info in active_map.items():
            sender_id      = info.get("sender_id")
            receiver_label = info.get("receiver_label", "")
            sender_label   = ""
            if sender_id and sender_id in mat_map:
                sender_label = mat_map[sender_id].get("label", "")

            connections.append({
                "receiver_id":    receiver_id,
                "receiver_label": receiver_label,
                "sender_id":      sender_id,
                "sender_label":   sender_label,
                "action":         "join" if sender_id else "leave"
            })

        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        program_data = {
            "name":        name,
            "created_at":  created_at,
            "updated_at":  now,
            "connections": connections
        }

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(program_data, f, indent=2, ensure_ascii=False)

        logger.info(f"番組ファイル上書き保存: {name} ({len(connections)}件)")
        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{name}」を上書き保存しました（{len(connections)}件）"
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"番組ファイル上書き保存エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 【番組】削除
# ==========================================
@router.delete("/api/programs/{name}")
async def delete_program(name: str):
    try:
        file_path = CONTENTS_DIR / f"{name}.json"
        if not file_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"「{name}」が見つかりません"
            )
        file_path.unlink()
        logger.info(f"番組ファイル削除: {name}")
        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{name}」を削除しました"
        })
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 【番組】エクスポート（ダウンロード）
# ==========================================
@router.get("/api/programs/{name}/export")
async def export_program(name: str):
    file_path = CONTENTS_DIR / f"{name}.json"
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"「{name}」が見つかりません"
        )
    return FileResponse(
        path=str(file_path),
        filename=f"{name}.json",
        media_type="application/json"
    )


# ==========================================
# 【番組】インポート
# ==========================================
@router.post("/api/programs/import")
async def import_program(file: UploadFile):
    """
    JSONファイルをインポートする
    同名ファイルが存在する場合は 409 を返す（JS側で上書き確認後に再送）
    """
    try:
        ensure_contents_dir()
        content = await file.read()
        data    = json.loads(content)

        # 最低限のバリデーション
        if "name" not in data or "connections" not in data:
            raise HTTPException(
                status_code=400,
                detail="不正な番組ファイル形式です（name / connections が必要）"
            )

        name      = data["name"].strip()
        file_path = CONTENTS_DIR / f"{name}.json"

        if file_path.exists():
            raise HTTPException(
                status_code=409,
                detail=f"「{name}」は既に存在します"
            )

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        logger.info(f"番組ファイルインポート: {name}")
        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{name}」をインポートしました"
        })

    except HTTPException:
        raise
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400, detail=f"JSONフォーマットエラー: {e}"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 【番組】インポート（上書き強制）
# ==========================================
@router.post("/api/programs/import/force")
async def import_program_force(file: UploadFile):
    """
    同名ファイルが存在しても上書きしてインポートする
    """
    try:
        ensure_contents_dir()
        content = await file.read()
        data    = json.loads(content)

        if "name" not in data or "connections" not in data:
            raise HTTPException(
                status_code=400,
                detail="不正な番組ファイル形式です"
            )

        name      = data["name"].strip()
        file_path = CONTENTS_DIR / f"{name}.json"

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        logger.info(f"番組ファイルインポート（上書き）: {name}")
        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{name}」をインポートしました（上書き）"
        })

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 【番組】ロード（呼出）開始
# ==========================================
@router.post("/api/programs/{name}/load")
async def load_program(name: str, background_tasks=None):
    """
    番組ファイルを読み込み、順次Join/Leave指示を送る
    """
    global _load_task, _load_status

    # 既に実行中の場合はエラー
    if _load_status["running"]:
        raise HTTPException(
            status_code=409,
            detail="既にロード中です。中止してから再実行してください"
        )

    file_path = CONTENTS_DIR / f"{name}.json"
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"「{name}」が見つかりません"
        )

    # 番組ファイル読み込み
    with open(file_path, "r", encoding="utf-8") as f:
        program_data = json.load(f)

    connections = program_data.get("connections", [])
    if not connections:
        raise HTTPException(
            status_code=400,
            detail="番組ファイルに接続情報がありません"
        )

    # database.json との整合チェック
    db      = load_database()
    mat_map = get_all_materials(db)
    errors  = []

    for conn in connections:
        rid = conn.get("receiver_id", "")
        sid = conn.get("sender_id")
        if rid and rid not in mat_map:
            errors.append(
                f"receiver_id \"{rid}\" ({conn.get('receiver_label','')}) "
                f"がシステムに存在しません"
            )
        if sid and sid not in mat_map:
            errors.append(
                f"sender_id \"{sid}\" ({conn.get('sender_label','')}) "
                f"がシステムに存在しません"
            )

    if errors:
        return JSONResponse(
            status_code=422,
            content={
                "status": "error",
                "message": "番組ファイルと現在のシステムが一致しません",
                "errors": errors
            }
        )

    # 送信間隔取得
    config   = load_config()
    interval = config.get("program", {}).get("send_interval_ms", 100)

    # 進捗初期化
    _load_status = {
        "running":       True,
        "current":       0,
        "total":         len(connections),
        "current_label": "",
        "aborted":       False,
        "error":         ""
    }

    # バックグラウンドで実行
    _load_task = asyncio.create_task(
        _execute_load(connections, interval)
    )

    logger.info(
        f"番組ロード開始: {name} "
        f"({len(connections)}件, 間隔{interval}ms)"
    )
    return JSONResponse(content={
        "status":  "ok",
        "message": f"「{name}」のロードを開始しました",
        "total":   len(connections)
    })


async def _execute_load(connections: list, interval_ms: int):
    """
    番組ロードの実際の処理（バックグラウンドタスク）
    """
    global _load_status

    from is05 import (
        patch_staged, get_is05_base_url,
        fetch_sdp_from_manifest, on_nmos_data_updated,
        connection_map, broadcast_connection_map
    )
    from is04 import nmos_data

    try:
        for i, conn in enumerate(connections):
            # 中止チェック
            if _load_status["aborted"]:
                logger.info(
                    f"番組ロード中止: "
                    f"{i}/{len(connections)}件完了"
                )
                break

            receiver_id    = conn.get("receiver_id", "")
            receiver_label = conn.get("receiver_label", "")
            sender_id      = conn.get("sender_id")
            sender_label   = conn.get("sender_label", "")  # ★ 追加
            action         = conn.get("action", "leave")

            _load_status["current"]       = i + 1
            _load_status["current_label"] = receiver_label

            try:
                # IS-05ベースURLを取得
                base_url = get_is05_base_url(receiver_id)
                if not base_url:
                    logger.warning(
                        f"番組ロード: {receiver_label} の"
                        f"IS-05 URL 取得失敗、スキップ"
                    )
                    continue

                if action == "join" and sender_id:
                    # sender の情報を取得
                    db      = load_database()
                    mat_map = get_all_materials(db)
                    sender  = mat_map.get(sender_id, {})
                    source_type = sender.get("source", "sdp")

                    sdp_content  = None
                    is05_sender_id = None

                    if source_type == "sdp":
                        # SDP素材：sdp_contentを直接使用
                        sdp_content    = sender.get("sdp_content", "")
                        is05_sender_id = None
                        logger.info(
                            f"番組ロード: SDP素材使用: "
                            f"{sender.get('label','')}"
                        )

                    elif source_type == "is04":
                        # IS-04素材：manifest_hrefからSDP取得
                        is05_sender_id = sender_id
                        sender_nmos    = nmos_data[
                            "senders"].get(sender_id)

                        if sender_nmos and \
                                sender_nmos.get("manifest_href"):
                            sdp_content = \
                                await fetch_sdp_from_manifest(
                                    sender_nmos["manifest_href"],
                                    sender_id=sender_id
                                )
                            if not sdp_content:
                                logger.warning(
                                    f"番組ロード: "
                                    f"{sender.get('label','')} "
                                    f"SDP取得失敗。"
                                    f"transport_fileなしで試みます"
                                )
                        else:
                            sdp_content = sender.get(
                                "resource_data", {}
                            ).get("sdp_content")

                        logger.info(
                            f"番組ロード: IS-04素材使用: "
                            f"{sender.get('label','')} "
                            f"({sender_id})"
                        )

                    ok, code, msg = await patch_staged(
                        base_url,
                        receiver_id,
                        is05_sender_id,
                        master_enable=True,
                        sdp_content=sdp_content
                    )

                    if ok:
                        logger.info(
                            f"番組ロード Join成功: "
                            f"{receiver_label} ← "
                            f"{sender_label}"
                        )
                        # connection_map を直接更新（GUIへの即時反映）
                        connection_map[receiver_id] = {
                            "sender_resource_id": is05_sender_id,
                            "sender_label":       sender_label,
                            "status":             "connected",
                            "error_code":         None,
                            "error_msg":          None,
                            "connected_at":       datetime.now().isoformat()
                        }
                        # nmos_data キャッシュも更新
                        if "receivers" in nmos_data and receiver_id in nmos_data["receivers"]:
                            nmos_data["receivers"][receiver_id]["subscription"]["sender_id"] = is05_sender_id
                            nmos_data["receivers"][receiver_id]["subscription"]["active"] = True
                    else:
                        logger.warning(
                            f"番組ロード Join失敗: "
                            f"{receiver_label} "
                            f"code={code} {msg}"
                        )

                else:
                    # Leave指示
                    ok, code, msg = await patch_staged(
                        base_url,
                        receiver_id,
                        None,
                        master_enable=False,
                        sdp_content=None
                    )
                    if ok:
                        logger.info(
                            f"番組ロード Leave成功: "
                            f"{receiver_label}"
                        )
                        # connection_map を直接更新（GUIへの即時反映）
                        connection_map[receiver_id] = {
                            "sender_resource_id": None,
                            "sender_label":       None,
                            "status":             "disconnected",
                            "error_code":         None,
                            "error_msg":          None,
                            "connected_at":       None
                        }
                        if "receivers" in nmos_data and receiver_id in nmos_data["receivers"]:
                            nmos_data["receivers"][receiver_id]["subscription"]["sender_id"] = None
                            nmos_data["receivers"][receiver_id]["subscription"]["active"] = False
                    else:
                        logger.warning(
                            f"番組ロード Leave失敗: "
                            f"{receiver_label} "
                            f"code={code} {msg}"
                        )

            except Exception as e:
                logger.error(
                    f"番組ロード エラー: {receiver_label} - {e}"
                )

            # 間隔待機（最後の1件は不要）
            if (i < len(connections) - 1
                    and not _load_status["aborted"]):
                await asyncio.sleep(interval_ms / 1000.0)

    except Exception as e:
        logger.error(f"番組ロード 予期せぬエラー: {e}")
        _load_status["error"] = str(e)

    finally:
        _load_status["running"] = False
        logger.info("番組ロード完了")

        # 全件完了後にGUIへ一括ブロードキャスト
        try:
            await broadcast_connection_map()
            logger.info("番組ロード完了: GUIへのブロードキャスト成功")
        except Exception as e:
            logger.error(f"番組ロード: broadcast_connection_map エラー: {e}")

# ==========================================
# 【番組】ロード中止
# ==========================================
@router.post("/api/programs/load/abort")
async def abort_program_load():
    global _load_status
    if not _load_status["running"]:
        return JSONResponse(content={
            "status":  "ok",
            "message": "ロード中ではありません"
        })
    _load_status["aborted"] = True
    logger.info("番組ロード中止要求")
    return JSONResponse(content={
        "status":  "ok",
        "message": "中止しました"
    })


# ==========================================
# 【番組】進捗取得
# ==========================================
@router.get("/api/programs/load/status")
async def get_load_status():
    return JSONResponse(content=_load_status)
