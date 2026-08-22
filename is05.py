# is05.py - IS-05 Connection Management

import json
import logging
import asyncio
import httpx
from datetime import datetime
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

connection_map: dict = {}
_prev_receiver_ids: set = set()

# ==========================================
# HTTP クライアント（keep-alive使い回し）
# ==========================================
_http_client: httpx.AsyncClient | None = None

def get_http_client() -> httpx.AsyncClient:
    """
    keep-alive クライアントを使い回す
    毎回TCPハンドシェイクしなくて済む
    """
    global _http_client
    if _http_client is None \
            or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=10.0,
            limits=httpx.Limits(
                max_keepalive_connections=10,
                max_connections=20,
                keepalive_expiry=30.0
            )
        )
    return _http_client

# ==========================================
# IS-05 エンドポイント特定
# ==========================================
def get_is05_base_url(
    receiver_resource_id: str
) -> str | None:
    """
    receiver_resource_id から
    IS-05のベースURLを特定する

    【優先順位】
    ① device.controls から
      urn:x-nmos:control:sr-ctrl の
      href を取得（最も正確）
    ② fallback: node.href から組み立て
    """
    from is04 import nmos_data

    receiver = nmos_data["receivers"].get(
        receiver_resource_id)
    if not receiver:
        logger.error(
            f"IS-05: Receiver が見つかりません: "
            f"{receiver_resource_id}"
        )
        return None

    device_id = receiver.get("device_id")
    device    = nmos_data["devices"].get(device_id)
    if not device:
        logger.error(
            f"IS-05: Device が見つかりません: "
            f"{device_id}"
        )
        return None

    # ==========================================
    # ① device.controls から IS-05 URL を取得
    #    v1.1 → v1.0 の優先順位で探す
    # ==========================================
    controls = device.get("controls", [])
    sr_ctrl_types = [
        ("v1.1", "urn:x-nmos:control:sr-ctrl/v1.1"),
        ("v1.0", "urn:x-nmos:control:sr-ctrl/v1.0"),
    ]

    for version, ctrl_type in sr_ctrl_types:
        for ctrl in controls:
            if ctrl.get("type") == ctrl_type:
                base_url = ctrl.get(
                    "href", "").rstrip("/")
                if base_url:
                    logger.info(
                        f"IS-05: エンドポイント特定"
                        f"(controls/{version}): "
                        f"{base_url}"
                    )
                    return base_url

    # ==========================================
    # ② fallback: node.href から組み立て
    # ==========================================
    logger.warning(
        f"IS-05: device.controls に IS-05 URLが"
        f"見つかりません。node.href から組み立てます: "
        f"{device_id}"
    )

    node_id = device.get("node_id")
    node    = nmos_data["nodes"].get(node_id)
    if not node:
        logger.error(
            f"IS-05: Node が見つかりません: "
            f"{node_id}"
        )
        return None

    href = node.get("href", "").rstrip("/")
    if not href:
        logger.error(
            f"IS-05: Node.href が空です: "
            f"{node_id}"
        )
        return None

    base_url = f"{href}/x-nmos/connection/v1.1"
    logger.info(
        f"IS-05: エンドポイント特定(fallback): "
        f"{base_url}"
    )
    return base_url

# ==========================================
# IS-05 PATCH /staged（activationを含む）
# ==========================================
async def patch_staged(
    base_url:      str,
    receiver_id:   str,
    sender_id:     str | None,
    master_enable: bool,
    sdp_content:   str | None = None
) -> tuple[bool, int, str]:
    """
    PATCH /staged に activation を含めて送る
    keep-alive クライアントを使い回す
    """
    url = (
        f"{base_url}/single/receivers/"
        f"{receiver_id}/staged"
    )
    payload = {
        "sender_id":     sender_id,
        "master_enable": master_enable,
        "activation": {
            "mode": "activate_immediate"
        }
    }
    if sdp_content:
        payload["transport_file"] = {
            "data": sdp_content,
            "type": "application/sdp"
        }

    try:
        client = get_http_client()
        resp = await client.patch(
            url, json=payload)

        if resp.status_code in [200, 202]:
            logger.info(
                f"IS-05: PATCH /staged 成功: "
                f"{receiver_id} "
                f"({resp.status_code})"
            )
            return True, resp.status_code, "OK"
        else:
            msg = (
                f"{resp.status_code} "
                f"{resp.reason_phrase}"
            )
            logger.error(
                f"IS-05: PATCH /staged 失敗: "
                f"{receiver_id} - {msg}"
            )
            return False, resp.status_code, msg

    except Exception as e:
        logger.error(
            f"IS-05: PATCH /staged 例外: "
            f"{receiver_id} - {e}"
        )
        # 例外時はクライアントをリセット
        global _http_client
        _http_client = None
        return False, 0, str(e)

