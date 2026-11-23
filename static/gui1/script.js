// script.js - Control画面 メインコントローラー（行レイアウト版）

// ==========================================
// 状態管理
// ==========================================
let nmosData = { senders: {}, receivers: {} };
let rdsConnected = false;

// 素材リスト（paneKey別・2次元配列）
// sourceMaterials.video1 = [[m1,m2],[m3]] ← 行ごと
let sourceMaterials = {
    video1:    [],
    video2:    [],
    audio1:    [],
    audio2:    [],
    ancillary: []
};
let destMaterials = {
    video1:    [],
    video2:    [],
    audio1:    [],
    audio2:    [],
    ancillary: []
};

// フォーマット表示フラグ
let fmtVisible = {
    video1:    true,
    video2:    false,
    audio1:    true,
    audio2:    false,
    ancillary: false
};

let selectedSource = null;
let selectedDest   = null;
let connectionMap  = {};

// ショートカット関連
let shortcutEnabled  = false;
let triggerShortcuts = [];

// コンテキストメニュー・モーダル
let contextTarget = null;
let editTarget    = null;
let deleteTarget  = null;

// カードサイズ
let currentCardSize = 'medium';

// SortableJSインスタンス管理
let sortableInstances = {};

// 操作モード
//   'take'   : Source/Destを選択後、TAKEボタンで実行（従来動作）
//   'direct' : Source/Destの両方が揃った時点で即実行
// 安全のため記憶せず、画面を開くたびにTAKEモードから始める
let operationMode = 'take';
let directBusy    = false;   // Directモードで実行中（この間の選択操作は無視）

// Directモードの実行直後は一定時間クリックを受け付けない
// （ダブルクリック等で同じ切替が二重に送られるのを防ぐ。
//   Windowsのダブルクリック判定時間の標準値に合わせて0.5秒）
const DIRECT_COOLDOWN_MS = 500;
let directCooldownUntil  = 0;

// ドラッグ直後のclickを無視するためのガード
// （Directモードで並べ替えのドラッグが誤ってTAKEにならないように）
let isDraggingCard  = false;
let lastDragEndAt   = 0;
const DRAG_CLICK_GUARD_MS = 400;

// ==========================================
// ペイン定義
// ==========================================
const PANE_DEFS = [
    {
        key: 'video1', label: 'VIDEO 1',
        cls: 'video1', badgeCls: 'badge-video1',
        badgeText: 'V1', category: 'video'
    },
    {
        key: 'video2', label: 'VIDEO 2',
        cls: 'video2', badgeCls: 'badge-video2',
        badgeText: 'V2', category: 'video'
    },
    {
        key: 'audio1', label: 'AUDIO 1',
        cls: 'audio1', badgeCls: 'badge-audio1',
        badgeText: 'A1', category: 'audio'
    },
    {
        key: 'audio2', label: 'AUDIO 2',
        cls: 'audio2', badgeCls: 'badge-audio2',
        badgeText: 'A2', category: 'audio'
    },
    {
        key: 'ancillary', label: 'ANCILLARY',
        cls: 'ancillary', badgeCls: 'badge-ancillary',
        badgeText: 'ANC', category: 'ancillary'
    }
];

// ==========================================
// 初期化
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    loadCardSize();
    await loadMaterials();
    await loadTriggerShortcuts();
    connectWebSocket();
    setupKeyboard();
    setupContextMenuClose();
    setupDragGuard();
    setupPaneBlankClick();
    updateFmtButtons();
    updateModeUI();
    renderAll();
    updateTakeButton();
    updateLeaveButton();
});

// ==========================================
// カードサイズ
// ==========================================
function loadCardSize() {
    const saved = localStorage.getItem('gui1_card_size') || 'medium';
    applyCardSize(saved);
}

function setCardSize(size) {
    applyCardSize(size);
    localStorage.setItem('gui1_card_size', size);
}

function applyCardSize(size) {
    currentCardSize = size;
    document.body.classList.remove('size-large', 'size-medium', 'size-small');
    if (size === 'large') document.body.classList.add('size-large');
    if (size === 'small') document.body.classList.add('size-small');
    ['large', 'medium', 'small'].forEach(s => {
        document.getElementById(`size-${s}`)
            ?.classList.toggle('active', s === size);
    });
}

// ==========================================
// 素材読み込み
// ==========================================
async function loadMaterials() {
    try {
        const resp = await fetch('/api/materials/list');
        if (!resp.ok) return;
        const data = await resp.json();
        const allSenders   = Object.values(data.senders   || {});
        const allReceivers = Object.values(data.receivers || {});
        await loadLayout(allSenders, allReceivers);
    } catch (e) {
        console.error('素材読み込みエラー:', e);
    }
}

// ==========================================
// ユーティリティ：フラット⇔2次元変換
// ==========================================

