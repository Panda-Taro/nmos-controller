# routers/gui2.py - GUI② パネル管理API + ルーター

import uuid
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import (
    JSONResponse, FileResponse
)
from pydantic import BaseModel
from typing import Optional
from pathlib import Path

logger = logging.getLogger(__name__)
router = APIRouter()

GUI2_HTML = Path(
    "static/gui2/index.html"
)

# ==========================================
# Pydanticモデル
# ==========================================

class SourceItem(BaseModel):
    id:               Optional[str] = None
    label:            str
    video_sender_id:  str  # "leave" or resource_id
    audio_sender_id:  str  # "leave" or resource_id
    anc_sender_id:    str  # "leave" or resource_id

class DestItem(BaseModel):
    id:                  Optional[str] = None
    label:               str
    video_receiver_id:   str  # "none" or resource_id
    audio_receiver_id:   str  # "none" or resource_id
    anc_receiver_id:     str  # "none" or resource_id

class PanelCreate(BaseModel):
    panel_id:     str
    display_name: str
    sources:      list[SourceItem]  = []
    destinations: list[DestItem]    = []

class PanelUpdate(BaseModel):
    display_name: Optional[str]          = None
    sources:      Optional[list[SourceItem]]  = None
    destinations: Optional[list[DestItem]]    = None

class ReorderRequest(BaseModel):
    panel_ids: list[str]  # 新しい順番のIDリスト

# ==========================================
# ユーティリティ
# ==========================================

def load_panels() -> dict:
    """database.json から gui2_panels を取得"""
    from materials import load_db
    db = load_db()
    return db.get("gui2_panels", {})

def save_panels(panels: dict):
    """database.json に gui2_panels を保存"""
    from materials import load_db, save_db
    db = load_db()
    db["gui2_panels"] = panels
    save_db(db)

def panel_id_valid(panel_id: str) -> bool:
    """
    パネルIDのバリデーション
    英数字・ハイフン・アンダースコアのみ
    """
    import re
    return bool(
        re.match(r'^[a-zA-Z0-9_-]+$', panel_id)
    )

def resolve_panel_id(
    panel_id: str,
    panels: dict
) -> str | None:
    """
    panel_id を実際のキーに解決する

    "01"〜"10" → order番号として検索
    それ以外   → パネルIDとして検索
    """
    # 数値（01〜10）の場合はorder番号として解釈
    if panel_id.isdigit():
        order = int(panel_id) - 1  # 01→0, 02→1...
        sorted_panels = sorted(
            panels.items(),
            key=lambda x: x[1].get("order", 999)
        )
        if 0 <= order < len(sorted_panels):
            return sorted_panels[order][0]
        return None

    # 英数字IDとして検索
    return panel_id if panel_id in panels else None

def assign_orders(panels: dict) -> dict:
    """
    全パネルのorderを連番で振り直す
    """
    sorted_items = sorted(
        panels.items(),
        key=lambda x: x[1].get("order", 999)
    )
    for i, (pid, panel) in enumerate(sorted_items):
        panels[pid]["order"] = i
    return panels

def ensure_item_ids(
    items: list[dict]
) -> list[dict]:
    """
    Source/Dest の各行に id がなければ付与
    """
    for item in items:
        if not item.get("id"):
            item["id"] = str(uuid.uuid4())
    return items

# ==========================================
# 【ルーター】GET /panel/{panel_id}
# ==========================================
@router.get("/panel/{panel_id}")
async def serve_gui2(panel_id: str):
    """
    GUI②本体のHTMLを返す
    panel_id が存在しない場合は404
    """
    panels = load_panels()
    resolved = resolve_panel_id(
        panel_id, panels)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"パネル '{panel_id}' が"
                f"見つかりません"
            )
        )

    if not GUI2_HTML.exists():
        raise HTTPException(
            status_code=503,
            detail="GUI②ファイルが未作成です"
        )

    return FileResponse(GUI2_HTML)

# ==========================================
# 【API】GET /api/gui2/panels
# ==========================================
@router.get("/api/gui2/panels")
async def get_panels():
    """
    全パネル一覧をorder順で返す
    """
    panels = load_panels()

    sorted_panels = sorted(
        panels.items(),
        key=lambda x: x[1].get("order", 999)
    )

    result = []
    for i, (pid, panel) in \
            enumerate(sorted_panels):
        result.append({
            "panel_id":     pid,
            "display_name": panel.get(
                "display_name", pid),
            "order":        panel.get("order", i),
            "order_number": str(i + 1).zfill(2),
            "source_count": len(
                panel.get("sources", [])),
            "dest_count":   len(
                panel.get("destinations", []))
        })

    return JSONResponse(content=result)

# ==========================================
# 【API】GET /api/gui2/panels/{panel_id}
# ==========================================
@router.get("/api/gui2/panels/{panel_id}")
async def get_panel(panel_id: str):
    """
    特定パネルの詳細を返す
    "01"〜"10" はorder番号として解釈
    """
    panels  = load_panels()
    resolved = resolve_panel_id(
        panel_id, panels)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"パネル '{panel_id}' が"
                f"見つかりません"
            )
        )

    panel = panels[resolved]
    return JSONResponse(content={
        "panel_id":     resolved,
        "display_name": panel.get(
            "display_name", resolved),
        "order":        panel.get("order", 0),
        "sources":      panel.get("sources",      []),
        "destinations": panel.get("destinations", [])
    })

