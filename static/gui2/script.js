// ==========================================
// GUI② オペレータGUI
// ==========================================

// 状態
let panelData       = null;   // パネル設定
let connectionMap   = {};     // 接続状態
let selectedDestId  = null;   // 選択中Dest ID
let isLocked        = true;   // ロック状態
let ws              = null;   // WebSocket

// ロックスライダー
let slideStartX     = 0;
let slideThumbLeft  = 0;
let isSliding       = false;
const SLIDE_THRESHOLD = 150; // px

// ==========================================
// 初期化
// ==========================================
document.addEventListener(
    'DOMContentLoaded', async () => {
    const panelId = getPanelIdFromUrl();
    if (!panelId) {
        showError(
            'URLが正しくありません。\n'
            + '/panel/{panel_id} でアクセスしてください。'
        );
        return;
    }

    await loadPanel(panelId);
    initLock();
    connectWebSocket();
});

function getPanelIdFromUrl() {
    const parts =
        location.pathname.split('/');
    // /panel/{panel_id} → parts[2]
    return parts[2] || null;
}

// ==========================================
// パネルデータ取得
// ==========================================
async function loadPanel(panelId) {
    try {
        const resp = await fetch(
            `/api/gui2/panels/${panelId}`
        );
        if (!resp.ok) {
            const err = await resp.json();
            showError(
                `パネルが見つかりません。\n`
                + `(${err.detail || resp.status})`
            );
            return;
        }

        panelData = await resp.json();

        document.title =
            panelData.display_name
            + ' - オペレータGUI';
        document.getElementById(
            'g2-panel-name'
        ).textContent =
            panelData.display_name;

        renderSources();
        renderDests();
        updateLeaveBtn();

    } catch (e) {
        showError(
            `読み込みエラー: ${e.message}`
        );
    }
}

// ==========================================
// WebSocket
// ==========================================
function connectWebSocket() {
    const wsUrl =
        `ws://${location.host}/ws/gui`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        setWsLed(true);
    };

    ws.onclose = () => {
        setWsLed(false);
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
        setWsLed(false);
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connection_map') {
                connectionMap = msg.data || {};
                renderDests();
                renderSources();
            }
        } catch (err) {
            console.error(err);
        }
    };
}

function setWsLed(connected) {
    const led =
        document.getElementById('g2-ws-led');
    if (!led) return;
    led.className = 'g2-ws-led '
        + (connected
            ? 'connected'
            : 'disconnected');
}

// ==========================================
// ロック機能
// ==========================================
function initLock() {
    const thumb =
        document.getElementById(
            'g2-lock-thumb');
    const track =
        document.getElementById(
            'g2-lock-track');

    if (!thumb || !track) return;

    // マウス
    thumb.addEventListener(
        'mousedown', onSlideStart);
    document.addEventListener(
        'mousemove', onSlideMove);
    document.addEventListener(
        'mouseup', onSlideEnd);

    // タッチ
    thumb.addEventListener(
        'touchstart', onSlideStart,
        { passive: true });
    document.addEventListener(
        'touchmove', onSlideMove,
        { passive: false });
    document.addEventListener(
        'touchend', onSlideEnd);

    // 初期状態: ロック
    applyLock(true);
}

function onSlideStart(e) {
    if (!isLocked) return;
    isSliding  = true;
    slideStartX = e.touches
        ? e.touches[0].clientX
        : e.clientX;
    slideThumbLeft = 2;
}

function onSlideMove(e) {
    if (!isSliding) return;
    if (e.cancelable) e.preventDefault();

    const clientX = e.touches
        ? e.touches[0].clientX
        : e.clientX;
    const delta = clientX - slideStartX;
    const track =
        document.getElementById(
            'g2-lock-track');
    const maxLeft =
        track.offsetWidth - 34;
    const newLeft = Math.max(
        2, Math.min(maxLeft, 2 + delta)
    );

    const thumb =
        document.getElementById(
            'g2-lock-thumb');
    thumb.style.transition = 'none';
    thumb.style.left = `${newLeft}px`;

    // スライド量に応じてラベルを変化
    const ratio = delta / SLIDE_THRESHOLD;
    const label =
        document.getElementById(
            'g2-lock-label');
    if (ratio >= 1) {
        label.textContent = 'アンロック！';
        label.style.color = '#4ec9b0';
    } else {
        label.textContent =
            'スライドでアンロック';
        label.style.color = '#888';
    }
}