// フラット配列を2次元配列に変換（1行1要素として初期化）
function flatTo2D(arr) {
    return arr.map(m => [m]);
}

// 2次元配列をフラット配列に変換
function flattenRows(rows) {
    return rows.flat();
}

// IDリストの2次元配列からマテリアルの2次元配列を復元
function idsTo2DRows(ids2d, materialMap) {
    const result = [];
    for (const row of ids2d) {
        const rowItems = [];
        for (const id of row) {
            if (materialMap[id]) rowItems.push(materialMap[id]);
        }
        if (rowItems.length > 0) result.push(rowItems);
    }
    return result;
}

// ==========================================
// レイアウト保存・読み込み
// ==========================================
async function loadLayout(allSenders, allReceivers) {
    try {
        const resp = await fetch('/api/layout/gui1');
        if (!resp.ok) {
            distributeDefault(allSenders, allReceivers);
            return;
        }
        const layout = await resp.json();

        // 新形式チェック：source が object かつ video1 が 2次元配列
        if (
            layout.source &&
            !Array.isArray(layout.source) &&
            Array.isArray(layout.source.video1) &&
            (layout.source.video1.length === 0 ||
             Array.isArray(layout.source.video1[0]))
        ) {
            distributeByLayout(allSenders, allReceivers, layout);
        } else {
            distributeDefault(allSenders, allReceivers);
        }
    } catch (e) {
        console.error('レイアウト読み込みエラー:', e);
        distributeDefault(allSenders, allReceivers);
    }
}

// デフォルト振り分け（各素材を1行1列で配置）
function distributeDefault(allSenders, allReceivers) {
    resetMaterials();

    allSenders.forEach(m => {
        const cat = m.material_type || '';
        if (cat === 'video')
            sourceMaterials.video1.push([m]);
        else if (cat === 'audio')
            sourceMaterials.audio1.push([m]);
        else
            sourceMaterials.ancillary.push([m]);
    });

    allReceivers.forEach(m => {
        const cat = m.material_type || '';
        if (cat === 'video')
            destMaterials.video1.push([m]);
        else if (cat === 'audio')
            destMaterials.audio1.push([m]);
        else
            destMaterials.ancillary.push([m]);
    });
}

// レイアウトに従って振り分け（2次元配列形式）
function distributeByLayout(allSenders, allReceivers, layout) {
    resetMaterials();

    const senderMap   = {};
    const receiverMap = {};
    allSenders.forEach(m   => { senderMap[m.resource_id]   = m; });
    allReceivers.forEach(m => { receiverMap[m.resource_id] = m; });

    const paneKeys = ['video1','video2','audio1','audio2','ancillary'];

    // Source
    paneKeys.forEach(key => {
        const rows = layout.source?.[key] || [];
        sourceMaterials[key] = idsTo2DRows(rows, senderMap);
        // 使用済みを削除
        rows.flat().forEach(id => delete senderMap[id]);
    });
    // 未割り当てsenderを末尾に追加
    Object.values(senderMap).forEach(m => {
        const cat = m.material_type || '';
        if (cat === 'video')      sourceMaterials.video1.push([m]);
        else if (cat === 'audio') sourceMaterials.audio1.push([m]);
        else                      sourceMaterials.ancillary.push([m]);
    });

    // Dest
    paneKeys.forEach(key => {
        const rows = layout.dest?.[key] || [];
        destMaterials[key] = idsTo2DRows(rows, receiverMap);
        rows.flat().forEach(id => delete receiverMap[id]);
    });
    Object.values(receiverMap).forEach(m => {
        const cat = m.material_type || '';
        if (cat === 'video')      destMaterials.video1.push([m]);
        else if (cat === 'audio') destMaterials.audio1.push([m]);
        else                      destMaterials.ancillary.push([m]);
    });
}

function resetMaterials() {
    sourceMaterials = { video1:[], video2:[], audio1:[], audio2:[], ancillary:[] };
    destMaterials   = { video1:[], video2:[], audio1:[], audio2:[], ancillary:[] };
}

async function saveLayout() {
    try {
        // 2次元配列のままIDに変換して保存
        const to2DIds = (rows2d) =>
            rows2d.map(row => row.map(m => m.resource_id));

        const layout = {
            source: {
                video1:    to2DIds(sourceMaterials.video1),
                video2:    to2DIds(sourceMaterials.video2),
                audio1:    to2DIds(sourceMaterials.audio1),
                audio2:    to2DIds(sourceMaterials.audio2),
                ancillary: to2DIds(sourceMaterials.ancillary)
            },
            dest: {
                video1:    to2DIds(destMaterials.video1),
                video2:    to2DIds(destMaterials.video2),
                audio1:    to2DIds(destMaterials.audio1),
                audio2:    to2DIds(destMaterials.audio2),
                ancillary: to2DIds(destMaterials.ancillary)
            }
        };
        await fetch('/api/layout/gui1', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(layout)
        });
    } catch (e) {
        console.error('レイアウト保存エラー:', e);
    }
}