# ==========================================
# 【API】POST /api/gui2/panels
# ==========================================
@router.post("/api/gui2/panels")
async def create_panel(req: PanelCreate):
    """
    パネル新規作成
    """
    # IDバリデーション
    if not panel_id_valid(req.panel_id):
        raise HTTPException(
            status_code=400,
            detail=(
                "パネルIDは英数字・ハイフン・"
                "アンダースコアのみ使用できます"
            )
        )

    panels = load_panels()

    # 重複チェック
    if req.panel_id in panels:
        raise HTTPException(
            status_code=409,
            detail=(
                f"パネルID '{req.panel_id}' は"
                f"既に存在します"
            )
        )

    # orderは末尾に追加
    max_order = max(
        (p.get("order", 0)
         for p in panels.values()),
        default=-1
    )

    # Source/Dest に id を付与
    sources = ensure_item_ids([
        s.model_dump() for s in req.sources
    ])
    destinations = ensure_item_ids([
        d.model_dump() for d in req.destinations
    ])

    panels[req.panel_id] = {
        "display_name": req.display_name,
        "order":        max_order + 1,
        "sources":      sources,
        "destinations": destinations
    }

    save_panels(panels)

    logger.info(
        f"GUI2: パネル作成: "
        f"{req.panel_id} "
        f"({req.display_name})"
    )

    # connectionMap監視対象を更新
    await notify_is05_panel_updated()

    return JSONResponse(content={
        "message": (
            f"パネル「{req.display_name}」を"
            f"作成しました"
        ),
        "panel_id": req.panel_id
    })

# ==========================================
# 【API】PUT /api/gui2/panels/{panel_id}
# ==========================================
@router.put("/api/gui2/panels/{panel_id}")
async def update_panel(
    panel_id: str,
    req: PanelUpdate
):
    """
    パネル内容更新
    """
    panels   = load_panels()
    resolved = resolve_panel_id(
        panel_id, panels)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"パネル '{panel_id}' が"
                f"見つかりません"
            )
        )

    panel = panels[resolved]

    if req.display_name is not None:
        panel["display_name"] = req.display_name

    if req.sources is not None:
        panel["sources"] = ensure_item_ids([
            s.model_dump() for s in req.sources
        ])

    if req.destinations is not None:
        panel["destinations"] = ensure_item_ids([
            d.model_dump() for d in req.destinations
        ])

    panels[resolved] = panel
    save_panels(panels)

    logger.info(
        f"GUI2: パネル更新: {resolved}"
    )

    # connectionMap監視対象を更新
    await notify_is05_panel_updated()

    # source/destinationの構成（≒レイアウト）が
    # 変更された場合、このパネルを開いている全クライアント
    # （自分自身も含む）へ通知し、画面を再読み込みさせる
    if req.sources is not None \
            or req.destinations is not None:
        from is04 import broadcast_to_gui
        await broadcast_to_gui({
            "type":     "gui2_panel_layout_updated",
            "panel_id": resolved
        })

    return JSONResponse(content={
        "message": (
            f"パネル「{panel['display_name']}」を"
            f"更新しました"
        )
    })

# ==========================================
# 【API】PUT /api/gui2/panels/reorder
# ==========================================
@router.put("/api/gui2/panels/reorder")
async def reorder_panels(req: ReorderRequest):
    """
    パネルの並び順を一括更新
    req.panel_ids: 新しい順番のIDリスト
    """
    panels = load_panels()

    # 全IDが存在するか確認
    for pid in req.panel_ids:
        if pid not in panels:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"パネル '{pid}' が"
                    f"見つかりません"
                )
            )

    # orderを振り直す
    for i, pid in enumerate(req.panel_ids):
        panels[pid]["order"] = i

    save_panels(panels)

    logger.info(
        f"GUI2: パネル並び替え: "
        f"{req.panel_ids}"
    )

    return JSONResponse(content={
        "message": "並び順を更新しました"
    })

# ==========================================
# 【API】DELETE /api/gui2/panels/{panel_id}
# ==========================================
@router.delete(
    "/api/gui2/panels/{panel_id}"
)
async def delete_panel(panel_id: str):
    """
    パネル削除
    """
    panels   = load_panels()
    resolved = resolve_panel_id(
        panel_id, panels)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"パネル '{panel_id}' が"
                f"見つかりません"
            )
        )

    display_name = panels[resolved].get(
        "display_name", resolved)
    del panels[resolved]

    # orderを振り直す
    panels = assign_orders(panels)
    save_panels(panels)

    logger.info(
        f"GUI2: パネル削除: {resolved}"
    )

    # connectionMap監視対象を更新
    await notify_is05_panel_updated()

    return JSONResponse(content={
        "message": (
            f"パネル「{display_name}」を"
            f"削除しました"
        )
    })

# ==========================================
# IS-05 connectionMap 監視対象更新通知
# ==========================================
async def notify_is05_panel_updated():
    """
    パネルが更新されたとき
    IS-05の監視対象を再構築する
    """
    try:
        from is05 import on_nmos_data_updated
        await on_nmos_data_updated()
    except Exception as e:
        logger.warning(
            f"GUI2: IS-05通知エラー: {e}"
        )