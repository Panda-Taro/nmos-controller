# rest_api.py - REST APIトリガー管理

import re
import logging
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)
router = APIRouter()

# ==========================================
# 定数
# ==========================================
MAX_TRIGGER_NUM = 999
LABEL_PATTERN   = re.compile(r'^[a-zA-Z0-9_-]+$')

# ==========================================
# Pydanticモデル
# ==========================================

class TriggerCreate(BaseModel):
    label:             str
    video_sender_id:   str
    video_receiver_id: str
    audio_sender_id:   str
    audio_receiver_id: str
    anc_sender_id:     str
    anc_receiver_id:   str
    keyboard_shortcut: Optional[str] = None

class TriggerUpdate(BaseModel):
    label:             Optional[str] = None
    video_sender_id:   Optional[str] = None
    video_receiver_id: Optional[str] = None
    audio_sender_id:   Optional[str] = None
    audio_receiver_id: Optional[str] = None
    anc_sender_id:     Optional[str] = None
    anc_receiver_id:   Optional[str] = None
    keyboard_shortcut: Optional[str] = None

class ReorderRequest(BaseModel):
    keys: list[str]  # 新しい順番のキーリスト

# ==========================================
# DBユーティリティ
# ==========================================

def load_triggers() -> dict:
    """database.json から rest_api_triggers を取得"""
    from materials import load_db
    db = load_db()
    return db.get("rest_api_triggers", {})

def save_triggers(triggers: dict):
    """database.json に rest_api_triggers を保存"""
    from materials import load_db, save_db
    db = load_db()
    db["rest_api_triggers"] = triggers
    save_db(db)

# ==========================================
# バリデーション
# ==========================================

def validate_label(label: str) -> str | None:
    """
    labelのバリデーション
    英数字・アンダースコア・ハイフンのみ
    2バイト文字（日本語等）も禁止
    戻り値: エラーメッセージ or None（OK）
    """
    if not label:
        return "labelを入力してください"
    try:
        label.encode('ascii')
    except UnicodeEncodeError:
        return (
            "labelに2バイト文字（日本語等）は"
            "使用できません"
        )
    if not LABEL_PATTERN.match(label):
        return (
            "labelは英数字・アンダースコア・"
            "ハイフンのみ使用できます"
        )
    return None

# ==========================================
# 採番ユーティリティ
# ==========================================

def assign_next_number(triggers: dict) -> str:
    """
    001〜999の中で最小の空き番号を返す
    """
    existing = set(triggers.keys())
    for i in range(1, MAX_TRIGGER_NUM + 1):
        key = str(i).zfill(3)
        if key not in existing:
            return key
    return None  # 999件満杯

# ==========================================
# IDの解決
# ==========================================

def resolve_trigger_id(
    trigger_id: str,
    triggers: dict
) -> str | None:
    """
    trigger_id を実際のキーに解決する

    ① 数字のみ → ゼロ埋め3桁として検索
       例: "1" → "001", "12" → "012"
    ② それ以外 → labelとして検索（大文字小文字区別）
    """
    # ① 数字のみ → 番号キーとして検索
    if trigger_id.isdigit():
        key = trigger_id.zfill(3)
        return key if key in triggers else None

    # ② label検索（大文字小文字を区別）
    for key, trigger in triggers.items():
        if trigger.get("label") == trigger_id:
            return key

    return None

# ==========================================
# トリガー実行（内部処理）
# ==========================================