// ==========================================
// WebSocket
// ==========================================
function connectWebSocket() {
    const ws = new WebSocket(`ws://${location.host}/ws/gui`);
    ws.onopen    = () => updateStatusLed(true);
    ws.onclose   = () => {
        updateStatusLed(false);
        setTimeout(connectWebSocket, 3000);
    };
    ws.onmessage = (e) => {
        try { handleMessage(JSON.parse(e.data)); }
        catch (err) { console.error(err); }
    };
}

function handleMessage(msg) {
    if (msg.type === 'is04_status')    handleStatusUpdate(msg.data);
    else if (msg.type === 'nmos_data') handleNmosData(msg.data);
    else if (msg.type === 'connection_map') handleConnectionMap(msg.data);
}

function handleStatusUpdate(status) {
    rdsConnected = status.connected;
    updateStatusLed(status.connected);
    const text = document.getElementById('status-text');
    text.textContent = status.connected
        ? `RDS接続中: ${status.rds_url}`
        : `切断: ${status.error || '不明なエラー'}`;
    renderAll();
}

function handleNmosData(data) {
    nmosData.senders   = data.senders   || {};
    nmosData.receivers = data.receivers || {};
    renderAll();
}

function handleConnectionMap(data) {
    connectionMap = data || {};
    renderAll();
}

// ==========================================
// 状態判定
// ==========================================
function getOnlineStatus(material) {
    if (!rdsConnected) return 'rds-off';
    if ((material.source || 'sdp') === 'sdp') return 'online';
    const store = material.resource_type === 'sender'
        ? nmosData.senders : nmosData.receivers;
    return store[material.resource_id] ? 'online' : 'offline';
}

// ==========================================
// フィルター制御
// ==========================================
function toggleFmt(key) {
    fmtVisible[key] = !fmtVisible[key];
    updateFmtButtons();
    renderAll();
    setTimeout(initAllSortables, 50);
}

function updateFmtButtons() {
    const map = {
        video1: 'fmt-v1', video2: 'fmt-v2',
        audio1: 'fmt-a1', audio2: 'fmt-a2',
        ancillary: 'fmt-anc'
    };
    Object.entries(map).forEach(([key, id]) => {
        document.getElementById(id)
            ?.classList.toggle('active', fmtVisible[key]);
    });
}

// ==========================================
// ショートカット
// ==========================================
async function loadTriggerShortcuts() {
    try {
        const resp = await fetch('/api/shortcuts');
        if (!resp.ok) return;
        triggerShortcuts = await resp.json();
    } catch (e) {
        console.error('ショートカット読み込みエラー:', e);
        triggerShortcuts = [];
    }
}

async function onToggleShortcut() {
    shortcutEnabled = document.getElementById('toggle-shortcut').checked;
    if (shortcutEnabled) await loadTriggerShortcuts();
}

function setupKeyboard() {
    document.addEventListener('keydown', async (e) => {
        if (!shortcutEnabled) return;
        if (document.querySelector('.modal-overlay.active')) return;
        if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;

        const MODIFIER_KEYS = ['Control','Shift','Alt','Meta'];
        if (MODIFIER_KEYS.includes(e.key)) return;

        const parts = [];
        if (e.ctrlKey)  parts.push('Ctrl');
        if (e.altKey)   parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const keyMain = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        parts.push(keyMain);
        const keyName = parts.join('+');

        const hit = triggerShortcuts.find(s => s.key === keyName);
        if (hit) {
            e.preventDefault();
            await fireTriggerByShortcut(hit);
        }
    });
}

async function fireTriggerByShortcut(shortcut) {
    try {
        await fetch(`/api/trigger/${shortcut.number}`, { method: 'POST' });
    } catch (e) {
        console.error(`[Shortcut] 通信エラー: ${e.message}`);
    }
}

// ==========================================
// 選択
// ==========================================
// Directモードで実行中・実行直後は選択操作を受け付けない
function isDirectLocked() {
    if (operationMode !== 'direct') return false;
    return directBusy || Date.now() < directCooldownUntil;
}

function selectSource(material, paneKey) {
    if (isDirectLocked()) return;
    if (selectedSource &&
        selectedSource.material.resource_id === material.resource_id) {
        selectedSource = null;
    } else {
        selectedSource = { material, paneKey };
    }
    renderAll();
    updateTakeButton();
    maybeExecuteDirect();
}

function selectDest(material, paneKey) {
    if (isDirectLocked()) return;
    if (selectedDest &&
        selectedDest.material.resource_id === material.resource_id) {
        selectedDest = null;
    } else {
        selectedDest = { material, paneKey };
    }
    renderAll();
    updateTakeButton();
    updateLeaveButton();
    maybeExecuteDirect();
}

