# is04.py - IS-04システム（Query API / WebSocket）

import json
import logging
import asyncio
import httpx
import websockets
from datetime import datetime
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

# ==========================================
# IS-04データストア
# ==========================================
nmos_data = {
    "nodes":     {},
    "devices":   {},
    "senders":   {},
    "receivers": {},
    "sources":   {},
    "flows":     {}
}

# IS-04接続状態
is04_status = {
    "connected":    False,
    "rds_url":      "",
    "last_updated": None,
    "error":        None
}

# GUI①へのWebSocket接続管理
gui_clients: list[WebSocket] = []

router = APIRouter()

# ==========================================
# RDS Query APIからデータ取得
# ==========================================
async def fetch_nmos_data(
    rds_host: str, query_port: int
):
    """RDSから全リソースをページネーション対応で並列取得"""
    base_url  = (
        f"http://{rds_host}:{query_port}"
        f"/x-nmos/query/v1.3"
    )
    resources = [
        "nodes", "devices", "senders",
        "receivers", "sources", "flows"
    ]

    async def fetch_one(
        client: httpx.AsyncClient,
        resource: str
    ):
        try:
            all_items = []
            url = (
                f"{base_url}/{resource}/"
                f"?paging.limit=100"
                f"&paging.order=update"
            )

            while url:
                response = await client.get(url)
                response.raise_for_status()
                items = response.json()

                if not items:
                    break

                all_items.extend(items)

                prev_url    = None
                link_header = response.headers.get(
                    "Link", "")
                if link_header:
                    for part in \
                            link_header.split(","):
                        part = part.strip()
                        if 'rel="prev"' in part:
                            start = part.find("<")
                            end   = part.find(">")
                            if start != -1 \
                                    and end != -1:
                                prev_url = part[
                                    start + 1:end]
                            break

                paging_limit = int(
                    response.headers.get(
                        "X-Paging-Limit", 100))

                if prev_url \
                        and len(items) \
                        >= paging_limit:
                    url = prev_url
                else:
                    url = None

            # IDで重複排除
            seen         = set()
            unique_items = []
            for item in all_items:
                if item["id"] not in seen:
                    seen.add(item["id"])
                    unique_items.append(item)

            nmos_data[resource] = {
                item["id"]: item
                for item in unique_items
            }
            logger.info(
                f"IS-04: {resource} を "
                f"{len(unique_items)} 件取得しました"
            )

        except Exception as e:
            logger.error(
                f"IS-04: {resource} 取得エラー: {e}"
            )

    # ==========================================
    # 6リソースを並列取得
    # ==========================================
    async with httpx.AsyncClient(
        timeout=10.0
    ) as client:
        await asyncio.gather(*[
            fetch_one(client, resource)
            for resource in resources
        ])