function onSlideEnd(e) {
    if (!isSliding) return;
    isSliding = false;

    const clientX = e.changedTouches
        ? e.changedTouches[0].clientX
        : e.clientX;
    const delta = clientX - slideStartX;

    if (delta >= SLIDE_THRESHOLD) {
        applyLock(false);
    } else {
        // 元の位置に戻す
        const thumb =
            document.getElementById(
                'g2-lock-thumb');
        thumb.style.transition = '';
        thumb.style.left = '2px';
        const label =
            document.getElementById(
                'g2-lock-label');
        label.textContent =
            'スライドでアンロック';
        label.style.color = '#888';
    }
}

// applyLock を差し替え
// applyLock を差し替え
function applyLock(locked) {
    isLocked = locked;

    const thumb =
        document.getElementById(
            'g2-lock-thumb');
    const label =
        document.getElementById(
            'g2-lock-label');
    const track =
        document.getElementById(
            'g2-lock-track');
    const overlay =
        document.getElementById(
            'g2-lock-overlay');
    const header =
        document.querySelector('.g2-header');

    if (!thumb || !label || !overlay)
        return;

    if (locked) {
        // ロック状態
        thumb.textContent = '🔒';
        thumb.style.left  = '2px';
        thumb.classList.remove('unlocked');
        thumb.onclick = null;

        label.textContent =
            'スライドでアンロック';
        label.classList.remove('unlocked');

        track.classList.remove('unlocked');
        header?.classList.remove('unlocked');

        overlay.classList.add('active');

        selectedDestId = null;
        renderDests();
        renderSources();
        updateLeaveBtn();

    } else {
        // アンロック状態
        thumb.textContent = '🔓';
        thumb.classList.add('unlocked');
        thumb.style.left = '';
        thumb.onclick = () => applyLock(true);

        label.textContent = 'タップでロック';
        label.classList.add('unlocked');

        track.classList.add('unlocked');
        header?.classList.add('unlocked');

        overlay.classList.remove('active');

        renderDests();
        renderSources();
        updateLeaveBtn();
    }
}

// onDestListClick を差し替え
// （背景タップで選択解除）
function onDestListClick(e) {
    if (!e.target.closest('.g2-dest-btn')) {
        selectedDestId = null;
        renderDests();
        renderSources();
        updateLeaveBtn();
    }
}

function onLockOverlayClick() {
    // オーバーレイクリックは何もしない
    // （ロック中はボタン操作を無効化するだけ）
}

// ==========================================
// Source描画
// ==========================================
function renderSources() {
    const list =
        document.getElementById(
            'g2-source-list');
    if (!list || !panelData) return;

    const sources =
        panelData.sources || [];

    // 選択中Destの"none"カテゴリを特定
    const noneCategories =
        getNoneCategories();

    list.innerHTML = '';
    sources.forEach(src => {
        const btn =
            document.createElement('button');
        btn.className = 'g2-src-btn';
        btn.dataset.srcId = src.id;

        // ラベル
        const labelEl =
            document.createElement('div');
        labelEl.className = 'g2-src-label';
        labelEl.textContent = src.label;
        btn.appendChild(labelEl);

        // バッジ
        const badgesEl =
            document.createElement('div');
        badgesEl.className = 'g2-src-badges';

        const badgeDefs = [
            {
                key: 'video_sender_id',
                cat: 'video',
                label: 'V'
            },
            {
                key: 'audio_sender_id',
                cat: 'audio',
                label: 'A'
            },
            {
                key: 'anc_sender_id',
                cat: 'anc',
                label: 'ANC'
            }
        ];

        badgeDefs.forEach(def => {
            const val = src[def.key];
            if (!val || val === 'leave')
                return;

            const badge =
                document.createElement('span');
            badge.className = 'g2-badge';
            badge.textContent = def.label;

            // Dest選択中かつnoneカテゴリなら
            // グレーアウト
            if (selectedDestId &&
                noneCategories.has(def.cat)) {
                badge.classList.add('grayed');
            } else {
                badge.classList.add('active');
            }
            badgesEl.appendChild(badge);
        });

        btn.appendChild(badgesEl);

        // ロック中スタイル
        if (isLocked) {
            btn.classList.add('locked');
        }

        btn.addEventListener(
            'click', () => onSelectSource(src)
        );
        list.appendChild(btn);
    });
}

function getNoneCategories() {
    const result = new Set();
    if (!selectedDestId || !panelData) {
        return result;
    }
    const dest = panelData.destinations
        .find(d => d.id === selectedDestId);
    if (!dest) return result;

    if (dest.video_receiver_id === 'none')
        result.add('video');
    if (dest.audio_receiver_id === 'none')
        result.add('audio');
    if (dest.anc_receiver_id   === 'none')
        result.add('anc');

    return result;
}