function clearSelection() {
    selectedSource = null;
    selectedDest   = null;
    updateTakeButton();
    updateLeaveButton();
    renderAll();
}

// ==========================================
// 操作モード（TAKE / Direct）
// ==========================================
function setOperationMode(mode) {
    if (mode !== 'take' && mode !== 'direct') return;
    if (mode === operationMode || directBusy) return;
    operationMode = mode;
    // モード切替時は選択を解除する
    // （TAKEモードで両方選択済みのままDirectへ切り替えても即実行しない）
    updateModeUI();
    clearSelection();
}

function updateModeUI() {
    const isDirect = operationMode === 'direct';
    document.getElementById('mode-take')
        ?.classList.toggle('active', !isDirect);
    document.getElementById('mode-direct')
        ?.classList.toggle('active', isDirect);
    document.getElementById('mode-indicator')
        ?.classList.toggle('direct', isDirect);
    const name = document.getElementById('mode-name');
    if (name) name.textContent = isDirect ? 'Direct' : 'TAKE';
}

// Directモード：Source/Destが揃った時点で即実行
function maybeExecuteDirect() {
    if (operationMode !== 'direct' || directBusy) return;
    if (!selectedSource || !selectedDest) return;
    executeDirectTake();
}

async function executeDirectTake() {
    const srcId = selectedSource.material.resource_id;
    const dstId = selectedDest.material.resource_id;
    directBusy = true;
    document.body.classList.add('direct-busy');
    try {
        await requestTake(srcId, dstId);
    } finally {
        directBusy = false;
        directCooldownUntil = Date.now() + DIRECT_COOLDOWN_MS;
        document.body.classList.remove('direct-busy');
        // Destは選択したまま、Sourceのみ解除
        // （同じDestに対してSourceを1クリックで次々切り替えられる）
        selectedSource = null;
        updateTakeButton();
        updateLeaveButton();
        renderAll();
    }
}

// Directモード：選択中のDest以外の空欄部クリックで選択解除
function setupPaneBlankClick() {
    ['pane-source', 'pane-dest'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            if (operationMode !== 'direct' || isDirectLocked()) return;
            if (e.target.closest('.material-card')) return;
            if (isDragClick()) return;
            if (!selectedSource && !selectedDest) return;
            clearSelection();
        });
    });
}

// ==========================================
// ドラッグ直後のclick抑止
// ==========================================
function onCardDragStart() {
    isDraggingCard = true;
}

function onCardDragEnd() {
    if (!isDraggingCard) return;
    isDraggingCard = false;
    lastDragEndAt  = Date.now();
}

function isDragClick() {
    return isDraggingCard ||
        (Date.now() - lastDragEndAt) < DRAG_CLICK_GUARD_MS;
}

function setupDragGuard() {
    // SortableのonEndが呼ばれないケース（ドラッグ中の再描画で
    // インスタンスが破棄された等）でもフラグが残らないよう、
    // ドキュメント全体のドラッグ終了・ポインタ解放でも解除する
    ['dragend', 'drop', 'mouseup', 'pointerup', 'touchend']
        .forEach(type => {
            document.addEventListener(type, onCardDragEnd, true);
        });
}

// ==========================================
// TAKE / LEAVE
// ==========================================
function updateTakeButton() {
    const btn = document.getElementById('btn-take');
    if (!btn) return;
    const isDirect = operationMode === 'direct';
    btn.classList.toggle('ready',
        !isDirect && !!(selectedSource && selectedDest));
    // Directモード中はTAKEボタンを押せない（グレー表示）
    btn.classList.toggle('direct-disabled', isDirect);
    btn.disabled = isDirect;
}

async function requestTake(srcId, dstId) {
    try {
        const resp = await fetch('/api/connection/take', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                source_resource_id: srcId,
                dest_resource_id:   dstId
            })
        });
        if (!resp.ok) {
            const result = await resp.json();
            console.error('[TAKE] エラー:', result.detail);
        }
    } catch (e) {
        console.error('[TAKE] 通信エラー:', e);
    }
}

async function onTake() {
    if (operationMode !== 'take') return;
    if (!selectedSource || !selectedDest) return;
    const srcId = selectedSource.material.resource_id;
    const dstId = selectedDest.material.resource_id;
    const btn = document.getElementById('btn-take');
    if (btn) btn.disabled = true;
    try {
        await requestTake(srcId, dstId);
    } finally {
        selectedSource = null;
        selectedDest   = null;
        updateTakeButton();   // disabled状態もここで復帰
        updateLeaveButton();
        renderAll();
    }
}

function updateLeaveButton() {
    document.getElementById('btn-leave')
        ?.classList.toggle('ready', !!selectedDest);
}