# ==========================================
# RDS WebSocket接続・監視
# ==========================================
async def connect_rds_websocket(
    rds_host: str, query_port: int
):
    """RDSのWebSocketに接続してリアルタイム更新を受信"""

    while True:
        try:
            logger.info(
                f"IS-04: RDS WebSocketに接続中... "
                f"{rds_host}:{query_port}"
            )

            # まず全データをHTTPで取得
            await fetch_nmos_data(rds_host, query_port)
            is04_status["connected"]    = True
            is04_status["rds_url"]      = \
                f"http://{rds_host}:{query_port}"
            is04_status["error"]        = None
            is04_status["last_updated"] = \
                datetime.now().isoformat()

            # GUI①にステータスとデータを通知
            await broadcast_to_gui({
                "type": "is04_status",
                "data": is04_status
            })
            await broadcast_to_gui({
                "type": "nmos_data",
                "data": nmos_data
            })

            # IS-05のconnectionMapを更新
            await notify_is05_nmos_updated()

            # IS-04 WebSocket：2段階接続
            base_url  = (
                f"http://{rds_host}:{query_port}"
                f"/x-nmos/query/v1.3"
            )
            resources = [
                "nodes", "devices", "senders",
                "receivers", "sources", "flows"
            ]

            ws_urls = []
            async with httpx.AsyncClient(
                timeout=10.0
            ) as client:
                for resource in resources:
                    sub_req = {
                        "max_update_rate_ms": 100,
                        "resource_path":
                            f"/{resource}",
                        "params":  {},
                        "persist": True,
                        "secure":  False
                    }
                    try:
                        resp = await client.post(
                            f"{base_url}/subscriptions",
                            json=sub_req
                        )
                        if resp.status_code in [
                            200, 201
                        ]:
                            sub_data = resp.json()
                            ws_href  = sub_data.get(
                                "ws_href", "")
                            if ws_href:
                                ws_urls.append(
                                    (resource, ws_href)
                                )
                                logger.info(
                                    f"IS-04: {resource}"
                                    f" サブスクリプション"
                                    f"作成: {ws_href}"
                                )
                    except Exception as e:
                        logger.error(
                            f"IS-04: {resource} "
                            f"サブスクリプション"
                            f"作成失敗: {e}"
                        )

            if not ws_urls:
                raise Exception(
                    "サブスクリプションURLが"
                    "取得できません"
                )

            first_ws_url = ws_urls[0][1]
            logger.info(
                f"IS-04: WebSocket接続: "
                f"{first_ws_url}"
            )

            async with websockets.connect(
                first_ws_url,
                ping_interval=20,
                ping_timeout=10
            ) as ws:
                logger.info(
                    "IS-04: RDS WebSocket接続成功"
                )

                # 定期再取得タスクを並行実行
                async def periodic_refresh():
                    while True:
                        await asyncio.sleep(30)  # 10 → 30秒
                        logger.info(
                            "IS-04: 定期データ再取得..."
                        )
                        await fetch_nmos_data(
                            rds_host, query_port)
                        is04_status["last_updated"] = \
                            datetime.now().isoformat()
                        await broadcast_to_gui({
                            "type": "nmos_data",
                            "data": nmos_data
                        })
                        await notify_is05_nmos_updated()

                refresh_task = asyncio.create_task(
                    periodic_refresh()
                )

                try:
                    async for message in ws:
                        try:
                            data = json.loads(message)
                            await handle_ws_message(data)
                        except Exception as e:
                            logger.error(
                                f"IS-04: WS処理エラー:"
                                f" {e}"
                            )
                finally:
                    refresh_task.cancel()

        except Exception as e:
            is04_status["connected"]    = False
            is04_status["error"]        = str(e)
            is04_status["last_updated"] = \
                datetime.now().isoformat()
            logger.error(
                f"IS-04: RDS接続エラー: {e}")

            await broadcast_to_gui({
                "type": "is04_status",
                "data": is04_status
            })

            logger.info(
                "IS-04: 5秒後に再接続します...")
            await asyncio.sleep(5)

# ==========================================
# IS-05へのイベント通知
# ==========================================
async def notify_is05_nmos_updated():
    """
    IS-04データ更新時に IS-05 の
    connectionMap更新を呼び出す
    循環インポートを避けるため
    関数内でインポートする
    """
    try:
        from is05 import on_nmos_data_updated
        await on_nmos_data_updated()
    except Exception as e:
        logger.error(
            f"IS-04: IS-05通知エラー: {e}"
        )

# ==========================================
# WebSocketメッセージ処理
# ==========================================
async def handle_ws_message(data: dict):
    """RDSからのWebSocketメッセージを処理する"""
    try:
        if "grain" in data:
            grain = data["grain"]
            if "data" in grain:
                for item in grain["data"]:
                    if "post" in item \
                            and item["post"]:
                        resource = item["post"]
                        resource_id   = \
                            resource.get("id")
                        resource_type = \
                            detect_resource_type(
                                resource)
                        if resource_type \
                                and resource_id:
                            nmos_data[
                                resource_type
                            ][resource_id] = resource
                            logger.info(
                                f"IS-04: "
                                f"{resource_type} "
                                f"更新: {resource_id}"
                            )

                    if "pre" in item \
                            and not item.get("post"):
                        resource = item["pre"]
                        resource_id   = \
                            resource.get("id")
                        resource_type = \
                            detect_resource_type(
                                resource)
                        if resource_type \
                                and resource_id:
                            nmos_data[
                                resource_type
                            ].pop(resource_id, None)
                            logger.info(
                                f"IS-04: "
                                f"{resource_type} "
                                f"削除: {resource_id}"
                            )

        is04_status["last_updated"] = \
            datetime.now().isoformat()

        await broadcast_to_gui({
            "type": "nmos_data",
            "data": nmos_data
        })

        # IS-05のconnectionMapを更新
        await notify_is05_nmos_updated()

    except Exception as e:
        logger.error(
            f"IS-04: メッセージ処理エラー: {e}"
        )