# ==========================================
# IS-04データ更新時の自律的connectionMap更新
# ==========================================
async def on_nmos_data_updated():
    global _prev_receiver_ids

    from is04 import nmos_data
    from materials import load_db

    try:
        db = load_db()

        # ==========================================
        # 監視対象Receiverを収集
        # ① database.materials の receiver
        # ② gui2_panels の全 destination の
        #    video/audio/anc_receiver_id
        #    （"none" は除外）
        # 重複排除して一元管理
        # ==========================================
        receiver_id_to_item: dict[str, dict] = {}

        # ① materials からの収集（従来通り）
        for category in [
            "video", "audio", "ancillary"
        ]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_type") \
                        == "receiver":
                    rid = item.get("resource_id")
                    if rid:
                        receiver_id_to_item[rid] \
                            = item

        # ② gui2_panels からの収集
        gui2_panels = db.get("gui2_panels", {})
        for panel_id, panel in \
                gui2_panels.items():
            for dest in panel.get(
                "destinations", []
            ):
                for key in [
                    "video_receiver_id",
                    "audio_receiver_id",
                    "anc_receiver_id"
                ]:
                    rid = dest.get(key)
                    if rid and rid != "none" \
                            and rid \
                            not in receiver_id_to_item:
                        receiver_id_to_item[rid] = {
                            "resource_id":   rid,
                            "resource_type": "receiver",
                            "label":         dest.get(
                                "label", rid),
                            "source":        "gui2"
                        }

        if not receiver_id_to_item:
            return

        db_receivers = list(
            receiver_id_to_item.values()
        )

        current_receiver_ids = set(
            nmos_data["receivers"].keys()
        )

        # ==========================================
        # 各Receiverの処理を並列化
        # ==========================================
        async def process_one(
            item: dict
        ) -> bool:
            receiver_id = item.get("resource_id")
            if not receiver_id:
                return False

            is_online = receiver_id \
                in current_receiver_ids
            prev = connection_map.get(receiver_id)

            if not is_online:
                if prev is None \
                        or prev.get("status") \
                        != "offline":
                    connection_map[receiver_id] = {
                        "sender_resource_id": None,
                        "sender_label":       None,
                        "status":             "offline",
                        "error_code":         None,
                        "error_msg":          None,
                        "connected_at":       None
                    }
                    logger.info(
                        f"IS-05: Receiver "
                        f"オフライン: "
                        f"{receiver_id}"
                    )
                    return True
                return False

            # オンラインだが前回オフライン
            # または未取得の場合のみ /active を取得
            if prev is not None \
                    and prev.get("status") \
                    not in ("offline", None):
                return False

            base_url = get_is05_base_url(
                receiver_id)
            if not base_url:
                return False

            url = (
                f"{base_url}/single/receivers/"
                f"{receiver_id}/active"
            )
            try:
                client = get_http_client()
                resp = await client.get(url)
                if resp.status_code == 200:
                    active = resp.json()
                    sid = active.get("sender_id")

                    if sid:
                        label = find_sender_label(
                            db, sid)
                        new_entry = {
                            "sender_resource_id":
                                sid,
                            "sender_label":
                                label or sid,
                            "status":
                                "connected",
                            "error_code":  None,
                            "error_msg":   None,
                            "connected_at":
                                datetime.now()
                                .isoformat()
                        }
                    else:
                        new_entry = {
                            "sender_resource_id":
                                None,
                            "sender_label":
                                None,
                            "status":
                                "disconnected",
                            "error_code":  None,
                            "error_msg":   None,
                            "connected_at":
                                None
                        }

                    if new_entry != prev:
                        connection_map[
                            receiver_id
                        ] = new_entry
                        logger.info(
                            f"IS-05: "
                            f"active取得: "
                            f"{receiver_id}"
                            f" -> "
                            f"{new_entry['status']}"
                        )
                        return True

            except Exception as e:
                logger.warning(
                    f"IS-05: active取得失敗: "
                    f"{receiver_id} - {e}"
                )

            return False

        # 全Receiverを並列処理
        results = await asyncio.gather(*[
            process_one(item)
            for item in db_receivers
        ])

        _prev_receiver_ids = current_receiver_ids

        if any(results):
            await broadcast_connection_map()

    except Exception as e:
        logger.error(
            f"IS-05: on_nmos_data_updated "
            f"エラー: {e}"
        )

