# materials.py - 素材管理API

import json
import uuid
import logging
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

# ==========================================
# パス定数
# ==========================================
CONFIG_PATH   = Path(__file__).parent / "data" / "config.json"
DATABASE_PATH = Path(__file__).parent / "data" / "database.json"

# ==========================================
# ユーティリティ
# ==========================================
def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def load_db() -> dict:
    with open(DATABASE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_db(db: dict):
    with open(DATABASE_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)

def get_sdp_dir() -> Path:
    config  = load_config()
    sdp_dir = Path(config["sdp"]["directory"])
    sdp_dir.mkdir(parents=True, exist_ok=True)
    return sdp_dir

def parse_sdp_description(sdp_content: str) -> str:
    """
    SDPの s= フィールドから description を取得
    なければ空文字を返す
    """
    for line in sdp_content.splitlines():
        line = line.strip()
        if line.startswith("s="):
            val = line[2:].strip()
            if val and val != "-":
                return val
    return ""

def check_label_duplicate(
    db:            dict,
    category:      str,
    resource_type: str,
    label:         str,
    exclude_id:    str = None
) -> bool:
    """
    category + resource_type の組み合わせで
    ラベル重複チェック
    例:
      video + sender   → Video Sender ペイン
      video + receiver → Video Receiver ペイン
    exclude_id: 編集時に自分自身を除外
    True → 重複あり
    """
    for item in db["materials"].get(category, []):
        if exclude_id and item["id"] == exclude_id:
            continue
        if item.get("resource_type") != resource_type:
            continue
        if item["label"] == label:
            return True
    return False

def get_pane_name(
    category: str, resource_type: str
) -> str:
    """
    エラーメッセージ用のペイン名を返す
    例: "Video Sender", "Audio Receiver"
    """
    cat_ja = {
        "video":     "Video",
        "audio":     "Audio",
        "ancillary": "Ancillary"
    }.get(category, category)

    type_ja = {
        "sender":   "Sender",
        "receiver": "Receiver"
    }.get(resource_type, resource_type)

    return f"{cat_ja} {type_ja}"

# ==========================================
# 起動時マイグレーション＆SDPファイル存在チェック
# ==========================================
def check_sdp_files_on_startup(logger):
    """
    ① 既存素材に不足フィールドを自動付与
       source / resource_type / resource_id
    ② SDPファイル存在チェック
       source:"is04" はスキップ
    """
    try:
        config  = load_config()
        sdp_dir = Path(config["sdp"]["directory"])
        db      = load_db()
        changed = False

        for category in ["video", "audio", "ancillary"]:
            items = db["materials"].get(category, [])
            valid = []
            for item in items:

                # ① マイグレーション
                if "source" not in item:
                    item["source"] = "sdp"
                    changed = True
                if "resource_type" not in item:
                    item["resource_type"] = "sender"
                    changed = True
                if "resource_id" not in item:
                    item["resource_id"] = item["id"]
                    changed = True

                # ② SDPファイル存在チェック
                #    source:"is04" はスキップ
                if item["source"] == "is04":
                    valid.append(item)
                    continue

                sdp_path = sdp_dir / item.get(
                    "sdp_file", "")
                if sdp_path.exists():
                    valid.append(item)
                else:
                    logger.warning(
                        f"SDPファイルが見つかりません。"
                        f"database.jsonから削除: "
                        f"{item.get('sdp_file', '')} "
                        f"({item['label']})"
                    )
                    changed = True

            db["materials"][category] = valid

        if changed:
            save_db(db)
            logger.info(
                "起動時チェック: "
                "database.jsonを更新しました"
            )
        else:
            logger.info(
                "起動時チェック: 全ファイル正常"
            )

    except Exception as e:
        logger.error(f"起動時チェックエラー: {e}")

# ==========================================
# 【0】GUI①用 素材一覧取得
# ==========================================
@router.get("/api/materials/list")
async def get_materials_list():
    """
    GUI①用: senders/receivers 形式で返す
    resource_type で振り分けて返す
    """
    try:
        db        = load_db()
        senders   = {}
        receivers = {}

        for category in ["video", "audio", "ancillary"]:
            for item in db["materials"].get(
                category, []
            ):
                resource_type = item.get(
                    "resource_type", "sender")
                entry = {
                    "resource_id":   item.get(
                        "resource_id", item["id"]),
                    "resource_type": resource_type,
                    "label":         item["label"],
                    "material_type": category,
                    "source":        item.get(
                        "source", "sdp"),
                    "resource_data": item.get(
                        "resource_data", {
                            "sdp_content": item.get(
                                "sdp_content", "")
                        })
                }
                if resource_type == "receiver":
                    receivers[item.get(
                        "resource_id", item["id"]
                    )] = entry
                else:
                    senders[item.get(
                        "resource_id", item["id"]
                    )] = entry

        return JSONResponse(content={
            "senders":   senders,
            "receivers": receivers
        })

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"素材一覧取得エラー: {e}"
        )