async function onLeave() {
    if (!selectedDest) return;
    const dstId = selectedDest.material.resource_id;
    const btn = document.getElementById('btn-leave');
    if (btn) btn.disabled = true;
    try {
        const resp = await fetch('/api/connection/leave', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ dest_resource_id: dstId })
        });
        if (!resp.ok) {
            const result = await resp.json();
            console.error('[LEAVE] エラー:', result.detail);
        }
    } catch (e) {
        console.error('[LEAVE] 通信エラー:', e);
    } finally {
        if (btn) btn.disabled = false;
        selectedDest = null;
        updateTakeButton();
        updateLeaveButton();
        renderAll();
    }
}

// ==========================================
// ステータスLED
// ==========================================
function updateStatusLed(connected) {
    const led  = document.getElementById('status-led');
    const text = document.getElementById('status-text');
    led.className = connected ? 'status-led connected' : 'status-led disconnected';
    if (!connected) text.textContent = 'RDS切断';
}

// ==========================================
// 描画（メイン）
// ==========================================
function renderAll() {
    renderPane('source');
    renderPane('dest');
}

function renderPane(pane) {
    const materials = pane === 'source' ? sourceMaterials : destMaterials;
    const container = document.getElementById(
        pane === 'source' ? 'source-sub-panes' : 'dest-sub-panes'
    );
    if (!container) return;

    const visibleKeys = PANE_DEFS.filter(d => fmtVisible[d.key]);

    if (visibleKeys.length === 0) {
        container.innerHTML = `<div class="empty-message">フィルターを選択してください</div>`;
        return;
    }

    destroySortablesForPane(pane);
    container.innerHTML = '';

    visibleKeys.forEach(def => {
        const rows = materials[def.key] || [];  // 2次元配列
        const totalCount = flattenRows(rows).length;

        const subPane = document.createElement('div');
        subPane.className = `sub-pane ${def.key}`;
        subPane.id = `sub-pane-${pane}-${def.key}`;

        // ヘッダー
        const labelEl = document.createElement('div');
        labelEl.className = `sub-pane-label ${def.cls}`;
        labelEl.innerHTML = `
            ${def.label}
            <span class="sub-pane-label-count">(${totalCount})</span>`;
        subPane.appendChild(labelEl);

        // グリッドエリア
        const gridArea = document.createElement('div');
        gridArea.className = 'material-grid-area';
        gridArea.id = `grid-area-${pane}-${def.key}`;

        if (totalCount === 0) {
            // 空のとき：ドロップゾーンのみ
            const dropZone = buildDropZone(pane, def.key, 0);
            gridArea.appendChild(dropZone);
        } else {
            // 各行を描画
            rows.forEach((rowItems, rowIdx) => {
                const rowEl = buildRowElement(
                    rowItems, rowIdx, pane, def.key);
                gridArea.appendChild(rowEl);
            });
            // 最終行の下にドロップゾーン
            const dropZone = buildDropZone(pane, def.key, rows.length);
            gridArea.appendChild(dropZone);
        }

        subPane.appendChild(gridArea);
        container.appendChild(subPane);
    });

    // V2/A2 OFFゴーストヘッダー
    renderGhostHeaders(pane, container, materials);

    // SortableJS初期化
    setTimeout(() => initSortablesForPane(pane), 0);
}

// ==========================================
// 行DOM生成
// ==========================================
function buildRowElement(rowItems, rowIdx, pane, paneKey) {
    const rowEl = document.createElement('div');
    rowEl.className = 'material-row';
    rowEl.id = `row-${pane}-${paneKey}-${rowIdx}`;
    rowEl.dataset.pane    = pane;
    rowEl.dataset.paneKey = paneKey;
    rowEl.dataset.rowIdx  = rowIdx;

    rowItems.forEach((m, cardIdx) => {
        const card = buildCard(m, cardIdx, pane, paneKey, rowIdx);
        rowEl.appendChild(card);
    });

    return rowEl;
}

// ==========================================
// ドロップゾーン生成（新規行作成用）
// ==========================================
function buildDropZone(pane, paneKey, newRowIdx) {
    const dz = document.createElement('div');
    dz.className = 'row-drop-zone';
    dz.id = `dropzone-${pane}-${paneKey}-${newRowIdx}`;
    dz.dataset.pane      = pane;
    dz.dataset.paneKey   = paneKey;
    dz.dataset.newRowIdx = newRowIdx;
    dz.innerHTML = `<span class="drop-zone-hint"></span>`;
    return dz;
}

