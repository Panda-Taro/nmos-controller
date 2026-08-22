// script.js - Node GUI

// ==========================================
// 状態管理
// ==========================================
let nmosData = {
    nodes: {},
    devices: {},
    senders: {},
    receivers: {},
    sources: {},
    flows: {}
};

let registeredMaterials = {
    senders: {},
    receivers: {}
};

let selectedResource = null;
let contextResource = null;
let ws = null;
let logEntries = [];

// 選択フィルター状態
let filterState = {
    nodeId: null,
    deviceId: null
};

// フォーマットフィルター状態
let formatFilter = {
    senders:   { video: false, audio: false, ancillary: false },
    receivers: { video: false, audio: false, ancillary: false }
};

// ==========================================
// WebSocket接続
// ==========================================
function connectWebSocket() {
    const wsUrl = `ws://${location.host}/ws/gui`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        addLog('info', 'WebSocket', 'サーバーに接続しました');
        updateStatusLed(true);
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch (e) {
            console.error('メッセージ解析エラー:', e);
        }
    };

    ws.onclose = () => {
        addLog('error', 'WebSocket',
            '接続が切断されました。再接続中...');
        updateStatusLed(false);
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
        addLog('error', 'WebSocket', 'エラーが発生しました');
    };
}

// ==========================================
// メッセージ処理
// ==========================================
function handleMessage(msg) {
    switch (msg.type) {
        case 'is04_status':
            handleStatusUpdate(msg.data);
            break;
        case 'nmos_data':
            handleNmosData(msg.data);
            break;
        default:
            break;
    }
}

function handleStatusUpdate(status) {
    updateStatusLed(status.connected);
    const statusText = document.getElementById('status-text');
    if (status.connected) {
        statusText.textContent =
            `RDS接続中: ${status.rds_url}`;
        addLog('info', 'IS-04', `RDS接続: ${status.rds_url}`);
    } else {
        statusText.textContent =
            `切断: ${status.error || '不明なエラー'}`;
        addLog('error', 'IS-04',
            `RDS切断: ${status.error || '不明なエラー'}`);
    }
}

function handleNmosData(data) {
    const prevCounts = {
        nodes:     Object.keys(nmosData.nodes).length,
        devices:   Object.keys(nmosData.devices).length,
        senders:   Object.keys(nmosData.senders).length,
        receivers: Object.keys(nmosData.receivers).length
    };

    nmosData = data;

    const newCounts = {
        nodes:     Object.keys(nmosData.nodes).length,
        devices:   Object.keys(nmosData.devices).length,
        senders:   Object.keys(nmosData.senders).length,
        receivers: Object.keys(nmosData.receivers).length
    };

    for (const [key, count] of Object.entries(newCounts)) {
        if (count !== prevCounts[key]) {
            addLog('update', 'IS-04',
                `${key}: ${prevCounts[key]} → ${count} 件`);
        }
    }

    renderAll();
}

// ==========================================
// 選択・フィルター制御
// ==========================================
function selectNode(nodeId) {
    if (filterState.nodeId === nodeId) {
        clearFilter();
    } else {
        filterState.nodeId   = nodeId;
        filterState.deviceId = null;
        addLog('info', 'Node',
            `選択: ${nmosData.nodes[nodeId]?.label
                || nmosData.nodes[nodeId]?.hostname
                || nodeId}`);
        renderAll();
    }
}

function selectDevice(deviceId) {
    if (filterState.deviceId === deviceId) {
        filterState.deviceId = null;
        addLog('info', 'Device', '選択解除');
        renderAll();
    } else {
        filterState.deviceId = deviceId;
        const device = nmosData.devices[deviceId];
        if (device) {
            filterState.nodeId = device.node_id;
        }
        addLog('info', 'Device',
            `選択: ${nmosData.devices[deviceId]?.label
                || deviceId}`);
        renderAll();
    }
}

function clearFilter() {
    filterState.nodeId   = null;
    filterState.deviceId = null;
    addLog('info', 'Filter', '選択解除（全件表示）');
    renderAll();
}