// ==========================================
// Destination描画
// ==========================================
function renderDests() {
    const list =
        document.getElementById(
            'g2-dest-list');
    if (!list || !panelData) return;

    const dests =
        panelData.destinations || [];

    list.innerHTML = '';
    dests.forEach(dest => {
        const btn =
            document.createElement('button');
        btn.className = 'g2-dest-btn';
        btn.dataset.destId = dest.id;

        if (dest.id === selectedDestId) {
            btn.classList.add('selected');
        }
        if (isLocked) {
            btn.classList.add('locked');
        }

        // 行1: Destinationボタンラベル
        const labelEl =
            document.createElement('div');
        labelEl.className = 'g2-dest-label';
        labelEl.textContent = dest.label;
        btn.appendChild(labelEl);

        // 行2: 接続中SourceボタンラベルOR──
        const srcLabelEl =
            document.createElement('div');
        const connSrcLabel =
            getConnectedSourceLabel(dest);
        if (connSrcLabel) {
            srcLabelEl.className =
                'g2-dest-src-label';
            srcLabelEl.textContent =
                connSrcLabel;
        } else {
            srcLabelEl.className =
                'g2-dest-src-label empty';
            srcLabelEl.textContent = '──';
        }
        btn.appendChild(srcLabelEl);

        // 行3〜5: V/A/ANC 素材ラベル（小）
        const detailsEl =
            document.createElement('div');
        detailsEl.className =
            'g2-dest-details';

        const detailDefs = [
            {
                key: 'video_receiver_id',
                label: 'v'
            },
            {
                key: 'audio_receiver_id',
                label: 'a'
            },
            {
                key: 'anc_receiver_id',
                label: 'anc'
            }
        ];

        detailDefs.forEach(def => {
            const row =
                document.createElement('div');
            row.className =
                'g2-dest-detail-row';

            const keyEl =
                document.createElement('span');
            keyEl.className = 'g2-detail-key';
            keyEl.textContent = def.label + ':';

            const valEl =
                document.createElement('span');
            valEl.className = 'g2-detail-val';

            const rid = dest[def.key];
            if (!rid || rid === 'none') {
                valEl.classList.add('none');
                valEl.textContent = '──';
            } else {
                const cm =
                    connectionMap[rid];
                if (cm &&
                    cm.sender_resource_id) {
                    valEl.textContent =
                        cm.sender_label
                        || cm.sender_resource_id;
                } else {
                    valEl.classList.add('none');
                    valEl.textContent = '──';
                }
            }

            row.appendChild(keyEl);
            row.appendChild(valEl);
            detailsEl.appendChild(row);
        });

        btn.appendChild(detailsEl);

        btn.addEventListener(
            'click',
            (e) => onSelectDest(e, dest)
        );
        list.appendChild(btn);
    });
}

// ==========================================
// 接続中SourceボタンラベルOR──
// ==========================================
function getConnectedSourceLabel(dest) {
    if (!panelData) return null;

    // "none"でないReceiverを収集
    const categories = [
        {
            recvKey: 'video_receiver_id',
            sendKey: 'video_sender_id'
        },
        {
            recvKey: 'audio_receiver_id',
            sendKey: 'audio_sender_id'
        },
        {
            recvKey: 'anc_receiver_id',
            sendKey: 'anc_sender_id'
        }
    ];

    // 監視対象カテゴリのsender_idを収集
    const connectedSenderIds = [];
    for (const cat of categories) {
        const rid = dest[cat.recvKey];
        if (!rid || rid === 'none') continue;

        const cm = connectionMap[rid];
        const sid =
            cm?.sender_resource_id || null;
        connectedSenderIds.push({
            sendKey: cat.sendKey,
            sid
        });
    }

    // 監視対象が0件
    if (connectedSenderIds.length === 0)
        return null;

    // 1件でもsidがnullなら「──」
    if (connectedSenderIds.some(
        c => !c.sid
    )) return null;

    // 全senderIdがSourcesの同一行と一致するか
    const sources = panelData.sources || [];
    for (const src of sources) {
        const allMatch =
            connectedSenderIds.every(c => {
                const srcVal = src[c.sendKey];
                return srcVal === c.sid;
            });
        if (allMatch) return src.label;
    }

    // 一致するSourceなし → 「──」
    return null;
}

// ==========================================
// Destination選択
// ==========================================
function onSelectDest(e, dest) {
    e.stopPropagation();
    if (isLocked) return;

    if (selectedDestId === dest.id) {
        // 同じDestを再タップで解除
        selectedDestId = null;
    } else {
        selectedDestId = dest.id;
    }

    renderDests();
    renderSources();
    updateLeaveBtn();
}