// ==========================================
// V2/A2 OFFゴーストヘッダー
// ==========================================
function renderGhostHeaders(pane, container, materials) {
    const v2count = flattenRows(materials.video2 || []).length;
    const a2count = flattenRows(materials.audio2 || []).length;

    if (!fmtVisible.video2 && fmtVisible.video1 && v2count > 0) {
        const ghost = document.createElement('div');
        ghost.className = 'sub-pane-ghost video2';
        ghost.textContent = `VIDEO 2 (${v2count})`;
        container.appendChild(ghost);
    }
    if (!fmtVisible.audio2 && fmtVisible.audio1 && a2count > 0) {
        const ghost = document.createElement('div');
        ghost.className = 'sub-pane-ghost audio2';
        ghost.textContent = `AUDIO 2 (${a2count})`;
        container.appendChild(ghost);
    }
}

// ==========================================
// カードDOM生成
// ==========================================
function buildCard(m, cardIdx, pane, paneKey, rowIdx) {
    const status = getOnlineStatus(m);
    const def = PANE_DEFS.find(d => d.key === paneKey);

    const card = document.createElement('div');
    card.className = 'material-card';
    card.dataset.resourceId = m.resource_id;
    card.dataset.pane       = pane;
    card.dataset.paneKey    = paneKey;
    card.dataset.rowIdx     = rowIdx;

    // 選択状態
    if (pane === 'source' && selectedSource &&
        selectedSource.material.resource_id === m.resource_id)
        card.classList.add('selected-source');
    if (pane === 'dest' && selectedDest &&
        selectedDest.material.resource_id === m.resource_id)
        card.classList.add('selected-dest');

    if (status === 'offline')  card.classList.add('offline');
    if (status === 'rds-off')  card.classList.add('rds-disconnected');

    if (pane === 'dest') {
        const conn = connectionMap[m.resource_id];
        if (conn?.status === 'error') card.classList.add('conn-error');
    }

    const badge = def
        ? `<div class="format-badge ${def.badgeCls}">${def.badgeText}</div>`
        : '';

    let connHtml = '';
    if (pane === 'dest') {
        const conn = connectionMap[m.resource_id];
        if (conn?.status === 'connected' && conn.sender_label) {
            connHtml = `<div class="card-conn connected">${escapeHtml(conn.sender_label)}</div>`;
        } else if (conn?.status === 'error') {
            connHtml = `<div class="card-conn error">⚠ Error ${escapeHtml(String(conn.error_code || '???'))}</div>`;
        } else {
            connHtml = `<div class="card-conn empty">———</div>`;
        }
    }

    const dotCls = status === 'online'  ? 'online'  :
                   status === 'rds-off' ? 'rds-off' : 'offline';
    const stText = status === 'online'  ? 'Online'  :
                   status === 'rds-off' ? 'RDS切断' : 'Offline';

    card.innerHTML = `
        <div class="card-top">${badge}</div>
        <div class="card-label">${escapeHtml(m.label)}</div>
        <div class="card-bottom">
            ${connHtml}
            <div class="card-status">
                <span class="online-dot ${dotCls}"></span>
                <span class="card-status-text ${dotCls}">${stText}</span>
            </div>
        </div>`;

    card.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        // 並べ替えドラッグ直後のclickは選択/TAKEとして扱わない
        if (isDragClick()) return;
        closeContextMenu();
        if (pane === 'source') selectSource(m, paneKey);
        else                   selectDest(m, paneKey);
    });

    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextTarget = { pane, material: m, paneKey };
        const menu = document.getElementById('context-menu');
        menu.style.display = 'block';
        menu.style.left = `${e.clientX}px`;
        menu.style.top  = `${e.clientY}px`;
    });

    return card;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==========================================
// SortableJS 初期化
// ==========================================

function getRowGroupName(pane, paneKey) {
    // 行内カード移動のグループ（pane+paneKey単位）
    if (pane === 'source') {
        if (paneKey === 'video1' || paneKey === 'video2') return 'source-video-row';
        if (paneKey === 'audio1' || paneKey === 'audio2') return 'source-audio-row';
    } else {
        if (paneKey === 'video1' || paneKey === 'video2') return 'dest-video-row';
        if (paneKey === 'audio1' || paneKey === 'audio2') return 'dest-audio-row';
    }
    return `${pane}-${paneKey}-row`;
}

function destroySortablesForPane(pane) {
    const prefix = `${pane}-`;
    Object.keys(sortableInstances).forEach(key => {
        if (key.startsWith(prefix)) {
            sortableInstances[key].destroy();
            delete sortableInstances[key];
        }
    });
}