# ==========================================
# 【0-2】Node GUI用 IS-04素材新規登録
# ==========================================
class RegisterMaterialRequest(BaseModel):
    resource_type: str
    resource_id:   str
    label:         str
    material_type: str
    resource_data: dict = {}

@router.post("/api/materials/register")
async def register_material(
    req: RegisterMaterialRequest
):
    """
    Node GUI: IS-04素材の新規登録
    ① resource_id で全カテゴリ検索
    ② 存在する（同一resource_id）→ 409エラー
    ③ category + resource_type でラベル重複チェック
    ④ 存在しない → 新規追加（source:"is04"）
    """
    try:
        db = load_db()

        # ① resource_id で全カテゴリ検索
        for category in ["video", "audio", "ancillary"]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_id") \
                        == req.resource_id:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"「{item['label']}」"
                            f"は既に登録済みです。"
                        )
                    )

        # material_type チェック
        if req.material_type not in [
            "video", "audio", "ancillary"
        ]:
            raise HTTPException(
                status_code=400,
                detail="material_type が不正です"
            )

        # resource_type チェック
        if req.resource_type not in [
            "sender", "receiver"
        ]:
            raise HTTPException(
                status_code=400,
                detail="resource_type が不正です"
            )

        # ③ category + resource_type で
        #    ラベル重複チェック
        if check_label_duplicate(
            db,
            req.material_type,
            req.resource_type,
            req.label
        ):
            pane = get_pane_name(
                req.material_type, req.resource_type)
            raise HTTPException(
                status_code=409,
                detail=(
                    f"「{req.label}」は既に"
                    f"{pane}ペインに"
                    f"登録済みです。"
                    f"ラベルを変更してください。"
                )
            )

        # ④ 新規追加
        item_id  = str(uuid.uuid4())
        new_item = {
            "id":            item_id,
            "source":        "is04",
            "label":         req.label,
            "description":   req.label,
            "resource_type": req.resource_type,
            "resource_id":   req.resource_id,
            "resource_data": req.resource_data,
            "created_at":    datetime.now().isoformat()
        }

        db["materials"][req.material_type].append(
            new_item)
        save_db(db)

        logger.info(
            f"IS-04素材登録: [{req.material_type}]"
            f"[{req.resource_type}] "
            f"{req.label} ({req.resource_id})"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{req.label}」を登録しました",
            "item":    new_item
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"素材登録エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"素材登録エラー: {e}"
        )

# ==========================================
# 【0-3】GUI①用 素材ラベル・タイプ変更
# PUT /api/materials/gui1/{resource_id}
# ==========================================
class UpdateGui1Request(BaseModel):
    label:         str
    material_type: str

@router.put("/api/materials/gui1/{resource_id}")
async def update_material_gui1(
    resource_id: str,
    req:         UpdateGui1Request
):
    """
    GUI①用: resource_id でラベル・タイプを変更
    ① resource_id で全カテゴリ検索
    ② category + resource_type でラベル重複チェック
    ③ カテゴリが変わった場合は移動
    ④ ラベルを更新して保存
    """
    try:
        if req.material_type not in [
            "video", "audio", "ancillary"
        ]:
            raise HTTPException(
                status_code=400,
                detail="material_type が不正です"
            )

        db = load_db()

        # ① resource_id で全カテゴリ検索
        found_item     = None
        found_category = None

        for category in ["video", "audio", "ancillary"]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_id") \
                        == resource_id:
                    found_item     = item
                    found_category = category
                    break
            if found_item:
                break

        if not found_item:
            raise HTTPException(
                status_code=404,
                detail="素材が見つかりません"
            )

        resource_type = found_item.get(
            "resource_type", "sender")

        # ② category + resource_type で
        #    ラベル重複チェック（自分自身を除外）
        if check_label_duplicate(
            db,
            req.material_type,
            resource_type,
            req.label,
            exclude_id=found_item["id"]
        ):
            pane = get_pane_name(
                req.material_type, resource_type)
            raise HTTPException(
                status_code=409,
                detail=(
                    f"「{req.label}」は既に"
                    f"{pane}ペインに"
                    f"登録済みです。"
                    f"ラベルを変更してください。"
                )
            )

        # ③ カテゴリが変わった場合は移動
        if found_category != req.material_type:
            db["materials"][found_category] = [
                i for i in
                db["materials"][found_category]
                if i.get("resource_id") != resource_id
            ]
            found_item["label"] = req.label
            db["materials"][
                req.material_type
            ].append(found_item)
        else:
            found_item["label"] = req.label

        save_db(db)
        logger.info(
            f"GUI①素材更新: "
            f"{req.label} ({resource_id})"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{req.label}」を更新しました"
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"GUI①素材更新エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"素材更新エラー: {e}"
        )