def find_sender_label(
    db: dict, sender_id: str
) -> str | None:
    for category in [
        "video", "audio", "ancillary"
    ]:
        for item in db["materials"].get(
            category, []
        ):
            if item.get("resource_id") \
                    == sender_id:
                return item.get("label")
    return None

# ==========================================
# WebSocket ブロードキャスト
# ==========================================
async def broadcast_connection_map():
    from is04 import broadcast_to_gui
    await broadcast_to_gui({
        "type": "connection_map",
        "data": connection_map
    })

# ==========================================
# 【API】TAKE
# ==========================================
class TakeRequest(BaseModel):
    source_resource_id: str
    dest_resource_id:   str

@router.post("/api/connection/take")
async def take_connection(req: TakeRequest):
    try:
        from materials import load_db
        from is04      import nmos_data

        db = load_db()

        # Source情報を取得
        source_item = None
        for category in [
            "video", "audio", "ancillary"
        ]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_id") \
                        == req.source_resource_id:
                    source_item = item
                    break
            if source_item:
                break

        if not source_item:
            raise HTTPException(
                status_code=404,
                detail="Source素材が見つかりません"
            )

        # Dest情報を取得
        dest_item = None
        for category in [
            "video", "audio", "ancillary"
        ]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_id") \
                        == req.dest_resource_id:
                    dest_item = item
                    break
            if dest_item:
                break

        if not dest_item:
            raise HTTPException(
                status_code=404,
                detail="Dest素材が見つかりません"
            )

        if dest_item.get("resource_type") \
                != "receiver":
            raise HTTPException(
                status_code=400,
                detail=(
                    "Destは Receiver で"
                    "ある必要があります"
                )
            )

        # IS-05エンドポイントを特定
        receiver_id = req.dest_resource_id
        base_url    = get_is05_base_url(
            receiver_id)

        if not base_url:
            raise HTTPException(
                status_code=502,
                detail=(
                    "IS-05エンドポイントが"
                    "特定できません"
                )
            )

        # SDPとsender_idを準備
        source_type = source_item.get(
            "source", "sdp")
        sender_id   = None
        sdp_content = None

        if source_type == "sdp":
            sdp_content = source_item.get(
                "sdp_content", "")
            sender_id   = None
            logger.info(
                f"IS-05: SDP素材を使用: "
                f"{source_item['label']}"
            )

        elif source_type == "is04":
            sender_id   = req.source_resource_id
            sender_nmos = nmos_data["senders"].get(
                sender_id)

            if sender_nmos and \
                    sender_nmos.get("manifest_href"):
                sdp_content = \
                    await fetch_sdp_from_manifest(
                        sender_nmos["manifest_href"],
                        sender_id=sender_id
                    )
                if not sdp_content:
                    logger.warning(
                        "IS-05: SDP取得失敗。"
                        "transport_fileなしで試みます"
                    )
            else:
                sdp_content = \
                    source_item.get(
                        "resource_data", {}
                    ).get("sdp_content")

            logger.info(
                f"IS-05: IS-04素材を使用: "
                f"{source_item['label']} "
                f"({sender_id})"
            )

        # IS-05 PATCH /staged（activation含む）
        ok, code, msg = await patch_staged(
            base_url,
            receiver_id,
            sender_id,
            master_enable=True,
            sdp_content=sdp_content
        )

        if not ok:
            connection_map[receiver_id] = {
                "sender_resource_id":
                    req.source_resource_id,
                "sender_label":
                    source_item["label"],
                "status":     "error",
                "error_code": code,
                "error_msg":  msg,
                "connected_at":
                    datetime.now().isoformat()
            }
            await broadcast_connection_map()
            raise HTTPException(
                status_code=502,
                detail=(
                    f"IS-05 PATCH /staged 失敗: "
                    f"{msg}"
                )
            )

        # 成功
        connection_map[receiver_id] = {
            "sender_resource_id":
                req.source_resource_id,
            "sender_label":
                source_item["label"],
            "status":      "connected",
            "error_code":  None,
            "error_msg":   None,
            "connected_at":
                datetime.now().isoformat()
        }
        await broadcast_connection_map()

        logger.info(
            f"IS-05: TAKE成功: "
            f"{source_item['label']} -> "
            f"{dest_item['label']}"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": (
                f"「{source_item['label']}」->"
                f"「{dest_item['label']}」"
                f"接続しました"
            )
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"IS-05: TAKE例外: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"TAKE処理エラー: {e}"
        )