// ==========================================
// 背景タップで選択解除
// ==========================================
function onDestPaneBgClick(e) {
    if (e.target === e.currentTarget
        || e.target.closest(
            '.g2-dest-btn') === null) {
        if (e.target.closest(
            '.g2-dest-btn') === null) {
            selectedDestId = null;
            renderDests();
            renderSources();
            updateLeaveBtn();
        }
    }
}

// ==========================================
// Source選択 → TAKE実行
// ==========================================
async function onSelectSource(src) {
    if (isLocked) return;
    if (!selectedDestId) {
        showToast(
            'Destinationを選択してください',
            'warn'
        );
        return;
    }

    const dest = panelData.destinations
        .find(d => d.id === selectedDestId);
    if (!dest) return;

    await executeTake(src, dest);
}

// ==========================================
// TAKE実行（直列3本）
// ==========================================
async function executeTake(src, dest) {
    const categories = [
        {
            recvKey: 'video_receiver_id',
            sendKey: 'video_sender_id',
            label:   'V'
        },
        {
            recvKey: 'audio_receiver_id',
            sendKey: 'audio_sender_id',
            label:   'A'
        },
        {
            recvKey: 'anc_receiver_id',
            sendKey: 'anc_sender_id',
            label:   'ANC'
        }
    ];

    let hasError = false;

    for (const cat of categories) {
        const receiverId = dest[cat.recvKey];
        const senderId   = src[cat.sendKey];

        // "none" → スキップ
        if (!receiverId
            || receiverId === 'none') {
            continue;
        }

        try {
            if (!senderId
                || senderId === 'leave') {
                // LEAVE
                const resp = await fetch(
                    '/api/connection/leave',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        body: JSON.stringify({
                            dest_resource_id:
                                receiverId
                        })
                    }
                );
                if (!resp.ok) {
                    const err =
                        await resp.json();
                    console.error(
                        `LEAVE失敗[${cat.label}]:`,
                        err.detail
                    );
                    hasError = true;
                }

            } else {
                // TAKE
                const resp = await fetch(
                    '/api/connection/take',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        body: JSON.stringify({
                            source_resource_id:
                                senderId,
                            dest_resource_id:
                                receiverId
                        })
                    }
                );
                if (!resp.ok) {
                    const err =
                        await resp.json();
                    console.error(
                        `TAKE失敗[${cat.label}]:`,
                        err.detail
                    );
                    hasError = true;
                }
            }

        } catch (e) {
            console.error(
                `TAKE/LEAVE例外[${cat.label}]:`,
                e
            );
            hasError = true;
        }
    }

    if (hasError) {
        showToast(
            '一部の接続に失敗しました', 'error'
        );
    } else {
        showToast(
            `${src.label} → ${dest.label}`,
            'ok'
        );
    }
}

// ==========================================
// LEAVE（選択中Destの全Receiver）
// ==========================================
async function onLeave(e) {
    e.stopPropagation();
    if (isLocked) return;
    if (!selectedDestId) return;

    const dest = panelData.destinations
        .find(d => d.id === selectedDestId);
    if (!dest) return;

    const categories = [
        'video_receiver_id',
        'audio_receiver_id',
        'anc_receiver_id'
    ];

    let hasError = false;

    for (const key of categories) {
        const receiverId = dest[key];
        if (!receiverId
            || receiverId === 'none') {
            continue;
        }

        try {
            const resp = await fetch(
                '/api/connection/leave',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        dest_resource_id:
                            receiverId
                    })
                }
            );
            if (!resp.ok) hasError = true;

        } catch (e) {
            hasError = true;
        }
    }

    if (hasError) {
        showToast('LEAVE失敗', 'error');
    } else {
        showToast(
            `${dest.label} をLeaveしました`,
            'ok'
        );
    }
}

// ==========================================
// LEAVEボタンの活性/非活性
// ==========================================
function updateLeaveBtn() {
    const btn =
        document.getElementById(
            'g2-leave-btn');
    if (!btn) return;

    if (selectedDestId && !isLocked) {
        btn.classList.remove('disabled');
    } else {
        btn.classList.add('disabled');
    }
}

// ==========================================
// エラー表示
// ==========================================
function showError(msg) {
    const el =
        document.getElementById('g2-error');
    const msgEl =
        document.getElementById('g2-error-msg');
    if (el && msgEl) {
        msgEl.textContent = msg;
        el.style.display = 'flex';
    }
}

// ==========================================
// トースト
// ==========================================
function showToast(message, type = 'ok') {
    document.querySelectorAll('.g2-toast')
        .forEach(t => t.remove());

    const toast =
        document.createElement('div');
    toast.className = `g2-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(
            () => toast.remove(), 300
        );
    }, 3000);
}