function initSortablesForPane(pane) {
    const materials = pane === 'source' ? sourceMaterials : destMaterials;
    const paneKeys = ['video1','video2','audio1','audio2','ancillary'];

    paneKeys.forEach(paneKey => {
        const rows = materials[paneKey] || [];
        const rowGroupName = getRowGroupName(pane, paneKey);

        // 各行のSortable（カード横移動）
        rows.forEach((_, rowIdx) => {
            const rowEl = document.getElementById(
                `row-${pane}-${paneKey}-${rowIdx}`);
            if (!rowEl) return;

            const instKey = `${pane}-${paneKey}-row-${rowIdx}`;
            const instance = Sortable.create(rowEl, {
                group: {
                    name: rowGroupName,
                    pull: true,
                    put:  true
                },
                animation:  150,
                ghostClass: 'sortable-ghost',
                dragClass:  'sortable-drag',
                onStart: onCardDragStart,
                onEnd: (evt) => {
                    onCardDragEnd();
                    onRowSortableEnd(evt, pane, paneKey, rowIdx);
                }
            });
            sortableInstances[instKey] = instance;
        });

        // ドロップゾーンのSortable（新規行作成）
        const dropZone = document.getElementById(
            `dropzone-${pane}-${paneKey}-${rows.length}`);
        if (dropZone) {
            const dzKey = `${pane}-${paneKey}-dropzone`;
            const dzInstance = Sortable.create(dropZone, {
                group: {
                    name: rowGroupName,
                    pull: false,
                    put:  true
                },
                animation:  150,
                ghostClass: 'sortable-ghost',
                filter:     '.drop-zone-hint',
                onAdd: (evt) => onDropZoneAdd(evt, pane, paneKey, rows.length)
            });
            sortableInstances[dzKey] = dzInstance;
        }
    });
}

function initAllSortables() {
    initSortablesForPane('source');
    initSortablesForPane('dest');
}

// ==========================================
// SortableJS イベント処理
// ==========================================

// 行内・行間のカード移動
function onRowSortableEnd(evt, fromPane, fromPaneKey, fromRowIdx) {
    const toEl  = evt.to;
    const toId  = toEl.id;

    // ドロップゾーンへのドロップはonDropZoneAddで処理
    if (toId && toId.startsWith('dropzone-')) return;

    // toのrow情報を取得
    const toMatch = toId.match(/^row-(source|dest)-(.+)-(\d+)$/);
    if (!toMatch) { renderAll(); setTimeout(initAllSortables, 50); return; }

    const toPane   = toMatch[1];
    const toPaneKey = toMatch[2];
    const toRowIdx  = parseInt(toMatch[3], 10);
    const oldIndex  = evt.oldIndex;
    const newIndex  = evt.newIndex;

    // Source↔Dest間の移動は禁止
    if (fromPane !== toPane) {
        renderAll(); setTimeout(initAllSortables, 50); return;
    }

    const materials = fromPane === 'source' ? sourceMaterials : destMaterials;

    if (fromPaneKey === toPaneKey && fromRowIdx === toRowIdx) {
        // 同一行内の並び替え
        const row = materials[fromPaneKey][fromRowIdx];
        const moved = row.splice(oldIndex, 1)[0];
        row.splice(newIndex, 0, moved);
    } else if (fromPaneKey === toPaneKey) {
        // 同一ペイン・異なる行間の移動
        const fromRow = materials[fromPaneKey][fromRowIdx];
        const toRow   = materials[toPaneKey][toRowIdx];
        const moved = fromRow.splice(oldIndex, 1)[0];
        if (!moved) { renderAll(); setTimeout(initAllSortables, 50); return; }
        toRow.splice(newIndex, 0, moved);

        // 空行を削除
        materials[fromPaneKey] = materials[fromPaneKey].filter(r => r.length > 0);
    } else {
        // V1↔V2 / A1↔A2 間の移動
        const fromRow = materials[fromPaneKey][fromRowIdx];
        const toRow   = materials[toPaneKey][toRowIdx];
        const moved = fromRow.splice(oldIndex, 1)[0];
        if (!moved) { renderAll(); setTimeout(initAllSortables, 50); return; }
        toRow.splice(newIndex, 0, moved);

        materials[fromPaneKey] = materials[fromPaneKey].filter(r => r.length > 0);
    }

    saveLayout();
    renderAll();
    setTimeout(initAllSortables, 50);
}

// ドロップゾーンへのドロップ（新規行作成）
function onDropZoneAdd(evt, pane, paneKey, newRowIdx) {
    const card = evt.item;
    const resourceId = card.dataset.resourceId;
    const fromPane   = card.dataset.pane;
    const fromPaneKey = card.dataset.paneKey;
    const fromRowIdx  = parseInt(card.dataset.rowIdx, 10);

    // Source↔Dest間の移動は禁止
    if (fromPane !== pane) {
        renderAll(); setTimeout(initAllSortables, 50); return;
    }

    const materials = pane === 'source' ? sourceMaterials : destMaterials;

    // 元の行から素材を取り出す
    const fromRow = materials[fromPaneKey][fromRowIdx];
    const movedIdx = fromRow.findIndex(m => m.resource_id === resourceId);
    if (movedIdx === -1) { renderAll(); setTimeout(initAllSortables, 50); return; }
    const moved = fromRow.splice(movedIdx, 1)[0];

    // 空行を削除
    materials[fromPaneKey] = materials[fromPaneKey].filter(r => r.length > 0);

    // 新規行として末尾に追加
    materials[paneKey].push([moved]);

    saveLayout();
    renderAll();
    setTimeout(initAllSortables, 50);
}