// ==========================================
// フォーマットフィルター制御
// ==========================================
function toggleFormatFilter(panel, format) {
    formatFilter[panel][format] =
        !formatFilter[panel][format];
    updateFormatButtons(panel);

    // 修正: renderAll() → 該当パネルのみ再描画
    if (panel === 'senders') {
        renderSenders();
    } else {
        renderReceivers();
    }
}

function toggleAllFilter(panel) {
    formatFilter[panel].video     = false;
    formatFilter[panel].audio     = false;
    formatFilter[panel].ancillary = false;
    updateFormatButtons(panel);

    // 修正: renderAll() → 該当パネルのみ再描画
    if (panel === 'senders') {
        renderSenders();
    } else {
        renderReceivers();
    }
}

function updateFormatButtons(panel) {
    const prefix = panel === 'senders' ? 'fmt-s' : 'fmt-r';

    const map = {
        video:     `${prefix}-video`,
        audio:     `${prefix}-audio`,
        ancillary: `${prefix}-anc`
    };

    for (const [fmt, id] of Object.entries(map)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        if (formatFilter[panel][fmt]) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    const allBtn = document.getElementById(
        `${prefix}-all`);
    if (allBtn) {
        const anyOn = formatFilter[panel].video
            || formatFilter[panel].audio
            || formatFilter[panel].ancillary;
        if (anyOn) {
            allBtn.classList.remove('active');
        } else {
            allBtn.classList.add('active');
        }
    }
}

function getResourceFormat(resource) {
    const fmt = resource.format || '';
    if (fmt.includes('video')) return 'video';
    if (fmt.includes('audio')) return 'audio';
    if (fmt.includes('data'))  return 'data';

    const label = (resource.label || '').toLowerCase();
    if (label.includes('video')) return 'video';
    if (label.includes('audio')) return 'audio';
    if (label.includes('anc')
        || label.includes('meta')) return 'data';

    return 'unknown';
}

function matchFormat(resource, panel) {
    const format  = getResourceFormat(resource);
    const isVideo = format === 'video';
    const isAudio = format === 'audio';
    const isData  = format === 'data';

    const anyOn = formatFilter[panel].video
        || formatFilter[panel].audio
        || formatFilter[panel].ancillary;

    if (!isVideo && !isAudio && !isData) {
        return !anyOn;
    }

    if (!anyOn) return true;

    if (isVideo) return formatFilter[panel].video;
    if (isAudio) return formatFilter[panel].audio;
    if (isData)  return formatFilter[panel].ancillary;

    return false;
}

// ==========================================
// フィルタリングロジック
// ==========================================
function getFilteredSenders() {
    let senders = Object.values(nmosData.senders);

    if (filterState.deviceId) {
        senders = senders.filter(
            s => s.device_id === filterState.deviceId
        );
    } else if (filterState.nodeId) {
        const deviceIds = Object.values(nmosData.devices)
            .filter(d => d.node_id === filterState.nodeId)
            .map(d => d.id);
        senders = senders.filter(
            s => deviceIds.includes(s.device_id)
        );
    }

    return senders;
}

function getFilteredReceivers() {
    let receivers = Object.values(nmosData.receivers);

    if (filterState.deviceId) {
        receivers = receivers.filter(
            r => r.device_id === filterState.deviceId
        );
    } else if (filterState.nodeId) {
        const deviceIds = Object.values(nmosData.devices)
            .filter(d => d.node_id === filterState.nodeId)
            .map(d => d.id);
        receivers = receivers.filter(
            r => deviceIds.includes(r.device_id)
        );
    }

    return receivers;
}

function getFilteredDevices() {
    let devices = Object.values(nmosData.devices);

    if (filterState.nodeId) {
        devices = devices.filter(
            d => d.node_id === filterState.nodeId
        );
    }

    return devices;
}

// ==========================================
// 描画処理
// ==========================================
function renderAll() {
    renderNodes();
    renderDevices();
    renderSenders();
    renderReceivers();
}

function renderNodes() {
    const list       = document.getElementById('nodes-list');
    const filterText = document.getElementById('filter-nodes')
        .value.toLowerCase();

    const nodes = Object.values(nmosData.nodes)
        .filter(n => matchFilter(n, filterText));

    document.getElementById('node-count').textContent =
        Object.keys(nmosData.nodes).length;

    if (nodes.length === 0) {
        list.innerHTML = emptyMessage('Nodeが見つかりません');
        return;
    }

    list.innerHTML = nodes.map(node => {
        const isSelected = filterState.nodeId === node.id;
        return `
            <div class="${isSelected
                    ? 'resource-item selected'
                    : 'resource-item'}"
                onclick="selectNode('${node.id}')">
                <div class="resource-icon">🖥</div>
                <div class="resource-info">
                    <div class="resource-name">
                        ${node.label
                            || node.hostname
                            || node.id}
                    </div>
                    <div class="resource-sub">
                        ${node.href || node.id}
                    </div>
                </div>
                ${isSelected
                    ? '<span class="selected-badge">' +
                      '▶ 選択中</span>'
                    : ''}
            </div>
        `;
    }).join('');
}

function renderDevices() {
    const list       = document.getElementById('devices-list');
    const filterText = document.getElementById('filter-devices')
        .value.toLowerCase();

    const allDevices = getFilteredDevices()
        .filter(d => matchFilter(d, filterText));

    document.getElementById('device-count').textContent =
        filterState.nodeId
            ? `${allDevices.length} / `
              + `${Object.keys(nmosData.devices).length}`
            : Object.keys(nmosData.devices).length;

    if (allDevices.length === 0) {
        list.innerHTML = emptyMessage(
            filterState.nodeId
                ? 'このNodeのDeviceはありません'
                : 'Deviceが見つかりません'
        );
        return;
    }

    list.innerHTML = allDevices.map(device => {
        const isSelected =
            filterState.deviceId === device.id;
        return `
            <div class="${isSelected
                    ? 'resource-item selected'
                    : 'resource-item'}"
                onclick="selectDevice('${device.id}')">
                <div class="resource-icon">📦</div>
                <div class="resource-info">
                    <div class="resource-name">
                        ${device.label || device.id}
                    </div>
                    <div class="resource-sub">
                        type: ${device.type || '不明'}
                    </div>
                </div>
                ${isSelected
                    ? '<span class="selected-badge">' +
                      '▶ 選択中</span>'
                    : ''}
            </div>
        `;
    }).join('');
}

function renderSenders() {
    const list       = document.getElementById('senders-list');
    const filterText = document.getElementById('filter-senders')
        .value.toLowerCase();

    const totalCount = Object.keys(nmosData.senders).length;

    const filtered = getFilteredSenders()
        .filter(s => matchFilter(s, filterText))
        .filter(s => matchFormat(s, 'senders'));

    const isFiltering =
        filterState.nodeId || filterState.deviceId;

    document.getElementById('sender-count').textContent =
        `${filtered.length} / ${totalCount}`;

    if (filtered.length === 0) {
        list.innerHTML = emptyMessage(
            isFiltering
                ? '該当するSenderはありません'
                : 'Senderが見つかりません'
        );
        return;
    }

    list.innerHTML = filtered.map(sender => {
        const isRegistered =
            registeredMaterials.senders[sender.id];
        const badge     = getFormatBadge(sender);
        const itemClass = isRegistered
            ? 'resource-item registered'
            : 'resource-item';
        const actionBtn = isRegistered
            ? `<span class="btn-registered">✓ 登録済</span>`
            : `<button class="btn-register-small"
                onclick="event.stopPropagation();
                openRegisterModal('sender','${sender.id}')">
                ＋ 登録
               </button>`;
        return `
            <div class="${itemClass}"
                oncontextmenu="showContextMenu(
                    event,'sender','${sender.id}')"
                onclick="selectResource(
                    'sender','${sender.id}')">
                <div class="resource-icon">📤</div>
                <div class="resource-info">
                    <div class="resource-name">
                        ${sender.label || sender.id}
                    </div>
                    <div class="resource-sub">
                        ${sender.id.substring(0, 18)}...
                    </div>
                </div>
                ${badge}
                ${actionBtn}
            </div>
        `;
    }).join('');
}

function renderReceivers() {
    const list = document.getElementById('receivers-list');
    const filterText = document.getElementById(
        'filter-receivers').value.toLowerCase();

    const totalCount =
        Object.keys(nmosData.receivers).length;

    const filtered = getFilteredReceivers()
        .filter(r => matchFilter(r, filterText))
        .filter(r => matchFormat(r, 'receivers'));

    const isFiltering =
        filterState.nodeId || filterState.deviceId;

    document.getElementById('receiver-count').textContent =
        `${filtered.length} / ${totalCount}`;

    if (filtered.length === 0) {
        list.innerHTML = emptyMessage(
            isFiltering
                ? '該当するReceiverはありません'
                : 'Receiverが見つかりません'
        );
        return;
    }

    list.innerHTML = filtered.map(receiver => {
        const isRegistered =
            registeredMaterials.receivers[receiver.id];
        const badge     = getFormatBadge(receiver);
        const itemClass = isRegistered
            ? 'resource-item registered'
            : 'resource-item';
        const actionBtn = isRegistered
            ? `<span class="btn-registered">✓ 登録済</span>`
            : `<button class="btn-register-small"
                onclick="event.stopPropagation();
                openRegisterModal('receiver',
                '${receiver.id}')">
                ＋ 登録
               </button>`;
        return `
            <div class="${itemClass}"
                oncontextmenu="showContextMenu(
                    event,'receiver','${receiver.id}')"
                onclick="selectResource(
                    'receiver','${receiver.id}')">
                <div class="resource-icon">📥</div>
                <div class="resource-info">
                    <div class="resource-name">
                        ${receiver.label || receiver.id}
                    </div>
                    <div class="resource-sub">
                        ${receiver.id.substring(0, 18)}...
                    </div>
                </div>
                ${badge}
                ${actionBtn}
            </div>
        `;
    }).join('');
}

// ==========================================
// ユーティリティ
// ==========================================
function emptyMessage(text) {
    return `<div style="color:#555;text-align:center;
        padding:16px;font-size:12px;">${text}</div>`;
}

function matchFilter(resource, filter) {
    if (!filter) return true;
    const label = (resource.label || '').toLowerCase();
    const id    = (resource.id    || '').toLowerCase();
    return label.includes(filter) || id.includes(filter);
}

function getFormatBadge(resource) {
    const format = getResourceFormat(resource);
    if (format === 'video') {
        return '<span class="resource-badge badge-video">'
            + 'V</span>';
    } else if (format === 'audio') {
        return '<span class="resource-badge badge-audio">'
            + 'A</span>';
    } else if (format === 'data') {
        return '<span class="resource-badge badge-ancillary">'
            + 'ANC</span>';
    }
    return '';
}

function selectResource(type, id) {
    selectedResource = { type, id };
}

function updateStatusLed(connected) {
    const led  = document.getElementById('status-led');
    const text = document.getElementById('status-text');
    if (connected) {
        led.className = 'status-led connected';
    } else {
        led.className = 'status-led disconnected';
        text.textContent = 'RDS切断';
    }
}

// ==========================================
// 画面の空きをクリックで選択解除
// ==========================================
document.addEventListener('DOMContentLoaded', () => {

    const container =
        document.querySelector('.main-container');
    if (container) {
        container.addEventListener('click', (e) => {
            if (!e.target.closest('.resource-item')
                && !e.target.closest('.context-menu')
                && !e.target.closest('.modal-overlay')
                && !e.target.closest('.fmt-btn')      // ← 追加
                && !e.target.closest('.filter-bar')   // ← 追加
                && !e.target.closest('.filter-input') // ← 追加
            ) {
                if (filterState.nodeId
                        || filterState.deviceId) {
                    clearFilter();
                }
            }
        });
    }

    ['nodes', 'devices', 'senders', 'receivers']
        .forEach(type => {
            const input = document.getElementById(
                `filter-${type}`);
            if (input) {
                input.addEventListener(
                    'input', renderAll);
            }
        });

    loadRegisteredMaterials();
    connectWebSocket();
});

// ==========================================
// 素材登録モーダル
// ==========================================
function openRegisterModal(resourceType, resourceId) {
    const resource = resourceType === 'sender'
        ? nmosData.senders[resourceId]
        : nmosData.receivers[resourceId];

    if (!resource) return;

    selectedResource = { type: resourceType, id: resourceId };

    document.getElementById('modal-title').textContent =
        `素材として登録：${resource.label || resource.id}`;
    document.getElementById('modal-label').value =
        resource.label || '';

    // エラーをクリア
    clearRegisterError();

    const fmt = getResourceFormat(resource);
    if (fmt === 'video') {
        document.querySelector(
            'input[name="modal-type"][value="video"]'
        ).checked = true;
    } else if (fmt === 'audio') {
        document.querySelector(
            'input[name="modal-type"][value="audio"]'
        ).checked = true;
    } else if (fmt === 'data') {
        document.querySelector(
            'input[name="modal-type"][value="ancillary"]'
        ).checked = true;
    }

    document.getElementById(
        'modal-resource-info').innerHTML = `
        <div class="resource-info-box">
            <div>種類：${resourceType === 'sender'
                ? 'Sender（送信）'
                : 'Receiver（受信）'}</div>
            <div>ID：${resource.id}</div>
            <div>フォーマット：
                ${resource.format || '不明'}</div>
            ${resource.manifest_href
                ? `<div>Manifest：
                   ${resource.manifest_href}</div>`
                : ''}
        </div>
    `;

    document.getElementById('modal-overlay')
        .classList.add('active');
    document.getElementById('modal-label').focus();
}

function closeModal() {
    document.getElementById('modal-overlay')
        .classList.remove('active');
    clearRegisterError();
}

function clearRegisterError() {
    const el = document.getElementById('modal-error');
    if (el) {
        el.textContent  = '';
        el.style.display = 'none';
    }
}

function showRegisterError(msg) {
    const el = document.getElementById('modal-error');
    if (el) {
        el.textContent  = msg;
        el.style.display = 'block';
    }
}

async function registerMaterial() {
    if (!selectedResource) return;

    const label = document.getElementById(
        'modal-label').value.trim();
    const materialType = document.querySelector(
        'input[name="modal-type"]:checked').value;

    if (!label) {
        showRegisterError('ラベルを入力してください');
        return;
    }

    const resource = selectedResource.type === 'sender'
        ? nmosData.senders[selectedResource.id]
        : nmosData.receivers[selectedResource.id];

    const payload = {
        resource_type: selectedResource.type,
        resource_id:   selectedResource.id,
        label:         label,
        material_type: materialType,
        resource_data: resource
    };

    try {
        const resp = await fetch(
            '/api/materials/register', {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

        if (resp.ok) {
            if (selectedResource.type === 'sender') {
                registeredMaterials.senders[
                    selectedResource.id] = {
                        label, materialType };
            } else {
                registeredMaterials.receivers[
                    selectedResource.id] = {
                        label, materialType };
            }
            addLog('register', '素材登録',
                `${label} (${materialType}) を登録しました`);
            closeModal();
            renderAll();
        } else {
            // エラー詳細をモーダル内に表示
            const result = await resp.json();
            showRegisterError(
                result.detail || '登録に失敗しました'
            );
        }
    } catch (e) {
        showRegisterError(`エラー: ${e.message}`);
    }
}

// ==========================================
// 右クリックコンテキストメニュー
// ==========================================
function showContextMenu(event, resourceType, resourceId) {
    event.preventDefault();
    event.stopPropagation();
    contextResource = { type: resourceType, id: resourceId };

    const menu = document.getElementById('context-menu');
    menu.style.left = `${event.clientX}px`;
    menu.style.top  = `${event.clientY}px`;
    menu.classList.add('active');

    const sdpItems = menu.querySelectorAll(
        '.context-item:nth-child(-n+3)');
    sdpItems.forEach(item => {
        item.style.display =
            resourceType === 'sender' ? 'block' : 'none';
    });
    const separator =
        menu.querySelector('.context-separator');
    if (separator) {
        separator.style.display =
            resourceType === 'sender' ? 'block' : 'none';
    }
}

document.addEventListener('click', (e) => {
    document.getElementById('context-menu')
        .classList.remove('active');
});

async function getSdpContent() {
    if (!contextResource
        || contextResource.type !== 'sender') return null;

    const sender = nmosData.senders[contextResource.id];
    if (!sender || !sender.manifest_href) return null;

    try {
        const resp = await fetch(
            `/api/is04/sdp?url=${
                encodeURIComponent(sender.manifest_href)}`
        );
        if (resp.ok) return await resp.text();
    } catch (e) {
        addLog('error', 'SDP', `取得エラー: ${e.message}`);
    }
    return null;
}

async function contextShowSdp() {
    const sdp = await getSdpContent();
    if (!sdp) {
        alert('SDPの取得に失敗しました');
        return;
    }
    document.getElementById('sdp-content').textContent = sdp;
    document.getElementById('sdp-modal-overlay')
        .classList.add('active');
}

async function contextCopySdp() {
    const sdp = await getSdpContent();
    if (!sdp) {
        alert('SDPの取得に失敗しました');
        return;
    }
    await navigator.clipboard.writeText(sdp);
    addLog('info', 'SDP', 'クリップボードにコピーしました');
}

async function contextDownloadSdp() {
    const sdp = await getSdpContent();
    if (!sdp) {
        alert('SDPの取得に失敗しました');
        return;
    }
    const sender   = nmosData.senders[contextResource.id];
    const filename =
        `${sender.label || contextResource.id}.sdp`;
    const blob = new Blob([sdp], { type: 'application/sdp' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    addLog('info', 'SDP', `ダウンロード: ${filename}`);
}

function contextRegister() {
    if (!contextResource) return;
    openRegisterModal(
        contextResource.type, contextResource.id);
}

function closeSdpModal() {
    document.getElementById('sdp-modal-overlay')
        .classList.remove('active');
}

// ==========================================
// ログ
// ==========================================
function addLog(type, source, message) {
    if (!document.getElementById('log-enabled').checked)
        return;

    const maxLines = parseInt(
        document.getElementById('log-maxlines').value
    ) || 100;

    const now  = new Date();
    const time = now.toLocaleTimeString('ja-JP',
        { hour12: false });
    const ms   = String(now.getMilliseconds())
        .padStart(3, '0');

    logEntries.push({ type, source, message, time, ms });
    if (logEntries.length > maxLines) {
        logEntries = logEntries.slice(-maxLines);
    }
    renderLog();
}

function renderLog() {
    const container =
        document.getElementById('log-content');
    container.innerHTML = logEntries.map(entry => `
        <div class="log-entry log-${entry.type}">
            <span class="log-time">
                [${entry.time}.${entry.ms}]
            </span>
            <span class="log-type">${entry.source}:</span>
            ${entry.message}
        </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
}

function clearLog() {
    logEntries = [];
    renderLog();
}

// ==========================================
// 登録済み素材の読み込み
// ==========================================
async function loadRegisteredMaterials() {
    try {
        const resp = await fetch('/api/materials/list');
        if (resp.ok) {
            const data = await resp.json();
            // senders / receivers を
            // registeredMaterials に変換
            registeredMaterials.senders   = {};
            registeredMaterials.receivers = {};
            for (const [id, m] of
                Object.entries(data.senders || {})) {
                registeredMaterials.senders[
                    m.resource_id] = m;
            }
            for (const [id, m] of
                Object.entries(data.receivers || {})) {
                registeredMaterials.receivers[
                    m.resource_id] = m;
            }
        }
    } catch (e) {
        console.log('素材リスト取得:', e.message);
    }
}