# ==========================================
# 【0-4】GUI①用 素材削除
# DELETE /api/materials/delete/
#        {resource_type}/{resource_id}
# ==========================================
@router.delete(
    "/api/materials/delete/"
    "{resource_type}/{resource_id}"
)
async def delete_material_by_resource_id(
    resource_type: str,
    resource_id:   str
):
    """
    GUI①用: resource_id で素材を削除する
    source:"sdp"  → SDPファイルも削除
    source:"is04" → database.jsonのみ削除
    """
    try:
        db = load_db()

        found_item     = None
        found_category = None

        for category in ["video", "audio", "ancillary"]:
            for item in db["materials"].get(
                category, []
            ):
                if item.get("resource_id") \
                        == resource_id:
                    found_item     = item
                    found_category = category
                    break
            if found_item:
                break

        if not found_item:
            raise HTTPException(
                status_code=404,
                detail="素材が見つかりません"
            )

        # database.json から削除
        db["materials"][found_category] = [
            i for i in
            db["materials"][found_category]
            if i.get("resource_id") != resource_id
        ]
        save_db(db)

        # source:"sdp" の場合はSDPファイルも削除
        if found_item.get("source", "sdp") == "sdp":
            try:
                sdp_dir  = get_sdp_dir()
                sdp_path = sdp_dir / found_item.get(
                    "sdp_file", "")
                if sdp_path.exists():
                    sdp_path.unlink()
                    logger.info(
                        f"SDPファイル削除: "
                        f"{found_item.get('sdp_file')}"
                    )
            except Exception as e:
                logger.warning(
                    f"SDPファイル削除失敗: {e}"
                )

        logger.info(
            f"GUI①素材削除: [{found_category}] "
            f"{found_item['label']} ({resource_id})"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": (
                f"「{found_item['label']}」"
                f"を削除しました"
            )
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"GUI①素材削除エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"素材削除エラー: {e}"
        )

# ==========================================
# 【1】素材一覧取得（system_gui用）
# ==========================================
@router.get("/api/materials")
async def get_materials():
    """
    全カテゴリの素材一覧を返す（system_gui用）
    """
    try:
        db = load_db()
        return JSONResponse(
            content=db.get("materials", {
                "video":     [],
                "audio":     [],
                "ancillary": []
            })
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"素材一覧取得エラー: {e}"
        )

# ==========================================
# 【2】SDPファイル登録（system_gui用）
# ==========================================
class RegisterSDPRequest(BaseModel):
    label:         str
    description:   str
    category:      str  # "video"|"audio"|"ancillary"
    sdp_content:   str
    original_name: str

@router.post("/api/materials/sdp")
async def register_sdp(req: RegisterSDPRequest):
    """
    SDPファイルを登録する
    ① category + resource_type:"sender" で
      ラベル重複チェック
    ② ファイル保存（元ファイル名_UUID.sdp）
    ③ database.json に追記
    """
    try:
        if req.category not in [
            "video", "audio", "ancillary"
        ]:
            raise HTTPException(
                status_code=400,
                detail="カテゴリが不正です"
            )

        db = load_db()

        # ① ラベル重複チェック
        #    SDP素材は常に sender
        if check_label_duplicate(
            db, req.category, "sender", req.label
        ):
            pane = get_pane_name(req.category, "sender")
            raise HTTPException(
                status_code=409,
                detail=(
                    f"「{req.label}」は既に"
                    f"{pane}ペインに"
                    f"登録済みです。"
                    f"ラベルを変更してください。"
                )
            )

        # Description が空の場合は label と同じ
        description = req.description.strip() \
            if req.description.strip() \
            else req.label

        # ② ファイル保存
        sdp_dir   = get_sdp_dir()
        item_id   = str(uuid.uuid4())
        orig_stem = Path(req.original_name).stem
        sdp_file  = f"{orig_stem}_{item_id}.sdp"
        sdp_path  = sdp_dir / sdp_file

        with open(
            sdp_path, "w", encoding="utf-8"
        ) as f:
            f.write(req.sdp_content)

        # ③ database.json に追記
        new_item = {
            "id":                item_id,
            "source":            "sdp",
            "label":             req.label,
            "description":       description,
            "resource_type":     "sender",
            "resource_id":       item_id,
            "sdp_file":          sdp_file,
            "sdp_original_name": req.original_name,
            "sdp_content":       req.sdp_content,
            "created_at":        datetime.now().isoformat()
        }

        if "materials" not in db:
            db["materials"] = {
                "video":     [],
                "audio":     [],
                "ancillary": []
            }

        db["materials"][req.category].append(new_item)
        save_db(db)

        logger.info(
            f"SDP登録: [{req.category}][sender] "
            f"{req.label} ({sdp_file})"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{req.label}」を登録しました",
            "item":    new_item
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"SDP登録エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"SDP登録エラー: {e}"
        )