def detect_resource_type(
    resource: dict
) -> str | None:
    """リソースの種類を判定する"""
    if "node_id" not in resource \
            and "description" in resource:
        return "nodes"
    elif "node_id" in resource \
            and "senders" in resource:
        return "devices"
    elif "flow_id" in resource:
        return "senders"
    elif "subscription" in resource:
        return "receivers"
    elif "device_id" in resource \
            and "format" in resource \
            and "grain_rate" in resource:
        return "flows"
    elif "device_id" in resource \
            and "format" in resource:
        return "sources"
    return None

# ==========================================
# GUI①へのブロードキャスト
# ==========================================
async def broadcast_to_gui(message: dict):
    """接続中の全GUI①クライアントにメッセージ送信"""
    if not gui_clients:
        return

    message_str = json.dumps(
        message, ensure_ascii=False)
    disconnected = []

    for client in gui_clients:
        try:
            await client.send_text(message_str)
        except Exception:
            disconnected.append(client)

    for client in disconnected:
        gui_clients.remove(client)

# ==========================================
# APIエンドポイント
# ==========================================
@router.get("/api/is04/status")
async def get_is04_status():
    return is04_status

@router.get("/api/is04/nodes")
async def get_nodes():
    return list(nmos_data["nodes"].values())

@router.get("/api/is04/devices")
async def get_devices():
    return list(nmos_data["devices"].values())

@router.get("/api/is04/senders")
async def get_senders():
    return list(nmos_data["senders"].values())

@router.get("/api/is04/receivers")
async def get_receivers():
    return list(nmos_data["receivers"].values())

@router.get("/api/is04/sources")
async def get_sources():
    return list(nmos_data["sources"].values())

@router.get("/api/is04/flows")
async def get_flows():
    return list(nmos_data["flows"].values())

@router.get("/api/is04/all")
async def get_all():
    return {
        "status": is04_status,
        "data":   nmos_data
    }

# ==========================================
# GUI①向けWebSocketエンドポイント
# ==========================================
@router.websocket("/ws/gui")
async def websocket_gui(websocket: WebSocket):
    await websocket.accept()
    gui_clients.append(websocket)
    logger.info(
        f"GUI WebSocket接続: "
        f"現在{len(gui_clients)}クライアント接続中"
    )

    try:
        await websocket.send_text(json.dumps({
            "type": "is04_status",
            "data": is04_status
        }, ensure_ascii=False))
        await websocket.send_text(json.dumps({
            "type": "nmos_data",
            "data": nmos_data
        }, ensure_ascii=False))

        # 接続直後にconnectionMapも送信
        from is05 import connection_map
        await websocket.send_text(json.dumps({
            "type": "connection_map",
            "data": connection_map
        }, ensure_ascii=False))

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        gui_clients.remove(websocket)
        logger.info(
            f"GUI WebSocket切断: "
            f"残り{len(gui_clients)}クライアント接続中"
        )

@router.get("/api/is04/sdp")
async def get_sdp(url: str):
    try:
        async with httpx.AsyncClient(
            timeout=10.0
        ) as client:
            response = await client.get(url)
            response.raise_for_status()
            from fastapi.responses import PlainTextResponse
            return PlainTextResponse(response.text)
    except Exception as e:
        logger.error(f"SDP取得エラー: {url} - {e}")
        from fastapi import HTTPException
        raise HTTPException(
            status_code=502,
            detail=f"SDP取得失敗: {str(e)}"
        )