# ==========================================
# 【API】LEAVE
# ==========================================
class LeaveRequest(BaseModel):
    dest_resource_id: str

@router.post("/api/connection/leave")
async def leave_connection(req: LeaveRequest):
    try:
        from materials import load_db
        receiver_id = req.dest_resource_id

        db = load_db()

        dest_item = None
        for category in [
            "video", "audio", "ancillary"
        ]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_id") \
                        == receiver_id:
                    dest_item = item
                    break
            if dest_item:
                break

        if not dest_item:
            raise HTTPException(
                status_code=404,
                detail="Dest素材が見つかりません"
            )

        base_url = get_is05_base_url(receiver_id)
        if not base_url:
            raise HTTPException(
                status_code=502,
                detail=(
                    "IS-05エンドポイントが"
                    "特定できません"
                )
            )

        # IS-05 PATCH /staged（activation含む）
        ok, code, msg = await patch_staged(
            base_url,
            receiver_id,
            sender_id=None,
            master_enable=False,
            sdp_content=None
        )

        if not ok:
            connection_map[receiver_id] = {
                **connection_map.get(
                    receiver_id, {}),
                "status":     "error",
                "error_code": code,
                "error_msg":  msg
            }
            await broadcast_connection_map()
            raise HTTPException(
                status_code=502,
                detail=(
                    f"IS-05 PATCH /staged 失敗: "
                    f"{msg}"
                )
            )

        # 成功
        connection_map[receiver_id] = {
            "sender_resource_id": None,
            "sender_label":       None,
            "status":             "disconnected",
            "error_code":         None,
            "error_msg":          None,
            "connected_at":       None
        }
        await broadcast_connection_map()

        logger.info(
            f"IS-05: LEAVE成功: "
            f"{dest_item['label']}"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": (
                f"「{dest_item['label']}」"
                f"切断しました"
            )
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"IS-05: LEAVE例外: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"LEAVE処理エラー: {e}"
        )

# ==========================================
# 【API】connectionMap 取得
# ==========================================
@router.get("/api/connection/status")
async def get_connection_status():
    return JSONResponse(content=connection_map)

# is05.py に追加
# SDPキャッシュ（sender_id → sdp_content）
_sdp_cache: dict[str, str] = {}
_sdp_cache_time: dict[str, float] = {}
SDP_CACHE_TTL = 60.0  # 60秒キャッシュ