async def execute_trigger(trigger: dict) -> list[str]:
    from is05 import (
        get_is05_base_url,
        patch_staged,
        fetch_sdp_from_manifest,
        connection_map,              # ← 追加
        broadcast_connection_map     # ← 追加
    )
    from is04 import nmos_data
    from materials import load_db

    db     = load_db()
    errors = []

    categories = [
        {
            "name":        "Video",
            "sender_id":   trigger.get("video_sender_id",   ""),
            "receiver_id": trigger.get("video_receiver_id", "")
        },
        {
            "name":        "Audio",
            "sender_id":   trigger.get("audio_sender_id",   ""),
            "receiver_id": trigger.get("audio_receiver_id", "")
        },
        {
            "name":        "ANC",
            "sender_id":   trigger.get("anc_sender_id",   ""),
            "receiver_id": trigger.get("anc_receiver_id", "")
        }
    ]

    for cat in categories:
        sender_id   = cat["sender_id"]
        receiver_id = cat["receiver_id"]
        name        = cat["name"]

        # none → スキップ
        if receiver_id == "none":
            continue

        # IS-05エンドポイントを特定
        base_url = get_is05_base_url(receiver_id)
        if not base_url:
            errors.append(
                f"{name}: IS-05エンドポイントが"
                f"特定できません "
                f"(receiver={receiver_id})"
            )
            continue

        # ==========================================
        # leave → LEAVE実行
        # ==========================================
        if sender_id == "leave":
            ok, code, msg = await patch_staged(
                base_url,
                receiver_id,
                sender_id=None,
                master_enable=False,
                sdp_content=None
            )
            if not ok:
                errors.append(
                    f"{name}: LEAVE失敗 "
                    f"({code}: {msg})"
                )
            else:
                logger.info(
                    f"REST API: {name} LEAVE成功 "
                    f"receiver={receiver_id}"
                )
                # ✅ LEAVE成功 → connection_map更新
                connection_map[receiver_id] = {
                    "sender_resource_id": None,
                    "sender_label":       None,
                    "status":             "disconnected",
                    "error_code":         None,
                    "error_msg":          None,
                    "connected_at":       None
                }
            continue

        # ==========================================
        # TAKE → SDP取得 → PATCH
        # ==========================================
        sender_item = None
        for category in ["video", "audio", "ancillary"]:
            for item in db["materials"].get(category, []):
                if item.get("resource_id") == sender_id:
                    sender_item = item
                    break
            if sender_item:
                break

        if not sender_item:
            errors.append(
                f"{name}: Sender素材が"
                f"見つかりません "
                f"(sender_id={sender_id})"
            )
            continue

        # SDP準備
        source_type    = sender_item.get("source", "sdp")
        sdp_content    = None
        nmos_sender_id = None

        if source_type == "sdp":
            sdp_content    = sender_item.get("sdp_content", "")
            nmos_sender_id = None

        elif source_type == "is04":
            nmos_sender_id = sender_id
            sender_nmos    = nmos_data["senders"].get(sender_id)

            if sender_nmos and sender_nmos.get("manifest_href"):
                sdp_content = await fetch_sdp_from_manifest(
                    sender_nmos["manifest_href"],
                    sender_id=sender_id
                )
                if not sdp_content:
                    logger.warning(
                        f"REST API: {name} SDP取得失敗。"
                        f"transport_fileなしで試みます"
                    )
            else:
                sdp_content = sender_item.get(
                    "resource_data", {}
                ).get("sdp_content")

        ok, code, msg = await patch_staged(
            base_url,
            receiver_id,
            sender_id=nmos_sender_id,
            master_enable=True,
            sdp_content=sdp_content
        )
        if not ok:
            errors.append(
                f"{name}: TAKE失敗 "
                f"({code}: {msg})"
            )
            # ✅ TAKE失敗 → connection_mapにerror記録
            connection_map[receiver_id] = {
                "sender_resource_id": sender_id,
                "sender_label":       sender_item.get("label", sender_id),
                "status":             "error",
                "error_code":         code,
                "error_msg":          msg,
                "connected_at":       None
            }
        else:
            logger.info(
                f"REST API: {name} TAKE成功 "
                f"sender={sender_id} "
                f"receiver={receiver_id}"
            )
            # ✅ TAKE成功 → connection_map更新
            from datetime import datetime
            connection_map[receiver_id] = {
                "sender_resource_id": sender_id,
                "sender_label":       sender_item.get("label", sender_id),
                "status":             "connected",
                "error_code":         None,
                "error_msg":          None,
                "connected_at":       datetime.now().isoformat()
            }

    # ✅ 全カテゴリ処理後にまとめてbroadcast（1回だけ）
    await broadcast_connection_map()

    return errors

# ==========================================
# 【外部トリガー実行】
# GET|POST /api/trigger/{trigger_id}
# ==========================================

@router.get("/api/trigger/{trigger_id}")
@router.post("/api/trigger/{trigger_id}")
async def fire_trigger(trigger_id: str):
    """
    外部からのトリガー実行（Stream Deck等）
    成功: 200 OK（bodyなし）
    失敗: 502（bodyなし）
    """
    triggers = load_triggers()
    resolved = resolve_trigger_id(
        trigger_id, triggers)

    if not resolved:
        logger.warning(
            f"REST API: トリガーが見つかりません: "
            f"{trigger_id}"
        )
        return Response(status_code=500)

    trigger = triggers[resolved]

    logger.info(
        f"REST API: トリガー実行: "
        f"{resolved} ({trigger.get('label', '')})"
    )

    errors = await execute_trigger(trigger)

    if errors:
        for e in errors:
            logger.error(f"REST API: {e}")
        return Response(status_code=502)

    return Response(status_code=200)

# ==========================================
# 【一覧取得】
# GET /api/rest-triggers
# ==========================================