# ==========================================
# 【3】ラベル・Description変更（system_gui用）
# ==========================================
class UpdateLabelRequest(BaseModel):
    label:       str
    description: str

@router.put("/api/materials/{category}/{item_id}")
async def update_material(
    category: str,
    item_id:  str,
    req:      UpdateLabelRequest
):
    """
    ラベルとDescriptionを変更する（system_gui用）
    category + resource_type でラベル重複チェック
    """
    try:
        if category not in [
            "video", "audio", "ancillary"
        ]:
            raise HTTPException(
                status_code=400,
                detail="カテゴリが不正です"
            )

        db = load_db()

        # 対象アイテムを先に検索して
        # resource_type を取得
        items  = db["materials"].get(category, [])
        target = None
        for item in items:
            if item["id"] == item_id:
                target = item
                break

        if not target:
            raise HTTPException(
                status_code=404,
                detail="素材が見つかりません"
            )

        resource_type = target.get(
            "resource_type", "sender")

        # ラベル重複チェック（自分自身を除外）
        if check_label_duplicate(
            db,
            category,
            resource_type,
            req.label,
            exclude_id=item_id
        ):
            pane = get_pane_name(category, resource_type)
            raise HTTPException(
                status_code=409,
                detail=(
                    f"「{req.label}」は既に"
                    f"{pane}ペインに"
                    f"登録済みです。"
                    f"ラベルを変更してください。"
                )
            )

        # Description が空の場合は label と同じ
        description = req.description.strip() \
            if req.description.strip() \
            else req.label

        target["label"]       = req.label
        target["description"] = description

        save_db(db)
        logger.info(
            f"素材更新: [{category}][{resource_type}] "
            f"{req.label} ({item_id})"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": f"「{req.label}」を更新しました",
            "item":    target
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"素材更新エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"素材更新エラー: {e}"
        )

# ==========================================
# 【4】素材削除（system_gui用）
# ==========================================
@router.delete(
    "/api/materials/{category}/{item_id}"
)
async def delete_material(
    category: str,
    item_id:  str
):
    """
    素材を削除する（system_gui用）
    ① database.json から削除
    ② source:"sdp" のみ SDPファイルを削除
    """
    try:
        if category not in [
            "video", "audio", "ancillary"
        ]:
            raise HTTPException(
                status_code=400,
                detail="カテゴリが不正です"
            )

        db    = load_db()
        items = db["materials"].get(category, [])

        target = None
        for item in items:
            if item["id"] == item_id:
                target = item
                break

        if not target:
            raise HTTPException(
                status_code=404,
                detail="素材が見つかりません"
            )

        # ① database.json から削除
        db["materials"][category] = [
            i for i in items
            if i["id"] != item_id
        ]
        save_db(db)

        # ② source:"sdp" のみSDPファイルを削除
        if target.get("source", "sdp") == "sdp":
            sdp_dir  = get_sdp_dir()
            sdp_path = sdp_dir / target.get(
                "sdp_file", "")
            if sdp_path.exists():
                sdp_path.unlink()
                logger.info(
                    f"SDPファイル削除: "
                    f"{target.get('sdp_file')}"
                )

        logger.info(
            f"素材削除: [{category}] "
            f"{target['label']} ({item_id})"
        )

        return JSONResponse(content={
            "status":  "ok",
            "message": (
                f"「{target['label']}」を削除しました"
            )
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"素材削除エラー: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"素材削除エラー: {e}"
        )

# ==========================================
# 【5】SDPファイルダウンロード
# ==========================================
@router.get(
    "/api/materials/{category}/{item_id}/sdp"
)
async def download_sdp(
    category: str,
    item_id:  str
):
    """
    SDPファイルをダウンロードする
    """
    try:
        db    = load_db()
        items = db["materials"].get(category, [])

        target = None
        for item in items:
            if item["id"] == item_id:
                target = item
                break

        if not target:
            raise HTTPException(
                status_code=404,
                detail="素材が見つかりません"
            )

        sdp_dir  = get_sdp_dir()
        sdp_path = sdp_dir / target.get(
            "sdp_file", "")

        if not sdp_path.exists():
            raise HTTPException(
                status_code=404,
                detail="SDPファイルが見つかりません"
            )

        return FileResponse(
            path=str(sdp_path),
            filename=target.get(
                "sdp_original_name", "download.sdp"),
            media_type="application/sdp"
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"ダウンロードエラー: {e}"
        )