async def fetch_sdp_from_manifest(
    manifest_href: str,
    sender_id: str | None = None
) -> str | None:
    import time

    # キャッシュチェック
    if sender_id:
        cached_at = _sdp_cache_time.get(
            sender_id, 0)
        if time.time() - cached_at \
                < SDP_CACHE_TTL:
            cached = _sdp_cache.get(sender_id)
            if cached:
                logger.info(
                    f"IS-05: SDP キャッシュ使用: "
                    f"{sender_id}"
                )
                return cached

    try:
        client = get_http_client()
        resp = await client.get(manifest_href)
        resp.raise_for_status()
        sdp = resp.text

        # キャッシュ保存
        if sender_id:
            _sdp_cache[sender_id] = sdp
            _sdp_cache_time[sender_id] = \
                time.time()

        return sdp

    except Exception as e:
        logger.error(
            f"IS-05: SDP取得エラー: "
            f"{manifest_href} - {e}"
        )
        return None

# ==========================================
# 【番組ファイル機能】全Receiver /active 一括取得
# ==========================================

async def fetch_all_active_connections() -> dict:
    """
    database.json に登録されている全Receiverの
    IS-05 /active エンドポイントを問い合わせ、
    現在の接続状態を返す。

    戻り値:
    {
        "receiver_id_1": {
            "sender_id": "xxxx" or None,
            "receiver_label": "IP25-R1"
        },
        ...
    }
    """
    import json as _json
    from pathlib import Path as _Path

    DATABASE_PATH = _Path("data/database.json")
    result = {}

    # database.json から全Receiverを取得
    try:
        with open(DATABASE_PATH, "r", encoding="utf-8") as f:
            db = _json.load(f)
    except Exception as e:
        logger.error(f"番組保存: database.json 読み込みエラー: {e}")
        return {}

    # 全カテゴリのReceiverを収集
    receivers = []
    materials = db.get("materials", {})
    for cat in ["video", "audio", "ancillary"]:
        for item in materials.get(cat, []):
            if item.get("resource_type") == "receiver":
                receivers.append(item)

    if not receivers:
        logger.info("番組保存: 登録済みReceiverが0件")
        return {}

    logger.info(f"番組保存: {len(receivers)}件のReceiverを問い合わせ中...")

    async with httpx.AsyncClient(timeout=5.0) as client:
        for item in receivers:
            receiver_id    = item.get("resource_id", "")
            receiver_label = item.get("label", "")

            if not receiver_id:
                continue

            # IS-05ベースURLを取得
            try:
                base_url = get_is05_base_url(receiver_id)
                if not base_url:
                    logger.warning(
                        f"番組保存: {receiver_label} の IS-05 URL 取得失敗"
                    )
                    result[receiver_id] = {
                        "sender_id":      None,
                        "receiver_label": receiver_label
                    }
                    continue

                url = (
                    f"{base_url}/single/receivers/"
                    f"{receiver_id}/active"
                )
                resp = await client.get(url)

                if resp.status_code == 200:
                    active    = resp.json()
                    sender_id = active.get("sender_id")
                    # sender_id が null文字列の場合もNoneに統一
                    if sender_id == "null" or sender_id == "":
                        sender_id = None
                    result[receiver_id] = {
                        "sender_id":      sender_id,
                        "receiver_label": receiver_label
                    }
                    logger.debug(
                        f"番組保存: {receiver_label} → "
                        f"sender={sender_id}"
                    )
                else:
                    logger.warning(
                        f"番組保存: {receiver_label} /active "
                        f"応答 {resp.status_code}"
                    )
                    result[receiver_id] = {
                        "sender_id":      None,
                        "receiver_label": receiver_label
                    }

            except httpx.TimeoutException:
                logger.warning(
                    f"番組保存: {receiver_label} /active タイムアウト"
                )
                result[receiver_id] = {
                    "sender_id":      None,
                    "receiver_label": receiver_label
                }
            except Exception as e:
                logger.warning(
                    f"番組保存: {receiver_label} /active エラー: {e}"
                )
                result[receiver_id] = {
                    "sender_id":      None,
                    "receiver_label": receiver_label
                }

    logger.info(f"番組保存: /active 取得完了 {len(result)}件")
    return result