@router.get("/api/rest-triggers")
async def get_triggers():
    """
    全トリガーを番号順で返す
    """
    triggers = load_triggers()
    result   = []

    for key in sorted(triggers.keys()):
        t = triggers[key]
        result.append({
            "number":            key,
            "label":             t.get("label", ""),
            "video_sender_id":   t.get(
                "video_sender_id",   ""),
            "video_receiver_id": t.get(
                "video_receiver_id", ""),
            "audio_sender_id":   t.get(
                "audio_sender_id",   ""),
            "audio_receiver_id": t.get(
                "audio_receiver_id", ""),
            "anc_sender_id":     t.get(
                "anc_sender_id",   ""),
            "anc_receiver_id":   t.get(
                "anc_receiver_id", ""),
            "keyboard_shortcut": t.get(
                "keyboard_shortcut", None)
        })

    return JSONResponse(content=result)

# ==========================================
# 【新規作成】
# POST /api/rest-triggers
# ==========================================

@router.post("/api/rest-triggers")
async def create_trigger(req: TriggerCreate):
    """
    トリガー新規作成
    番号は自動採番（最小の空き番号）
    """
    # labelバリデーション
    err = validate_label(req.label)
    if err:
        raise HTTPException(
            status_code=400, detail=err)

    triggers = load_triggers()

    # label重複チェック
    for key, t in triggers.items():
        if t.get("label") == req.label:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"label '{req.label}' は"
                    f"既に使用されています "
                    f"(番号: {key})"
                )
            )

    # ショートカット重複チェック
    if req.keyboard_shortcut:
        for key, t in triggers.items():
            if t.get("keyboard_shortcut") \
                    == req.keyboard_shortcut:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"ショートカット "
                        f"'{req.keyboard_shortcut}' は"
                        f"既に使用されています "
                        f"(番号: {key})"
                    )
                )

    # 自動採番
    new_key = assign_next_number(triggers)
    if new_key is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"トリガーは最大{MAX_TRIGGER_NUM}"
                f"件まで登録できます"
            )
        )

    triggers[new_key] = {
        "label":             req.label,
        "video_sender_id":   req.video_sender_id,
        "video_receiver_id": req.video_receiver_id,
        "audio_sender_id":   req.audio_sender_id,
        "audio_receiver_id": req.audio_receiver_id,
        "anc_sender_id":     req.anc_sender_id,
        "anc_receiver_id":   req.anc_receiver_id,
        "keyboard_shortcut": req.keyboard_shortcut
    }

    save_triggers(triggers)

    logger.info(
        f"REST API: トリガー作成: "
        f"{new_key} ({req.label})"
    )

    return JSONResponse(content={
        "message": (
            f"トリガー「{req.label}」を"
            f"作成しました (番号: {new_key})"
        ),
        "number": new_key
    })

# ==========================================
# 【詳細取得】
# GET /api/rest-triggers/{trigger_id}
# ==========================================

@router.get("/api/rest-triggers/{trigger_id}")
async def get_trigger(trigger_id: str):
    """
    特定トリガーの詳細を返す
    """
    triggers = load_triggers()
    resolved = resolve_trigger_id(
        trigger_id, triggers)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"トリガー '{trigger_id}' が"
                f"見つかりません"
            )
        )

    t = triggers[resolved]
    return JSONResponse(content={
        "number":            resolved,
        "label":             t.get("label", ""),
        "video_sender_id":   t.get(
            "video_sender_id",   ""),
        "video_receiver_id": t.get(
            "video_receiver_id", ""),
        "audio_sender_id":   t.get(
            "audio_sender_id",   ""),
        "audio_receiver_id": t.get(
            "audio_receiver_id", ""),
        "anc_sender_id":     t.get(
            "anc_sender_id",   ""),
        "anc_receiver_id":   t.get(
            "anc_receiver_id", ""),
        "keyboard_shortcut": t.get(
            "keyboard_shortcut", None)
    })

# ==========================================
# 【並び替え（番号の入れ替え）】
# PUT /api/rest-triggers/reorder
# ==========================================