// ==========================================
// 右クリックメニュー
// ==========================================
function closeContextMenu() {
    const menu = document.getElementById('context-menu');
    if (menu) menu.style.display = 'none';
    contextTarget = null;
}

function setupContextMenuClose() {
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeContextMenu();
    });
}

function onContextEdit() {
    if (!contextTarget) return;
    openEditModal(contextTarget.pane, contextTarget.material, contextTarget.paneKey);
    closeContextMenu();
}

function onContextDelete() {
    if (!contextTarget) return;
    openDeleteModal(contextTarget.pane, contextTarget.material, contextTarget.paneKey);
    closeContextMenu();
}

// ==========================================
// 編集モーダル
// ==========================================
function openEditModal(pane, material, paneKey) {
    editTarget = { pane, material, paneKey };
    document.getElementById('edit-label').value = material.label || '';
    const radio = document.querySelector(
        `input[name="edit-type"][value="${material.material_type || 'video'}"]`);
    if (radio) radio.checked = true;
    clearEditError();
    document.getElementById('edit-modal').classList.add('active');
    document.getElementById('edit-label').focus();
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('active');
    clearEditError();
    editTarget = null;
}

function clearEditError() {
    const el = document.getElementById('edit-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
}

function showEditError(msg) {
    const el = document.getElementById('edit-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}

async function saveEdit() {
    if (!editTarget) return;
    const label = document.getElementById('edit-label').value.trim();
    if (!label) { showEditError('ラベルを入力してください'); return; }
    const type = document.querySelector('input[name="edit-type"]:checked').value;
    const m = editTarget.material;

    try {
        const resp = await fetch(`/api/materials/gui1/${m.resource_id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ label, material_type: type })
        });
        const result = await resp.json();
        if (!resp.ok) {
            showEditError(result.detail || '更新に失敗しました');
            return;
        }

        m.label         = label;
        m.material_type = type;

        updateMaterialCategory(
            editTarget.pane, editTarget.paneKey, m, type);

        closeEditModal();
        renderAll();
        setTimeout(initAllSortables, 50);
    } catch (e) {
        showEditError(`更新エラー: ${e.message}`);
    }
}

function updateMaterialCategory(pane, fromPaneKey, material, newType) {
    const materials = pane === 'source' ? sourceMaterials : destMaterials;

    const fromCategory =
        fromPaneKey.startsWith('video') ? 'video' :
        fromPaneKey.startsWith('audio') ? 'audio' : 'ancillary';
    const toCategory = newType;
    if (fromCategory === toCategory) return;

    // 元の行から削除（2次元配列対応）
    materials[fromPaneKey] = materials[fromPaneKey]
        .map(row => row.filter(m => m.resource_id !== material.resource_id))
        .filter(row => row.length > 0);

    // 新カテゴリの末尾に新行として追加
    const toKey =
        toCategory === 'video' ? 'video1' :
        toCategory === 'audio' ? 'audio1' : 'ancillary';
    materials[toKey].push([material]);

    saveLayout();
}

// ==========================================
// 削除モーダル
// ==========================================
function openDeleteModal(pane, material, paneKey) {
    deleteTarget = { pane, material, paneKey };
    document.getElementById('delete-confirm-text').textContent =
        `「${material.label}」を削除しますか？`;
    document.getElementById('delete-modal').classList.add('active');
}

function closeDeleteModal() {
    document.getElementById('delete-modal').classList.remove('active');
    deleteTarget = null;
}

async function confirmDelete() {
    if (!deleteTarget) return;
    const { pane, material, paneKey } = deleteTarget;
    const materials = pane === 'source' ? sourceMaterials : destMaterials;

    // 2次元配列から削除
    materials[paneKey] = materials[paneKey]
        .map(row => row.filter(m => m.resource_id !== material.resource_id))
        .filter(row => row.length > 0);

    if (pane === 'source' &&
        selectedSource?.material.resource_id === material.resource_id)
        selectedSource = null;
    if (pane === 'dest' &&
        selectedDest?.material.resource_id === material.resource_id)
        selectedDest = null;

    try {
        await fetch(
            `/api/materials/delete/${material.resource_type}/${material.resource_id}`,
            { method: 'DELETE' }
        );
    } catch (e) {
        console.error('削除エラー:', e);
    }

    closeDeleteModal();
    renderAll();
    setTimeout(initAllSortables, 50);
    updateTakeButton();
    updateLeaveButton();
    saveLayout();
}