@router.put("/api/rest-triggers/reorder")
async def reorder_triggers(req: ReorderRequest):
    """
    番号は固定のまま、中身（label・V/A/ANC等）だけを入れ替える。

    例: req.keys = ["003","001","002"]（ドラッグ後の表示順）
        sorted_numbers = ["001","002","003"]（昇順固定）
        → 001の中身 ← 元003の内容
          002の中身 ← 元001の内容
          003の中身 ← 元002の内容
    """
    triggers = load_triggers()

    # 全キーが存在するか確認
    for key in req.keys:
        if key not in triggers:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"トリガー '{key}' が"
                    f"見つかりません"
                )
            )

    # ✅ ドラッグ後の順序で中身を取り出す
    contents = [triggers[k] for k in req.keys]

    # ✅ 番号を昇順に固定し、中身だけを割り当て直す
    sorted_numbers = sorted(req.keys)
    for number, content in zip(sorted_numbers, contents):
        triggers[number] = content

    save_triggers(triggers)

    logger.info(
        f"REST API: トリガー並び替え: "
        f"{req.keys}"
    )

    return JSONResponse(content={
        "message": "並び順を更新しました"
    })

# ==========================================
# 【更新】
# PUT /api/rest-triggers/{trigger_id}
# ==========================================

@router.put("/api/rest-triggers/{trigger_id}")
async def update_trigger(
    trigger_id: str,
    req: TriggerUpdate
):
    """
    トリガー内容更新
    """
    triggers = load_triggers()
    resolved = resolve_trigger_id(
        trigger_id, triggers)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"トリガー '{trigger_id}' が"
                f"見つかりません"
            )
        )

    t = triggers[resolved]

    # label更新の場合はバリデーション・重複チェック
    if req.label is not None:
        err = validate_label(req.label)
        if err:
            raise HTTPException(
                status_code=400, detail=err)

        for key, trig in triggers.items():
            if key == resolved:
                continue
            if trig.get("label") == req.label:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"label '{req.label}' は"
                        f"既に使用されています "
                        f"(番号: {key})"
                    )
                )
        t["label"] = req.label

    # ショートカット更新の場合は重複チェック
    if req.keyboard_shortcut is not None:
        if req.keyboard_shortcut != "":
            for key, trig in triggers.items():
                if key == resolved:
                    continue
                if trig.get("keyboard_shortcut") \
                        == req.keyboard_shortcut:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"ショートカット "
                            f"'{req.keyboard_shortcut}'"
                            f" は既に使用されています "
                            f"(番号: {key})"
                        )
                    )
        t["keyboard_shortcut"] = \
            req.keyboard_shortcut or None

    # その他フィールドの更新
    for field in [
        "video_sender_id",
        "video_receiver_id",
        "audio_sender_id",
        "audio_receiver_id",
        "anc_sender_id",
        "anc_receiver_id"
    ]:
        val = getattr(req, field)
        if val is not None:
            t[field] = val

    triggers[resolved] = t
    save_triggers(triggers)

    logger.info(
        f"REST API: トリガー更新: {resolved}"
    )

    return JSONResponse(content={
        "message": (
            f"トリガー「{t['label']}」を"
            f"更新しました"
        )
    })

# ==========================================
# 【削除】
# DELETE /api/rest-triggers/{trigger_id}
# ==========================================

@router.delete(
    "/api/rest-triggers/{trigger_id}"
)
async def delete_trigger(trigger_id: str):
    """
    トリガー削除
    """
    triggers = load_triggers()
    resolved = resolve_trigger_id(
        trigger_id, triggers)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"トリガー '{trigger_id}' が"
                f"見つかりません"
            )
        )

    label = triggers[resolved].get(
        "label", resolved)
    del triggers[resolved]
    save_triggers(triggers)

    logger.info(
        f"REST API: トリガー削除: {resolved}"
    )

    return JSONResponse(content={
        "message": (
            f"トリガー「{label}」を削除しました"
        )
    })

# ==========================================
# 【テスト実行】
# POST /api/rest-triggers/{trigger_id}/test
# ==========================================

@router.post(
    "/api/rest-triggers/{trigger_id}/test"
)
async def test_trigger(trigger_id: str):
    """
    システムGUIからのテスト実行
    成功・失敗の詳細をbodyで返す
    """
    triggers = load_triggers()
    resolved = resolve_trigger_id(
        trigger_id, triggers)

    if not resolved:
        raise HTTPException(
            status_code=404,
            detail=(
                f"トリガー '{trigger_id}' が"
                f"見つかりません"
            )
        )

    trigger = triggers[resolved]

    logger.info(
        f"REST API: テスト実行: "
        f"{resolved} ({trigger.get('label', '')})"
    )

    errors = await execute_trigger(trigger)

    if errors:
        return JSONResponse(
            status_code=502,
            content={
                "status":  "error",
                "errors":  errors,
                "message": (
                    f"{len(errors)}件のエラーが"
                    f"発生しました"
                )
            }
        )

    return JSONResponse(content={
        "status":  "ok",
        "message": (
            f"トリガー「{trigger.get('label', '')}」"
            f"を実行しました"
        )
    })