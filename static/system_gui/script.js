// script.js - System GUI

const TAB_ORDER = [
    'program', 'gui2', 'materials', 'restapi', 'system'
];

// ==========================================
// 枠ページでこのタブが表示されたときの処理
// （Control画面での素材削除・名称変更等を反映するため、
//   表示中タブの一覧のみ読み直す。開いているタブ・カードの
//   開閉・入力中のフォーム等はそのまま保持する）
// ==========================================
window.onShellShow = function () {
    const active = document.querySelector('.tab-content.active');
    const tabId  = active ? active.id.replace('tab-', '') : '';

    // ※ switchTab() は呼ばない（programタブでは番組ロードの
    //   進捗ポーリングを止めてしまい、systemタブではカードを
    //   閉じてしまうため）
    if (tabId === 'program')   loadProgramList();
    if (tabId === 'gui2')      loadGui2Panels();
    if (tabId === 'materials') loadSdpList();
    if (tabId === 'restapi')   loadRestTriggers();
    // systemタブは一覧を持たないため何もしない
};

// ==========================================
// タブ切り替え
// ==========================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn')
        .forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content')
        .forEach(c => c.classList.remove('active'));

    document.getElementById(`tab-${tabId}`)
        ?.classList.add('active');

    const idx = TAB_ORDER.indexOf(tabId);
    const btns = document.querySelectorAll('.tab-btn');
    if (idx !== -1 && btns[idx])
        btns[idx].classList.add('active');

    history.replaceState(null, '', `#${tabId}`);

    if (tabId === 'system')    initSystemTab();
    if (tabId === 'materials') loadSdpList();
    if (tabId === 'gui2')      loadGui2Panels();
    if (tabId === 'restapi')   loadRestTriggers();
}

// ==========================================
// 初期化
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();

    const hash = location.hash.replace('#', '');
    if (hash && TAB_ORDER.includes(hash)) {
        switchTab(hash);
    } else {
        switchTab('program');
    }
});

// ==========================================
// WebSocket（ステータスLED用）
// ==========================================
function connectWebSocket() {
    const ws =
        new WebSocket(`ws://${location.host}/ws/gui`);
    ws.onopen  = () => updateStatusLed(true);
    ws.onclose = () => {
        updateStatusLed(false);
        setTimeout(connectWebSocket, 3000);
    };
    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'is04_status') {
                updateStatusLed(msg.data.connected);
                document.getElementById('status-text')
                    .textContent = msg.data.connected
                        ? `RDS接続中: ${msg.data.rds_url}`
                        : `切断: ${msg.data.error || '不明'}`;
            }
        } catch (err) { console.error(err); }
    };
}

function updateStatusLed(connected) {
    document.getElementById('status-led').className =
        connected
            ? 'status-led connected'
            : 'status-led disconnected';
    if (!connected)
        document.getElementById('status-text')
            .textContent = 'RDS切断';
}

// ==========================================
// カード展開/折りたたみ
// ==========================================
function toggleCard(name) {
    const content =
        document.getElementById(`content-${name}`);
    const arrow =
        document.getElementById(`arrow-${name}`);
    if (!content) return;

    const isOpen = content.classList.contains('open');
    content.classList.toggle('open', !isOpen);
    arrow?.classList.toggle('open', !isOpen);

    if (!isOpen) {
        if (name === 'network')  loadNetworkConfig();
        if (name === 'logs')     loadLogs();
        if (name === 'rds')      loadRdsStatus();
        if (name === 'interval') loadProgramInterval();
    }
}

// ==========================================
// システム設定タブ 初期化
// ==========================================
function initSystemTab() {
    ['network', 'fileio', 'logs',
        'rds', 'interval', 'reboot',
        'shutdown',  // ← 追加
        'reset']
        .forEach(name => {
            document.getElementById(
                `content-${name}`
            )?.classList.remove('open');
            document.getElementById(
                `arrow-${name}`
            )?.classList.remove('open');
        });
}

// ==========================================
// 【1】ネットワーク設定
// ==========================================
async function loadNetworkConfig() {
    try {
        const resp =
            await fetch('/api/system/network');
        if (!resp.ok)
            throw new Error(await resp.text());
        const data = await resp.json();

        setValue('net-ip',         data.ip_address);
        setValue('net-subnet',     data.subnet);
        setValue('net-gw',         data.gateway);
        setValue('net-reg-port',   data.registration_port);
        setValue('net-query-port', data.query_port);
        setValue('net-node-port',  data.node_port);
        setValue('net-log-port',   data.logging_port);

    } catch (e) {
        showToast(
            `設定読み込みエラー: ${e.message}`, 'error'
        );
    }
}

async function saveNetworkConfig() {
    const newIp  = getValue('net-ip');
    const subnet = getValue('net-subnet');

    const step1 = await showConfirm(
        'サーバーを再起動して設定を反映します。\nよろしいですか？'
    );
    if (!step1) return;

    const step2 = await showConfirm(
        `再起動後のIPアドレスは\n${newIp}\nです。`
        + `新しいIPアドレスでアクセスしてください。`
    );
    if (!step2) return;

    try {
        const body = {
            ip_address:        newIp,
            subnet:            parseInt(subnet),
            gateway:           getValue('net-gw'),
            registration_port: parseInt(getValue('net-reg-port')),
            query_port:        parseInt(getValue('net-query-port')),
            node_port:         parseInt(getValue('net-node-port')),
            logging_port:      parseInt(getValue('net-log-port'))
        };

        const resp = await fetch('/api/system/network', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body)
        });
        const result = await resp.json();

        if (resp.ok) {
            showToast('設定を保存しました。再起動します...', 'ok');
        } else {
            showToast(`保存エラー: ${result.detail}`, 'error');
        }
    } catch (e) {
        showToast(`保存エラー: ${e.message}`, 'error');
    }
}

// ==========================================
// 【2】設定ファイル インポート/エクスポート
// ==========================================
function exportFile(type) {
    downloadFile(`/api/system/export/${type}`, `${type}.json`);
}

// ==========================================
// ファイルのダウンロード
// （画面のURLを直接切り替えると、サーバーがエラーを返したときに
//   画面がエラー表示に置き換わってしまうため、取得結果を確認してから
//   保存する。失敗時はトーストで通知する）
// ==========================================
async function downloadFile(url, fallbackName) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            let detail = `${resp.status} ${resp.statusText}`;
            try {
                const body = await resp.json();
                if (body && body.detail) {
                    detail = typeof body.detail === 'string'
                        ? body.detail
                        : JSON.stringify(body.detail);
                }
            } catch (_) { /* JSON以外の応答はステータスのみ表示 */ }
            showToast(`ダウンロードエラー: ${detail}`, 'error');
            return;
        }

        const blob = await resp.blob();
        const name = parseDownloadFilename(
            resp.headers.get('Content-Disposition')) || fallbackName;

        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href          = objUrl;
        a.download      = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
    } catch (e) {
        showToast(`ダウンロードエラー: ${e.message}`, 'error');
    }
}

// Content-Disposition からファイル名を取り出す
//   attachment; filename="config.json"
//   attachment; filename*=utf-8''%E7%B4%A0%E6%9D%90.sdp  （日本語名）
function parseDownloadFilename(header) {
    if (!header) return null;
    const star = header.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
    if (star) {
        try {
            return decodeURIComponent(star[2].trim());
        } catch (_) { /* 下の filename= へ */ }
    }
    const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
    return plain ? plain[1].trim() : null;
}

async function importFile(type) {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const confirmed = await showConfirm(
            `${file.name} をインポートしますか？\n`
            + `現在の ${type}.json は上書きされます。`
        );
        if (!confirmed) return;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const resp = await fetch(
                `/api/system/import/${type}`,
                { method: 'POST', body: formData }
            );
            const result = await resp.json();
            showToast(
                resp.ok
                    ? result.message
                    : `エラー: ${result.detail}`,
                resp.ok ? 'ok' : 'error'
            );
        } catch (e) {
            showToast(
                `インポートエラー: ${e.message}`, 'error'
            );
        }
    };
    input.click();
}

// ==========================================
// 【3】ログ確認
// ==========================================
async function loadLogs() {
    const el = document.getElementById('log-view');
    if (el) el.textContent = '読み込み中...';

    try {
        const resp = await fetch('/api/system/logs');
        if (!resp.ok)
            throw new Error(await resp.text());
        const data = await resp.json();

        if (!el) return;

        if (data.lines.length === 0) {
            el.textContent = 'ログがありません';
            return;
        }

        el.textContent = data.lines.join('\n');
        el.scrollTop   = el.scrollHeight;

        const info = document.getElementById('log-info');
        if (info)
            info.textContent =
                `表示: ${data.showing}件 / 合計: ${data.total}件`;

    } catch (e) {
        if (el)
            el.textContent = `ログ取得エラー: ${e.message}`;
    }
}

function exportLogs() {
    downloadFile('/api/system/export/logs', 'nmos-controller.log');
}

// ==========================================
// 【4】NMOS-RDS状態確認
// ==========================================
async function loadRdsStatus() {
    await loadRdsPs();
    await loadRdsLogs();
}

async function loadRdsPs() {
    const el = document.getElementById('rds-ps-view');
    if (el) el.textContent = '読み込み中...';
    try {
        const resp = await fetch('/api/system/rds/status');
        const data = await resp.json();
        if (el)
            el.textContent =
                data.stdout || data.stderr || '（出力なし）';
    } catch (e) {
        if (el) el.textContent = `取得エラー: ${e.message}`;
    }
}

async function loadRdsLogs() {
    const el = document.getElementById('rds-log-view');
    if (el) el.textContent = '読み込み中...';
    try {
        const resp = await fetch('/api/system/rds/logs');
        const data = await resp.json();
        if (el) {
            el.textContent =
                data.stdout || data.stderr || '（出力なし）';
            el.scrollTop = el.scrollHeight;
        }
    } catch (e) {
        if (el) el.textContent = `取得エラー: ${e.message}`;
    }
}

// ==========================================
// 【5】送信間隔設定
// ==========================================
async function loadProgramInterval() {
    try {
        const resp =
            await fetch('/api/system/program-interval');
        const data = await resp.json();
        setValue('program-interval',
            data.send_interval_ms ?? 100);
    } catch (e) {
        console.error('送信間隔取得エラー:', e);
    }
}

async function saveProgramInterval() {
    const val = parseInt(getValue('program-interval'));
    if (isNaN(val) || val < 0) {
        showToast('0以上の整数を入力してください', 'error');
        return;
    }
    try {
        const resp = await fetch(
            '/api/system/program-interval', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ send_interval_ms: val })
            }
        );
        const result = await resp.json();
        showToast(result.message, 'ok');
    } catch (e) {
        showToast(`保存エラー: ${e.message}`, 'error');
    }
}

// ==========================================
// 【6-1】サーバー再起動
// ==========================================
async function rebootServer() {
    const step1 = await showConfirm(
        'サーバーを再起動しますか？\n'
        + '再起動中は本システムが利用できません。'
    );
    if (!step1) return;

    try {
        await fetch('/api/system/reboot', { method: 'POST' });
        showToast(
            '再起動を開始しました。しばらくお待ちください。', 'ok'
        );
    } catch (e) {
        showToast(
            '再起動を開始しました。しばらくお待ちください。', 'ok'
        );
    }
}

// ==========================================
// 【6-2】サーバーシャットダウン
// ==========================================
async function shutdownServer() {
    const step1 = await showConfirm(
        'サーバーをシャットダウンしますか？\n'
        + '電源が切れます。再起動するには物理的な操作が必要です。'
    );
    if (!step1) return;

    const step2 = await showConfirm(
        '⚠ 本当にシャットダウンしますか？\n'
        + 'この操作は取り消せません。'
    );
    if (!step2) return;

    try {
        await fetch('/api/system/shutdown', { method: 'POST' });
        showToast(
            'シャットダウンを開始しました。', 'ok'
        );
    } catch (e) {
        showToast(
            'シャットダウンを開始しました。', 'ok'
        );
    }
}

// ==========================================
// 【7】設定初期化
// ==========================================
async function resetDatabase() {
    const step1 = await showConfirm(
        '⚠ 設定を初期化しますか？\n'
        + 'database.json の全データが削除されます。'
    );
    if (!step1) return;

    const step2 = await showConfirm(
        '⚠ 本当に初期化しますか？\nこの操作は元に戻せません。'
    );
    if (!step2) return;

    try {
        const resp = await fetch(
            '/api/system/reset', { method: 'POST' }
        );
        const result = await resp.json();
        showToast(result.message, 'ok');
    } catch (e) {
        showToast(`初期化エラー: ${e.message}`, 'error');
    }
}

// ==========================================
// ユーティリティ
// ==========================================
function getValue(id) {
    return document.getElementById(id)?.value ?? '';
}

function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
}

function showConfirm(message) {
    return Promise.resolve(window.confirm(message));
}

function showToast(message, type = 'ok') {
    document.querySelectorAll('.toast')
        .forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('toast-show');
    });

    setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function setDialogError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    if (message) {
        el.textContent = message;
        el.classList.add('show');
    } else {
        el.textContent = '';
        el.classList.remove('show');
    }
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;');
}

function escAttr(str) {
    if (!str) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g,  "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

// ==========================================
// SDP インポート関連
// ==========================================
let sdpPendingContent  = '';
let sdpPendingFilename = '';

async function loadSdpList() {
    const container = document.getElementById('sdp-list');
    if (!container) return;
    container.innerHTML =
        '<div class="sdp-loading">読み込み中...</div>';

    try {
        const resp = await fetch('/api/materials');
        if (!resp.ok)
            throw new Error(await resp.text());
        const data = await resp.json();
        renderSdpList(data);
    } catch (e) {
        container.innerHTML =
            `<div class="sdp-loading">`
            + `読み込みエラー: ${e.message}</div>`;
    }
}

function renderSdpList(materials) {
    const container = document.getElementById('sdp-list');
    if (!container) return;

    const categories = [
        { key: 'video',     label: '🎬 Video' },
        { key: 'audio',     label: '🔊 Audio' },
        { key: 'ancillary', label: '📡 Ancillary' }
    ];

    let html = '';
    for (const cat of categories) {
        const items = (materials[cat.key] || [])
            .filter(item =>
                (item.source || 'sdp') === 'sdp');
        html += `
        <div class="sdp-category">
            <div class="sdp-category-header">
                <span class="sdp-category-title">
                    ${cat.label}
                </span>
                <span class="sdp-category-count">
                    ${items.length}
                </span>
            </div>`;

        if (items.length === 0) {
            html += `<div class="sdp-empty">（登録なし）</div>`;
        } else {
            for (const item of items) {
                html += renderSdpItem(cat.key, item);
            }
        }
        html += `</div>`;
    }
    container.innerHTML = html;
}

function renderSdpItem(category, item) {
    const desc = item.description !== item.label
        ? item.description : '';
    return `
    <div class="sdp-item" id="sdp-item-${item.id}">
        <div class="sdp-item-info">
            <div class="sdp-item-label">
                ${escHtml(item.label)}
            </div>
            ${desc
                ? `<div class="sdp-item-desc">
                       ${escHtml(desc)}
                   </div>`
                : ''}
            <div class="sdp-item-filename">
                ${escHtml(item.sdp_original_name)}
            </div>
        </div>
        <div class="sdp-item-btns">
            <button class="btn-icon"
                onclick="openSdpEditDialog(
                    '${category}',
                    '${item.id}',
                    '${escAttr(item.label)}',
                    '${escAttr(item.description)}'
                )">✏ ラベル変更</button>
            <button class="btn-icon"
                onclick="openSdpViewDialog(
                    '${escAttr(item.label)}',
                    '${escAttr(item.sdp_original_name)}',
                    '${escAttr(item.sdp_content)}'
                )">📄 SDP表示</button>
            <button class="btn-icon"
                onclick="downloadSdp(
                    '${category}','${item.id}'
                )">💾 DL</button>
            <button class="btn-icon danger"
                onclick="deleteSdpItem(
                    '${category}',
                    '${item.id}',
                    '${escAttr(item.label)}'
                )">🗑 削除</button>
        </div>
    </div>`;
}

function openSdpImportDialog() {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.sdp';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            const content = ev.target.result;
            sdpPendingContent  = content;
            sdpPendingFilename = file.name;

            document.getElementById('dialog-filename')
                .textContent = file.name;

            const stem = file.name.replace(/\.sdp$/i, '');
            document.getElementById('dialog-label').value
                = stem;

            const desc = parseSdpDescription(content);
            document.getElementById(
                'dialog-description').value = desc;

            setDialogError('dialog-error', '');
            document.getElementById('sdp-dialog-overlay')
                .classList.add('open');
        };
        reader.readAsText(file);
    };
    input.click();
}

function closeSdpDialog() {
    document.getElementById('sdp-dialog-overlay')
        .classList.remove('open');
    sdpPendingContent  = '';
    sdpPendingFilename = '';
}

function onDialogLabelInput() {
    setDialogError('dialog-error', '');
}

async function submitSdpImport() {
    const label    = document.getElementById(
        'dialog-label').value.trim();
    const description = document.getElementById(
        'dialog-description').value.trim();
    const category = document.querySelector(
        'input[name="dialog-category"]:checked')?.value;

    if (!label) {
        setDialogError('dialog-error',
            'ラベルを入力してください');
        return;
    }
    if (!sdpPendingContent) {
        setDialogError('dialog-error',
            'SDPファイルが選択されていません');
        return;
    }

    try {
        const resp = await fetch('/api/materials/sdp', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                label,
                description,
                category,
                sdp_content:   sdpPendingContent,
                original_name: sdpPendingFilename
            })
        });
        const result = await resp.json();

        if (resp.status === 409) {
            setDialogError('dialog-error', result.detail);
            return;
        }
        if (!resp.ok) {
            setDialogError('dialog-error',
                `登録エラー: ${result.detail}`);
            return;
        }

        closeSdpDialog();
        showToast(result.message, 'ok');
        loadSdpList();

    } catch (e) {
        setDialogError('dialog-error',
            `登録エラー: ${e.message}`);
    }
}

function openSdpViewDialog(label, filename, content) {
    document.getElementById('sdp-view-filename')
        .textContent = filename;
    document.getElementById('sdp-view-content')
        .textContent = content;
    document.getElementById('sdp-view-overlay')
        .classList.add('open');
}

function closeSdpViewDialog() {
    document.getElementById('sdp-view-overlay')
        .classList.remove('open');
}

function openSdpEditDialog(
    category, itemId, label, description
) {
    document.getElementById('edit-item-id').value
        = itemId;
    document.getElementById('edit-category').value
        = category;
    document.getElementById('edit-label').value
        = label;
    document.getElementById('edit-description').value
        = description;
    setDialogError('edit-error', '');
    document.getElementById('sdp-edit-overlay')
        .classList.add('open');
}

function closeSdpEditDialog() {
    document.getElementById('sdp-edit-overlay')
        .classList.remove('open');
}

async function submitSdpEdit() {
    const itemId      = document.getElementById(
        'edit-item-id').value;
    const category    = document.getElementById(
        'edit-category').value;
    const label       = document.getElementById(
        'edit-label').value.trim();
    const description = document.getElementById(
        'edit-description').value.trim();

    if (!label) {
        setDialogError('edit-error',
            'ラベルを入力してください');
        return;
    }

    try {
        const resp = await fetch(
            `/api/materials/${category}/${itemId}`, {
                method:  'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ label, description })
            }
        );
        const result = await resp.json();

        if (resp.status === 409) {
            setDialogError('edit-error', result.detail);
            return;
        }
        if (!resp.ok) {
            setDialogError('edit-error',
                `更新エラー: ${result.detail}`);
            return;
        }

        closeSdpEditDialog();
        showToast(result.message, 'ok');
        loadSdpList();

    } catch (e) {
        setDialogError('edit-error',
            `更新エラー: ${e.message}`);
    }
}

function downloadSdp(category, itemId) {
    downloadFile(
        `/api/materials/${category}/${itemId}/sdp`, 'download.sdp');
}

async function deleteSdpItem(category, itemId, label) {
    const confirmed = await showConfirm(
        `「${label}」を削除しますか？\nSDPファイルも削除されます。`
    );
    if (!confirmed) return;

    try {
        const resp = await fetch(
            `/api/materials/${category}/${itemId}`,
            { method: 'DELETE' }
        );
        const result = await resp.json();

        if (!resp.ok) {
            showToast(`削除エラー: ${result.detail}`, 'error');
            return;
        }

        showToast(result.message, 'ok');
        loadSdpList();

    } catch (e) {
        showToast(`削除エラー: ${e.message}`, 'error');
    }
}

function parseSdpDescription(content) {
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('s=')) {
            const val = trimmed.slice(2).trim();
            if (val && val !== '-') return val;
        }
    }
    return '';
}

// ==========================================
// GUI② オペレータGUI 設定
// ==========================================
let gui2EditingPanelId = null;
let gui2DeleteTargetId = null;
let gui2Materials      = null;

async function loadGui2Panels() {
    const container =
        document.getElementById('gui2-panel-list');
    if (!container) return;
    container.innerHTML =
        '<div class="sdp-loading">読み込み中...</div>';

    try {
        const resp = await fetch('/api/gui2/panels');
        if (!resp.ok)
            throw new Error(await resp.text());
        const panels = await resp.json();
        renderGui2PanelList(panels);
    } catch (e) {
        container.innerHTML =
            `<div class="sdp-loading">`
            + `読み込みエラー: ${e.message}</div>`;
    }
}

function renderGui2PanelList(panels) {
    const container =
        document.getElementById('gui2-panel-list');
    if (!container) return;

    if (panels.length === 0) {
        container.innerHTML =
            '<div class="sdp-loading">'
            + 'パネルがありません。'
            + '「＋ パネルを追加」から作成してください。'
            + '</div>';
        return;
    }

    container.innerHTML = '';

    panels.forEach(panel => {
        const card = document.createElement('div');
        card.className     = 'gui2-panel-card';
        card.draggable     = true;
        card.dataset.panelId = panel.panel_id;

        card.innerHTML = `
        <span class="gui2-drag-handle"
              title="ドラッグで並び替え">⠿</span>
        <span class="gui2-order-badge">
            ${escHtml(panel.order_number)}
        </span>
        <div class="gui2-panel-info">
            <div class="gui2-panel-name">
                ${escHtml(panel.display_name)}
            </div>
            <div class="gui2-panel-id-text">
                ID: ${escHtml(panel.panel_id)}
            </div>
            <div class="gui2-panel-meta">
                Source: ${panel.source_count}件 /
                Dest: ${panel.dest_count}件
            </div>
            <div class="gui2-panel-url">
                <a href="${escHtml(location.origin)}/panel/${escHtml(panel.panel_id)}/"
                   target="_blank"
                   title="クリックで新しいタブで開く"
                >/panel/${escHtml(panel.panel_id)}</a>
                &nbsp;|&nbsp;
                <a href="${escHtml(location.origin)}/panel/${escHtml(panel.order_number)}/"
                   target="_blank"
                   title="クリックで新しいタブで開く"
                >/panel/${escHtml(panel.order_number)}</a>
            </div>
        </div>
        <div class="gui2-panel-btns">
            <button class="btn-icon"
                onclick="openPanelEditModal(
                    '${escAttr(panel.panel_id)}'
                )">✏ 編集</button>
            <button class="btn-icon danger"
                onclick="openDeleteModal(
                    '${escAttr(panel.panel_id)}',
                    '${escAttr(panel.display_name)}'
                )">🗑 削除</button>
        </div>`;

        initPanelCardDrag(card);
        container.appendChild(card);
    });
}

let gui2DragSrcCard = null;

function initPanelCardDrag(card) {
    card.addEventListener('dragstart', e => {
        gui2DragSrcCard = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.gui2-panel-card')
            .forEach(c => c.classList.remove('drag-over'));
        gui2DragSrcCard = null;
    });
    card.addEventListener('dragover', e => {
        e.preventDefault();
        if (gui2DragSrcCard && gui2DragSrcCard !== card)
            card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over');
    });
    card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (!gui2DragSrcCard ||
            gui2DragSrcCard === card) return;

        const container =
            document.getElementById('gui2-panel-list');
        const cards = [
            ...container.querySelectorAll('.gui2-panel-card')
        ];
        const srcIdx = cards.indexOf(gui2DragSrcCard);
        const dstIdx = cards.indexOf(card);

        if (srcIdx < dstIdx) card.after(gui2DragSrcCard);
        else                  card.before(gui2DragSrcCard);

        savePanelOrder();
    });
}

async function savePanelOrder() {
    const container =
        document.getElementById('gui2-panel-list');
    const cards = [
        ...container.querySelectorAll('.gui2-panel-card')
    ];
    const panel_ids = cards.map(c => c.dataset.panelId);

    try {
        const resp = await fetch(
            '/api/gui2/panels/reorder', {
                method:  'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ panel_ids })
            }
        );
        if (resp.ok) {
            showToast('並び順を保存しました', 'ok');
            loadGui2Panels();
        } else {
            showToast('並び替え保存エラー', 'error');
        }
    } catch (e) {
        showToast(`エラー: ${e.message}`, 'error');
    }
}

async function loadGui2Materials() {
    if (gui2Materials) return gui2Materials;
    try {
        const resp = await fetch('/api/materials');
        if (!resp.ok) throw new Error();
        gui2Materials = await resp.json();
        return gui2Materials;
    } catch (e) {
        gui2Materials = {
            video: [], audio: [], ancillary: []
        };
        return gui2Materials;
    }
}

function buildSenderOptions(category, selectedId) {
    const items = (gui2Materials?.[category] || [])
        .filter(i =>
            i.resource_type === 'sender' ||
            i.source === 'sdp'
        );

    let html =
        `<option value="leave"`
        + (selectedId === 'leave' ? ' selected' : '')
        + `>── Leave</option>`;

    for (const item of items) {
        const rid = item.resource_id || item.id;
        const sel = rid === selectedId ? ' selected' : '';
        html +=
            `<option value="${escAttr(rid)}"${sel}>`
            + `${escHtml(item.label)}</option>`;
    }
    return html;
}

function buildReceiverOptions(category, selectedId) {
    const items = (gui2Materials?.[category] || [])
        .filter(i => i.resource_type === 'receiver');

    let html =
        `<option value="none"`
        + (selectedId === 'none' ? ' selected' : '')
        + `>── None</option>`;

    for (const item of items) {
        const rid = item.resource_id || item.id;
        const sel = rid === selectedId ? ' selected' : '';
        html +=
            `<option value="${escAttr(rid)}"${sel}>`
            + `${escHtml(item.label)}</option>`;
    }
    return html;
}

async function openPanelCreateModal() {
    gui2EditingPanelId = null;
    document.getElementById('gui2-modal-title')
        .textContent = '📱 パネルを追加';
    document.getElementById('gui2-panel-id').value = '';
    document.getElementById('gui2-panel-id').disabled
        = false;
    document.getElementById('gui2-panel-name').value
        = '';
    setDialogError('gui2-modal-error', '');

    await loadGui2Materials();

    document.getElementById('gui2-sources-list')
        .innerHTML = '';
    document.getElementById('gui2-dests-list')
        .innerHTML = '';
    document.getElementById('gui2-panel-modal')
        .classList.add('open');
}

async function openPanelEditModal(panelId) {
    gui2EditingPanelId = panelId;
    document.getElementById('gui2-modal-title')
        .textContent = '✏ パネルを編集';
    setDialogError('gui2-modal-error', '');

    await loadGui2Materials();

    try {
        const resp =
            await fetch(`/api/gui2/panels/${panelId}`);
        if (!resp.ok)
            throw new Error(await resp.text());
        const panel = await resp.json();

        document.getElementById('gui2-panel-id').value
            = panel.panel_id;
        document.getElementById('gui2-panel-id').disabled
            = true;
        document.getElementById('gui2-panel-name').value
            = panel.display_name;

        const srcList =
            document.getElementById('gui2-sources-list');
        srcList.innerHTML = '';
        for (const src of (panel.sources || []))
            srcList.appendChild(createSourceRow(src));

        const dstList =
            document.getElementById('gui2-dests-list');
        dstList.innerHTML = '';
        for (const dst of (panel.destinations || []))
            dstList.appendChild(createDestRow(dst));

        document.getElementById('gui2-panel-modal')
            .classList.add('open');

    } catch (e) {
        showToast(
            `パネル読み込みエラー: ${e.message}`, 'error'
        );
    }
}

function closePanelModal() {
    document.getElementById('gui2-panel-modal')
        .classList.remove('open');
    gui2EditingPanelId = null;
}

function addSourceRow(data = null) {
    document.getElementById('gui2-sources-list')
        .appendChild(createSourceRow(data));
}

function createSourceRow(data = null) {
    const row      = document.createElement('div');
    row.className  = 'gui2-item-row';
    row.draggable  = true;

    const label = data?.label             || '';
    const vid   = data?.video_sender_id   || 'leave';
    const aud   = data?.audio_sender_id   || 'leave';
    const anc   = data?.anc_sender_id     || 'leave';

    row.innerHTML = `
    <span class="gui2-item-drag"
          title="ドラッグで並び替え">⠿</span>
    <div class="gui2-item-fields">
        <div class="gui2-item-label-row">
            <input type="text"
                   class="gui2-item-label-input"
                   placeholder="ボタンラベル"
                   value="${escHtml(label)}">
        </div>
        <div class="gui2-item-selects">
            <div class="gui2-item-select-group">
                <span class="gui2-item-select-label">
                    🎬 Video
                </span>
                <select class="gui2-item-select"
                        data-cat="video_sender">
                    ${buildSenderOptions('video', vid)}
                </select>
            </div>
            <div class="gui2-item-select-group">
                <span class="gui2-item-select-label">
                    🔊 Audio
                </span>
                <select class="gui2-item-select"
                        data-cat="audio_sender">
                    ${buildSenderOptions('audio', aud)}
                </select>
            </div>
            <div class="gui2-item-select-group">
                <span class="gui2-item-select-label">
                    📡 ANC
                </span>
                <select class="gui2-item-select"
                        data-cat="anc_sender">
                    ${buildSenderOptions('ancillary', anc)}
                </select>
            </div>
        </div>
    </div>
    <div class="gui2-item-delete">
        <button class="btn-icon danger"
            onclick="removeItemRow(this)">🗑</button>
    </div>`;

    initItemRowDrag(row, 'gui2-sources-list');
    return row;
}

function addDestRow(data = null) {
    document.getElementById('gui2-dests-list')
        .appendChild(createDestRow(data));
}

function createDestRow(data = null) {
    const row     = document.createElement('div');
    row.className = 'gui2-item-row';
    row.draggable = true;

    const label = data?.label              || '';
    const vid   = data?.video_receiver_id  || 'none';
    const aud   = data?.audio_receiver_id  || 'none';
    const anc   = data?.anc_receiver_id    || 'none';

    row.innerHTML = `
    <span class="gui2-item-drag"
          title="ドラッグで並び替え">⠿</span>
    <div class="gui2-item-fields">
        <div class="gui2-item-label-row">
            <input type="text"
                   class="gui2-item-label-input"
                   placeholder="ボタンラベル"
                   value="${escHtml(label)}">
        </div>
        <div class="gui2-item-selects">
            <div class="gui2-item-select-group">
                <span class="gui2-item-select-label">
                    🎬 Video
                </span>
                <select class="gui2-item-select"
                        data-cat="video_receiver">
                    ${buildReceiverOptions('video', vid)}
                </select>
            </div>
            <div class="gui2-item-select-group">
                <span class="gui2-item-select-label">
                    🔊 Audio
                </span>
                <select class="gui2-item-select"
                        data-cat="audio_receiver">
                    ${buildReceiverOptions('audio', aud)}
                </select>
            </div>
            <div class="gui2-item-select-group">
                <span class="gui2-item-select-label">
                    📡 ANC
                </span>
                <select class="gui2-item-select"
                        data-cat="anc_receiver">
                    ${buildReceiverOptions('ancillary', anc)}
                </select>
            </div>
        </div>
    </div>
    <div class="gui2-item-delete">
        <button class="btn-icon danger"
            onclick="removeItemRow(this)">🗑</button>
    </div>`;

    initItemRowDrag(row, 'gui2-dests-list');
    return row;
}

function removeItemRow(btn) {
    btn.closest('.gui2-item-row').remove();
}

let gui2DragSrcRow = null;
let gui2DragListId = null;

function initItemRowDrag(row, listId) {
    row.addEventListener('dragstart', e => {
        gui2DragSrcRow = row;
        gui2DragListId = listId;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        document.querySelectorAll('.gui2-item-row')
            .forEach(r => r.classList.remove('drag-over'));
        gui2DragSrcRow = null;
    });
    row.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        if (gui2DragSrcRow && gui2DragSrcRow !== row &&
            gui2DragListId === listId)
            row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
    });
    row.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drag-over');
        if (!gui2DragSrcRow || gui2DragSrcRow === row ||
            gui2DragListId !== listId) return;

        const srcIdx = [...row.parentElement
            .querySelectorAll('.gui2-item-row')]
            .indexOf(gui2DragSrcRow);
        const dstIdx = [...row.parentElement
            .querySelectorAll('.gui2-item-row')]
            .indexOf(row);

        if (srcIdx < dstIdx) row.after(gui2DragSrcRow);
        else                  row.before(gui2DragSrcRow);
    });
}

async function savePanel() {
    const panelId =
        document.getElementById('gui2-panel-id')
            .value.trim();
    const displayName =
        document.getElementById('gui2-panel-name')
            .value.trim();

    if (!panelId) {
        setDialogError('gui2-modal-error',
            'パネルIDを入力してください');
        return;
    }
    if (!displayName) {
        setDialogError('gui2-modal-error',
            '表示名を入力してください');
        return;
    }

    const sources = [];
    document.querySelectorAll(
        '#gui2-sources-list .gui2-item-row'
    ).forEach(row => {
        sources.push({
            label:           row.querySelector(
                '.gui2-item-label-input')?.value.trim() || '',
            video_sender_id: row.querySelector(
                '[data-cat="video_sender"]')?.value || 'leave',
            audio_sender_id: row.querySelector(
                '[data-cat="audio_sender"]')?.value || 'leave',
            anc_sender_id:   row.querySelector(
                '[data-cat="anc_sender"]')?.value   || 'leave'
        });
    });

    const destinations = [];
    document.querySelectorAll(
        '#gui2-dests-list .gui2-item-row'
    ).forEach(row => {
        destinations.push({
            label:             row.querySelector(
                '.gui2-item-label-input')?.value.trim() || '',
            video_receiver_id: row.querySelector(
                '[data-cat="video_receiver"]')?.value || 'none',
            audio_receiver_id: row.querySelector(
                '[data-cat="audio_receiver"]')?.value || 'none',
            anc_receiver_id:   row.querySelector(
                '[data-cat="anc_receiver"]')?.value   || 'none'
        });
    });

    try {
        let resp;
        if (gui2EditingPanelId) {
            resp = await fetch(
                `/api/gui2/panels/${gui2EditingPanelId}`,
                {
                    method:  'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        display_name: displayName,
                        sources,
                        destinations
                    })
                }
            );
        } else {
            resp = await fetch('/api/gui2/panels', {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    panel_id:     panelId,
                    display_name: displayName,
                    sources,
                    destinations
                })
            });
        }

        const result = await resp.json();

        if (resp.status === 409) {
            setDialogError('gui2-modal-error',
                result.detail);
            return;
        }
        if (!resp.ok) {
            setDialogError('gui2-modal-error',
                result.detail || '保存エラー');
            return;
        }

        closePanelModal();
        showToast(result.message, 'ok');
        loadGui2Panels();

    } catch (e) {
        setDialogError('gui2-modal-error',
            `保存エラー: ${e.message}`);
    }
}

function openDeleteModal(panelId, displayName) {
    gui2DeleteTargetId = panelId;
    document.getElementById('gui2-delete-name')
        .textContent = displayName;
    document.getElementById('gui2-delete-modal')
        .classList.add('open');
}

function closeDeleteModal() {
    document.getElementById('gui2-delete-modal')
        .classList.remove('open');
    gui2DeleteTargetId = null;
}

async function confirmDeletePanel() {
    if (!gui2DeleteTargetId) return;

    try {
        const resp = await fetch(
            `/api/gui2/panels/${gui2DeleteTargetId}`,
            { method: 'DELETE' }
        );
        const result = await resp.json();

        if (!resp.ok) {
            showToast(
                `削除エラー: ${result.detail}`, 'error'
            );
            return;
        }

        closeDeleteModal();
        showToast(result.message, 'ok');
        loadGui2Panels();

    } catch (e) {
        showToast(`削除エラー: ${e.message}`, 'error');
    }
}

// ==========================================
// REST API トリガー管理
// ==========================================
let restTriggers          = [];
let restMaterials         = null;
let triggerEditingNumber  = null;
let triggerDeleteNumber   = null;
let shortcutAssignNumber  = null;
let shortcutCapturedKey   = null;
let restapiSortable       = null;

// ------------------------------------------
// 素材一覧取得（プルダウン用キャッシュ）
// ------------------------------------------
async function loadRestMaterials() {
    if (restMaterials) return restMaterials;
    try {
        const resp = await fetch('/api/materials');
        if (!resp.ok) throw new Error();
        restMaterials = await resp.json();
    } catch (e) {
        restMaterials = {
            video: [], audio: [], ancillary: []
        };
    }
    return restMaterials;
}

// ------------------------------------------
// 素材ラベル解決ユーティリティ
// ------------------------------------------
function resolveLabel(materials, resourceId, type) {
    if (!resourceId || resourceId === 'leave')
        return 'leave';
    if (resourceId === 'none')
        return 'none';

    const cats = type === 'sender'
        ? ['video', 'audio', 'ancillary']
        : ['video', 'audio', 'ancillary'];

    for (const cat of cats) {
        const found = (materials[cat] || []).find(
            i => (i.resource_id || i.id) === resourceId
        );
        if (found) return found.label;
    }
    return resourceId;
}

// ------------------------------------------
// トリガー一覧読み込み
// ------------------------------------------
async function loadRestTriggers() {
    const tbody =
        document.getElementById('restapi-tbody');
    if (!tbody) return;
    tbody.innerHTML = `
        <tr>
            <td colspan="8" class="restapi-empty">
                読み込み中...
            </td>
        </tr>`;

    try {
        const [trigResp, matResp] = await Promise.all([
            fetch('/api/rest-triggers'),
            fetch('/api/materials')
        ]);

        if (!trigResp.ok) throw new Error(
            await trigResp.text()
        );

        restTriggers  = await trigResp.json();
        restMaterials = matResp.ok
            ? await matResp.json()
            : { video: [], audio: [], ancillary: [] };

        renderRestTriggers(restTriggers);

    } catch (e) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="restapi-empty">
                    読み込みエラー: ${escHtml(e.message)}
                </td>
            </tr>`;
    }
}

// ------------------------------------------
// トリガー一覧描画
// ------------------------------------------
function renderRestTriggers(triggers) {
    const tbody =
        document.getElementById('restapi-tbody');
    if (!tbody) return;

    if (triggers.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="restapi-empty">
                    トリガーがありません。<br>
                    「＋ トリガーを追加」から作成してください。
                </td>
            </tr>`;
        // SortableJS を無効化
        if (restapiSortable) {
            restapiSortable.destroy();
            restapiSortable = null;
        }
        return;
    }

    tbody.innerHTML = '';

    triggers.forEach(t => {
        const tr = document.createElement('tr');
        tr.dataset.number = t.number;

        const vSenderLabel =
            resolveLabel(restMaterials,
                t.video_sender_id, 'sender');
        const vReceiverLabel =
            resolveLabel(restMaterials,
                t.video_receiver_id, 'receiver');
        const aSenderLabel =
            resolveLabel(restMaterials,
                t.audio_sender_id, 'sender');
        const aReceiverLabel =
            resolveLabel(restMaterials,
                t.audio_receiver_id, 'receiver');
        const ancSenderLabel =
            resolveLabel(restMaterials,
                t.anc_sender_id, 'sender');
        const ancReceiverLabel =
            resolveLabel(restMaterials,
                t.anc_receiver_id, 'receiver');

        const scBadge = t.keyboard_shortcut
            ? `<span class="restapi-shortcut-badge">
                   ${escHtml(t.keyboard_shortcut)}
               </span>`
            : `<span style="color:#444;">—</span>`;

        const hasShortcut = !!t.keyboard_shortcut;

        tr.innerHTML = `
        <td>
            <span class="restapi-drag-handle"
                  title="ドラッグで並び替え">⠿</span>
        </td>
        <td>
            <span class="restapi-num-badge">
                ${escHtml(t.number)}
            </span>
        </td>
        <td>
            <div class="restapi-label-text">
                ${escHtml(t.label)}
            </div>
            <div class="restapi-url-text">
                /api/trigger/${escHtml(t.number)}
                &nbsp;|&nbsp;
                /api/trigger/${escHtml(t.label)}
            </div>
        </td>
        <td>
            ${buildVaaCellHtml(
                vSenderLabel, vReceiverLabel)}
        </td>
        <td>
            ${buildVaaCellHtml(
                aSenderLabel, aReceiverLabel)}
        </td>
        <td>
            ${buildVaaCellHtml(
                ancSenderLabel, ancReceiverLabel)}
        </td>
        <td style="text-align:center;">
            ${scBadge}
        </td>
        <td>
            <div style="display:flex; gap:4px;">
                <button class="btn-icon"
                    onclick="openTriggerEditModal(
                        '${escAttr(t.number)}'
                    )" title="編集">✏</button>
                <button class="btn-icon ${
                    hasShortcut ? '' : 'dimmed'
                }"
                    onclick="openShortcutAssignModal(
                        '${escAttr(t.number)}',
                        '${escAttr(t.label)}'
                    )"
                    title="ショートカット割り当て">⌨</button>
                <button class="btn-icon"
                    onclick="testTrigger(
                        '${escAttr(t.number)}',
                        '${escAttr(t.label)}'
                    )" title="テスト実行">▶</button>
                <button class="btn-icon danger"
                    onclick="openTriggerDeleteModal(
                        '${escAttr(t.number)}',
                        '${escAttr(t.label)}'
                    )" title="削除">🗑</button>
            </div>
        </td>`;

        tbody.appendChild(tr);
    });

    // SortableJS 初期化
    initRestapiSortable();
}

function buildVaaCellHtml(senderLabel, receiverLabel) {
    const sHtml = senderLabel === 'leave'
        ? `<span class="restapi-leave">Leave</span>`
        : `<span class="restapi-sender">
               ${escHtml(senderLabel)}
           </span>`;

    const rHtml = receiverLabel === 'none'
        ? `<span class="restapi-none">None</span>`
        : `<span class="restapi-receiver">
               → ${escHtml(receiverLabel)}
           </span>`;

    return `<div class="restapi-vaa-cell">
                ${sHtml}${rHtml}
            </div>`;
}

// ------------------------------------------
// SortableJS 初期化
// ------------------------------------------
function initRestapiSortable() {
    const tbody =
        document.getElementById('restapi-tbody');
    if (!tbody) return;

    if (restapiSortable) {
        restapiSortable.destroy();
        restapiSortable = null;
    }

    // 検索中はD&D無効
    const searchVal =
        document.getElementById('restapi-search')
            ?.value || '';
    if (searchVal.trim()) return;

    if (typeof Sortable === 'undefined') return;

    restapiSortable = Sortable.create(tbody, {
        handle:    '.restapi-drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass:  'sortable-drag',
        onEnd: async (evt) => {
            await saveRestTriggerOrder();
        }
    });
}

// ------------------------------------------
// 並び替え保存
// ------------------------------------------
async function saveRestTriggerOrder() {
    const tbody =
        document.getElementById('restapi-tbody');
    if (!tbody) return;

    const rows = [...tbody.querySelectorAll('tr[data-number]')];
    const keys = rows.map(r => r.dataset.number);

    try {
        const resp = await fetch(
            '/api/rest-triggers/reorder', {
                method:  'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ keys })
            }
        );
        if (resp.ok) {
            showToast('並び順を保存しました', 'ok');
            await loadRestTriggers();
        } else {
            showToast('並び替え保存エラー', 'error');
        }
    } catch (e) {
        showToast(`エラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// 検索フィルター
// ------------------------------------------
function filterTriggers() {
    const q = (document.getElementById('restapi-search')
        ?.value || '').toLowerCase().trim();

    if (!q) {
        renderRestTriggers(restTriggers);
        return;
    }

    const filtered = restTriggers.filter(t =>
        t.number.includes(q) ||
        t.label.toLowerCase().includes(q)
    );
    renderRestTriggers(filtered);

    // 検索中はD&D無効
    if (restapiSortable) {
        restapiSortable.destroy();
        restapiSortable = null;
    }
}

// ------------------------------------------
// トリガー追加/編集モーダル
// ------------------------------------------
async function openTriggerCreateModal() {
    triggerEditingNumber = null;

    document.getElementById('trigger-modal-title')
        .textContent = '🔗 トリガーを追加';
    document.getElementById('trigger-label').value = '';
    document.getElementById('trigger-url-preview')
        .textContent = '';
    setDialogError('trigger-modal-error', '');

    await loadRestMaterials();
    buildTriggerSelects();
    resetTriggerSelects();

    document.getElementById('trigger-modal')
        .classList.add('open');
}

async function openTriggerEditModal(number) {
    triggerEditingNumber = number;

    document.getElementById('trigger-modal-title')
        .textContent = '✏ トリガーを編集';
    setDialogError('trigger-modal-error', '');

    await loadRestMaterials();
    buildTriggerSelects();

    // 既存データを取得して反映
    const trigger = restTriggers.find(
        t => t.number === number);
    if (!trigger) {
        showToast('トリガーが見つかりません', 'error');
        return;
    }

    document.getElementById('trigger-label').value
        = trigger.label;
    updateTriggerUrlPreview(trigger.label);

    setSelectValue(
        'trigger-video-sender',   trigger.video_sender_id);
    setSelectValue(
        'trigger-video-receiver', trigger.video_receiver_id);
    setSelectValue(
        'trigger-audio-sender',   trigger.audio_sender_id);
    setSelectValue(
        'trigger-audio-receiver', trigger.audio_receiver_id);
    setSelectValue(
        'trigger-anc-sender',     trigger.anc_sender_id);
    setSelectValue(
        'trigger-anc-receiver',   trigger.anc_receiver_id);

    document.getElementById('trigger-modal')
        .classList.add('open');
}

function closeTriggerModal() {
    document.getElementById('trigger-modal')
        .classList.remove('open');
    triggerEditingNumber = null;
}

// プルダウン構築
function buildTriggerSelects() {
    const m = restMaterials || {
        video: [], audio: [], ancillary: []
    };

    // Sender プルダウン（leave付き）
    const buildSender = (cat) => {
        let html =
            `<option value="leave">── Leave</option>`;
        const items = (m[cat] || []).filter(i =>
            i.resource_type === 'sender' ||
            i.source === 'sdp'
        );
        for (const item of items) {
            const rid = item.resource_id || item.id;
            html +=
                `<option value="${escAttr(rid)}">`
                + `${escHtml(item.label)}</option>`;
        }
        return html;
    };

    // Receiver プルダウン（none付き）
    const buildReceiver = (cat) => {
        let html =
            `<option value="none">── None</option>`;
        const items = (m[cat] || []).filter(i =>
            i.resource_type === 'receiver'
        );
        for (const item of items) {
            const rid = item.resource_id || item.id;
            html +=
                `<option value="${escAttr(rid)}">`
                + `${escHtml(item.label)}</option>`;
        }
        return html;
    };

    document.getElementById('trigger-video-sender')
        .innerHTML = buildSender('video');
    document.getElementById('trigger-video-receiver')
        .innerHTML = buildReceiver('video');
    document.getElementById('trigger-audio-sender')
        .innerHTML = buildSender('audio');
    document.getElementById('trigger-audio-receiver')
        .innerHTML = buildReceiver('audio');
    document.getElementById('trigger-anc-sender')
        .innerHTML = buildSender('ancillary');
    document.getElementById('trigger-anc-receiver')
        .innerHTML = buildReceiver('ancillary');
}

function resetTriggerSelects() {
    setSelectValue('trigger-video-sender',   'leave');
    setSelectValue('trigger-video-receiver', 'none');
    setSelectValue('trigger-audio-sender',   'leave');
    setSelectValue('trigger-audio-receiver', 'none');
    setSelectValue('trigger-anc-sender',     'leave');
    setSelectValue('trigger-anc-receiver',   'none');
}

function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    // 存在しない値の場合は先頭を選択
    if (el.value !== value) el.selectedIndex = 0;
}

// URL Keyプレビュー更新
function updateTriggerUrlPreview(label) {
    const el = document.getElementById(
        'trigger-url-preview');
    if (!el) return;
    if (label) {
        el.textContent =
            `/api/trigger/${label}`;
    } else {
        el.textContent = '';
    }
}

// URL Key入力時のリアルタイムプレビュー
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('trigger-label')
        ?.addEventListener('input', (e) => {
            updateTriggerUrlPreview(e.target.value);
            setDialogError('trigger-modal-error', '');
        });
});

// トリガー保存
async function saveTrigger() {
    const label =
        document.getElementById('trigger-label')
            .value.trim();

    if (!label) {
        setDialogError('trigger-modal-error',
            'URL Keyを入力してください');
        return;
    }

    const body = {
        label,
        video_sender_id:
            document.getElementById(
                'trigger-video-sender').value,
        video_receiver_id:
            document.getElementById(
                'trigger-video-receiver').value,
        audio_sender_id:
            document.getElementById(
                'trigger-audio-sender').value,
        audio_receiver_id:
            document.getElementById(
                'trigger-audio-receiver').value,
        anc_sender_id:
            document.getElementById(
                'trigger-anc-sender').value,
        anc_receiver_id:
            document.getElementById(
                'trigger-anc-receiver').value
    };

    try {
        let resp;
        if (triggerEditingNumber) {
            resp = await fetch(
                `/api/rest-triggers/${triggerEditingNumber}`,
                {
                    method:  'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body)
                }
            );
        } else {
            resp = await fetch('/api/rest-triggers', {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
        }

        const result = await resp.json();

        if (resp.status === 409) {
            setDialogError('trigger-modal-error',
                result.detail);
            return;
        }
        if (!resp.ok) {
            setDialogError('trigger-modal-error',
                result.detail || '保存エラー');
            return;
        }

        closeTriggerModal();
        showToast(result.message, 'ok');
        await loadRestTriggers();

    } catch (e) {
        setDialogError('trigger-modal-error',
            `保存エラー: ${e.message}`);
    }
}

// ------------------------------------------
// トリガー削除
// ------------------------------------------
function openTriggerDeleteModal(number, label) {
    triggerDeleteNumber = number;
    document.getElementById('trigger-delete-name')
        .textContent = `[${number}] ${label}`;
    document.getElementById('trigger-delete-modal')
        .classList.add('open');
}

function closeTriggerDeleteModal() {
    document.getElementById('trigger-delete-modal')
        .classList.remove('open');
    triggerDeleteNumber = null;
}

async function confirmDeleteTrigger() {
    if (!triggerDeleteNumber) return;

    try {
        const resp = await fetch(
            `/api/rest-triggers/${triggerDeleteNumber}`,
            { method: 'DELETE' }
        );
        const result = await resp.json();

        if (!resp.ok) {
            showToast(
                `削除エラー: ${result.detail}`, 'error'
            );
            return;
        }

        closeTriggerDeleteModal();
        showToast(result.message, 'ok');
        await loadRestTriggers();

    } catch (e) {
        showToast(`削除エラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// テスト実行
// ------------------------------------------
async function testTrigger(number, label) {
    const confirmed = await showConfirm(
        `[${number}] ${label} を実行しますか？\n`
        + `実際にTAKE/LEAVEが実行されます。`
    );
    if (!confirmed) return;

    try {
        const resp = await fetch(
            `/api/rest-triggers/${number}/test`,
            { method: 'POST' }
        );
        const result = await resp.json();

        if (resp.ok) {
            showToast(result.message, 'ok');
        } else {
            const errMsg = result.errors
                ? result.errors.join('\n')
                : result.message;
            showToast(
                `テスト実行エラー:\n${errMsg}`, 'error'
            );
        }
    } catch (e) {
        showToast(`テスト実行エラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// ショートカット割り当て
// ------------------------------------------
function openShortcutAssignModal(number, label) {
    shortcutAssignNumber = number;
    shortcutCapturedKey  = null;

    document.getElementById('shortcut-assign-label')
        .textContent = `[${number}] ${label}`;

    const display =
        document.getElementById('shortcut-key-display');
    display.textContent =
        '割り当てたいキーを押してください';
    display.classList.remove('has-key');

    // 現在の割り当てを確認
    const trigger = restTriggers.find(
        t => t.number === number);
    const currentKey = trigger?.keyboard_shortcut;

    const clearBtn =
        document.getElementById('shortcut-clear-btn');
    const saveBtn =
        document.getElementById('shortcut-save-btn');

    clearBtn.style.display = currentKey ? '' : 'none';
    saveBtn.style.display  = 'none';

    document.getElementById('shortcut-assign-modal')
        .classList.add('open');

    // キー入力リスナー登録
    document.addEventListener(
        'keydown', onShortcutKeyCapture);
}

function closeShortcutAssignModal() {
    document.getElementById('shortcut-assign-modal')
        .classList.remove('open');
    document.removeEventListener(
        'keydown', onShortcutKeyCapture);
    shortcutAssignNumber = null;
    shortcutCapturedKey  = null;
}

function onShortcutKeyCapture(e) {
    e.preventDefault();
    e.stopPropagation();

    // ESCでキャンセル
    if (e.key === 'Escape') {
        closeShortcutAssignModal();
        return;
    }

    // 修飾キー単独は無視
    if (['Shift', 'Control', 'Alt', 'Meta']
        .includes(e.key)) return;

    // キー名を生成
    let keyName = '';
    if (e.ctrlKey)  keyName += 'Ctrl+';
    if (e.altKey)   keyName += 'Alt+';
    if (e.shiftKey) keyName += 'Shift+';
    keyName += e.key.length === 1
        ? e.key.toUpperCase()
        : e.key;

    shortcutCapturedKey = keyName;

    const display =
        document.getElementById('shortcut-key-display');
    display.textContent = keyName;
    display.classList.add('has-key');

    document.getElementById('shortcut-save-btn')
        .style.display = '';
}

async function saveShortcut() {
    if (!shortcutAssignNumber ||
        !shortcutCapturedKey) return;

    try {
        const resp = await fetch(
            `/api/rest-triggers/${shortcutAssignNumber}`,
            {
                method:  'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    keyboard_shortcut: shortcutCapturedKey
                })
            }
        );
        const result = await resp.json();

        if (resp.status === 409) {
            showToast(result.detail, 'error');
            return;
        }
        if (!resp.ok) {
            showToast(
                `保存エラー: ${result.detail}`, 'error'
            );
            return;
        }

        closeShortcutAssignModal();
        showToast(
            `ショートカット「${shortcutCapturedKey}」を割り当てました`,
            'ok'
        );
        await loadRestTriggers();

    } catch (e) {
        showToast(`保存エラー: ${e.message}`, 'error');
    }
}

async function clearShortcut() {
    if (!shortcutAssignNumber) return;

    try {
        const resp = await fetch(
            `/api/rest-triggers/${shortcutAssignNumber}`,
            {
                method:  'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    keyboard_shortcut: ''
                })
            }
        );
        const result = await resp.json();

        if (!resp.ok) {
            showToast(
                `解除エラー: ${result.detail}`, 'error'
            );
            return;
        }

        closeShortcutAssignModal();
        showToast('ショートカットを解除しました', 'ok');
        await loadRestTriggers();

    } catch (e) {
        showToast(`解除エラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// ショートカット一覧モーダル
// ------------------------------------------
function openShortcutListModal() {
    const content =
        document.getElementById('shortcut-list-content');
    if (!content) return;

    const shortcuts = restTriggers.filter(
        t => t.keyboard_shortcut);

    if (shortcuts.length === 0) {
        content.innerHTML =
            `<div class="shortcut-list-empty">
                ショートカットが設定されていません。<br>
                各トリガーの ⌨ ボタンから設定できます。
            </div>`;
    } else {
        let html = `
        <table class="shortcut-list-table">
            <thead>
                <tr>
                    <th>キー</th>
                    <th>番号</th>
                    <th>URL Key</th>
                </tr>
            </thead>
            <tbody>`;

        for (const t of shortcuts) {
            html += `
            <tr>
                <td>
                    <span class="restapi-shortcut-badge">
                        ${escHtml(t.keyboard_shortcut)}
                    </span>
                </td>
                <td>
                    <span class="restapi-num-badge">
                        ${escHtml(t.number)}
                    </span>
                </td>
                <td>${escHtml(t.label)}</td>
            </tr>`;
        }

        html += `</tbody></table>`;
        content.innerHTML = html;
    }

    document.getElementById('shortcut-list-modal')
        .classList.add('open');
}

function closeShortcutListModal() {
    document.getElementById('shortcut-list-modal')
        .classList.remove('open');
}

// ==========================================
// 【番組ファイル機能】
// ==========================================

let programList        = [];       // 番組一覧キャッシュ
let programLoadTarget  = null;     // ロード対象番組名
let programPollTimer   = null;     // 進捗ポーリングタイマー

// ------------------------------------------
// 番組一覧 読み込み・描画
// ------------------------------------------
async function loadProgramList() {
    const tbody = document.getElementById('program-tbody');
    if (!tbody) return;
    tbody.innerHTML =
        '<tr><td colspan="5" class="program-empty">'
        + '読み込み中...</td></tr>';

    try {
        const resp = await fetch('/api/programs');
        if (!resp.ok) throw new Error(await resp.text());
        programList = await resp.json();
        renderProgramList();
    } catch (e) {
        tbody.innerHTML =
            `<tr><td colspan="5" class="program-empty">`
            + `読み込みエラー: ${escHtml(e.message)}</td></tr>`;
    }
}

function renderProgramList() {
    const tbody = document.getElementById('program-tbody');
    if (!tbody) return;

    if (programList.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="program-empty">'
            + '番組ファイルがありません。'
            + '「💾 新規保存」から作成してください。'
            + '</td></tr>';
        updateProgramToolbar();
        return;
    }

    tbody.innerHTML = '';
    programList.forEach(prog => {
        const tr = document.createElement('tr');
        tr.dataset.name = prog.name;

        const dt = prog.updated_at
            ? prog.updated_at.replace('T', ' ').slice(0, 16)
            : '—';

        tr.innerHTML = `
        <td class="col-check">
            <input type="checkbox" class="program-check"
                data-name="${escHtml(prog.name)}"
                onchange="onProgramCheckChange()">
        </td>
        <td class="program-name-cell">
            ${escHtml(prog.name)}
        </td>
        <td class="col-date program-date-cell">
            ${escHtml(dt)}
        </td>
        <td class="col-count program-count-cell">
            ${prog.count}件
        </td>
        <td class="col-actions">
            <div style="display:flex; gap:4px;">
                <button class="btn-icon"
                    onclick="openProgramLoadModal(
                        '${escAttr(prog.name)}'
                    )">▶ ロード</button>
                <button class="btn-icon danger"
                    onclick="deleteProgramConfirm(
                        '${escAttr(prog.name)}'
                    )">🗑</button>
            </div>
        </td>`;
        tbody.appendChild(tr);
    });

    updateProgramToolbar();
}

// ------------------------------------------
// チェックボックス制御
// ------------------------------------------
function onProgramCheckAll(checkbox) {
    document.querySelectorAll('.program-check')
        .forEach(cb => { cb.checked = checkbox.checked; });
    updateProgramToolbar();
}

function onProgramCheckChange() {
    const all   = document.querySelectorAll('.program-check');
    const checked = document.querySelectorAll(
        '.program-check:checked');
    const allCheck =
        document.getElementById('program-check-all');
    if (allCheck) {
        allCheck.indeterminate =
            checked.length > 0 &&
            checked.length < all.length;
        allCheck.checked = checked.length === all.length
            && all.length > 0;
    }
    updateProgramToolbar();
}

function getCheckedProgramNames() {
    return [...document.querySelectorAll(
        '.program-check:checked'
    )].map(cb => cb.dataset.name);
}

function updateProgramToolbar() {
    const checked  = getCheckedProgramNames();
    const overwrite =
        document.getElementById('btn-overwrite');
    const exportBtn =
        document.getElementById('btn-export-selected');

    // 上書き保存：チェック1件のみ有効
    if (overwrite) {
        overwrite.disabled = checked.length !== 1;
    }
    // エクスポート：1件以上で有効
    if (exportBtn) {
        exportBtn.disabled = checked.length === 0;
    }
}

// ------------------------------------------
// 新規保存
// ------------------------------------------
function openNewProgramModal() {
    const input =
        document.getElementById('program-new-name');
    if (input) input.value = '';
    clearProgramNewError();
    document.getElementById('program-new-modal')
        ?.classList.add('open');
    setTimeout(() => input?.focus(), 100);
}

function closeNewProgramModal() {
    document.getElementById('program-new-modal')
        ?.classList.remove('open');
}

function clearProgramNewError() {
    setDialogError('program-new-error', '');
}

async function saveNewProgram() {
    const name = document.getElementById(
        'program-new-name')?.value.trim();
    if (!name) {
        setDialogError('program-new-error',
            '番組名を入力してください');
        return;
    }

    // 保存ボタンを無効化（二重送信防止）
    const saveBtn = document.querySelector(
        '#program-new-modal .btn-primary');
    if (saveBtn) saveBtn.disabled = true;

    try {
        const resp = await fetch('/api/programs', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name })
        });
        const result = await resp.json();

        if (resp.status === 409) {
            setDialogError('program-new-error',
                result.detail);
            return;
        }
        if (!resp.ok) {
            setDialogError('program-new-error',
                result.detail || '保存エラー');
            return;
        }

        closeNewProgramModal();
        showToast(result.message, 'ok');
        await loadProgramList();

    } catch (e) {
        setDialogError('program-new-error',
            `保存エラー: ${e.message}`);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

// ------------------------------------------
// 上書き保存
// ------------------------------------------
async function overwriteProgram() {
    const checked = getCheckedProgramNames();
    if (checked.length !== 1) return;
    const name = checked[0];

    const confirmed = await showConfirm(
        `「${name}」を現在のIS-05接続状態で上書き保存します。\nよろしいですか？`
    );
    if (!confirmed) return;

    const btn = document.getElementById('btn-overwrite');
    if (btn) btn.disabled = true;

    try {
        const resp = await fetch(
            `/api/programs/${encodeURIComponent(name)}`,
            { method: 'PUT' }
        );
        const result = await resp.json();

        if (!resp.ok) {
            showToast(`上書き保存エラー: ${result.detail}`, 'error');
            return;
        }
        showToast(result.message, 'ok');
        await loadProgramList();

    } catch (e) {
        showToast(`上書き保存エラー: ${e.message}`, 'error');
    } finally {
        updateProgramToolbar();
    }
}

// ------------------------------------------
// インポート
// ------------------------------------------
function openImportProgram() {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await doImportProgram(file, false);
    };
    input.click();
}

async function doImportProgram(file, force) {
    const url = force
        ? '/api/programs/import/force'
        : '/api/programs/import';

    const formData = new FormData();
    formData.append('file', file);

    try {
        const resp = await fetch(url, {
            method: 'POST',
            body:   formData
        });
        const result = await resp.json();

        if (resp.status === 409) {
            // 同名ファイル存在 → 上書き確認
            const confirmed = await showConfirm(
                `${result.detail}\n上書きしますか？`
            );
            if (confirmed) {
                await doImportProgram(file, true);
            }
            return;
        }

        if (!resp.ok) {
            showToast(
                `インポートエラー: ${result.detail}`, 'error'
            );
            return;
        }

        showToast(result.message, 'ok');
        await loadProgramList();

    } catch (e) {
        showToast(`インポートエラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// エクスポート（チェック選択分）
// ------------------------------------------
async function exportSelectedPrograms() {
    const checked = getCheckedProgramNames();
    if (checked.length === 0) return;

    // 1件ずつ順番にダウンロード
    for (const name of checked) {
        const a    = document.createElement('a');
        a.href     =
            `/api/programs/${encodeURIComponent(name)}/export`;
        a.download = `${name}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // 複数ファイルの場合は少し間隔を開ける
        if (checked.length > 1) {
            await new Promise(r => setTimeout(r, 300));
        }
    }
}

// ------------------------------------------
// 削除
// ------------------------------------------
async function deleteProgramConfirm(name) {
    const confirmed = await showConfirm(
        `「${name}」を削除しますか？\nこの操作は元に戻せません。`
    );
    if (!confirmed) return;

    try {
        const resp = await fetch(
            `/api/programs/${encodeURIComponent(name)}`,
            { method: 'DELETE' }
        );
        const result = await resp.json();

        if (!resp.ok) {
            showToast(
                `削除エラー: ${result.detail}`, 'error'
            );
            return;
        }
        showToast(result.message, 'ok');
        await loadProgramList();

    } catch (e) {
        showToast(`削除エラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// ロード（呼出）
// ------------------------------------------
function openProgramLoadModal(name) {
    programLoadTarget = name;
    const el = document.getElementById('program-load-name');
    if (el) el.textContent = name;
    document.getElementById('program-load-modal')
        ?.classList.add('open');
}

function closeProgramLoadModal() {
    document.getElementById('program-load-modal')
        ?.classList.remove('open');
    programLoadTarget = null;
}

async function confirmProgramLoad() {
    if (!programLoadTarget) {
        showToast('番組が選択されていません', 'error');
        return;
    }
    const targetName = programLoadTarget;  // ← コピーして使用
    closeProgramLoadModal();
    try {
        const resp = await fetch(
            `/api/programs/${encodeURIComponent(targetName)}/load`,


            { method: 'POST' }
        );
        const result = await resp.json();

        // 整合チェックエラー
        if (resp.status === 422) {
            showProgramErrorModal(result.errors || []);
            return;
        }

        if (!resp.ok) {
            showToast(
                `ロードエラー: ${result.detail}`, 'error'
            );
            return;
        }

        // 進捗表示開始
        showProgramProgress();
        startProgressPolling();
        showToast(result.message, 'ok');

    } catch (e) {
        showToast(`ロードエラー: ${e.message}`, 'error');
    }
}

// ------------------------------------------
// バリデーションエラーモーダル
// ------------------------------------------
function showProgramErrorModal(errors) {
    const list =
        document.getElementById('program-error-list');
    if (list) {
        list.innerHTML = errors
            .map(e => `• ${escHtml(e)}`)
            .join('<br>');
    }
    document.getElementById('program-error-modal')
        ?.classList.add('open');
}

function closeProgramErrorModal() {
    document.getElementById('program-error-modal')
        ?.classList.remove('open');
}

// ------------------------------------------
// 進捗表示
// ------------------------------------------
function showProgramProgress() {
    const el = document.getElementById('program-progress');
    if (el) el.style.display = 'flex';
}

function hideProgramProgress() {
    const el = document.getElementById('program-progress');
    if (el) el.style.display = 'none';
}

function updateProgressUI(status) {
    const text  =
        document.getElementById('program-progress-text');
    const count =
        document.getElementById('program-progress-count');
    const bar   =
        document.getElementById('program-progress-bar');

    if (status.aborted) {
        if (text)  text.textContent  = '中止しました';
    } else if (!status.running && status.current >= status.total) {
        if (text)  text.textContent  = 'ロード完了！';
    } else {
        if (text)  text.textContent  =
            `Source情報送信中... ${status.current_label}`;
    }

    if (count) {
        count.textContent =
            `${status.current} / ${status.total}`;
    }

    if (bar && status.total > 0) {
        const pct =
            Math.round((status.current / status.total) * 100);
        bar.style.width = `${pct}%`;
    }
}

// ------------------------------------------
// 進捗ポーリング
// ------------------------------------------
function startProgressPolling() {
    stopProgressPolling();
    programPollTimer = setInterval(async () => {
        try {
            const resp =
                await fetch('/api/programs/load/status');
            if (!resp.ok) return;
            const status = await resp.json();

            updateProgressUI(status);

            // 完了 or 中止
            if (!status.running) {
                stopProgressPolling();
                setTimeout(() => {
                    hideProgramProgress();
                    if (status.aborted) {
                        showToast('ロードを中止しました', 'warn');
                    } else {
                        showToast('ロード完了しました', 'ok');
                    }
                }, 2000);
            }
        } catch (e) {
            console.error('進捗取得エラー:', e);
        }
    }, 1000);
}

function stopProgressPolling() {
    if (programPollTimer) {
        clearInterval(programPollTimer);
        programPollTimer = null;
    }
}

// ------------------------------------------
// ロード中止
// ------------------------------------------
async function abortProgramLoad() {
    try {
        await fetch('/api/programs/load/abort',
            { method: 'POST' });
    } catch (e) {
        console.error('中止エラー:', e);
    }
}

// ------------------------------------------
// タブ切り替え時の初期化（既存switchTabに統合）
// ------------------------------------------
// ※ 既存の switchTab 関数に以下の1行を追加してください：
//   if (tabId === 'program') loadProgramList();
// switchTab関数内の該当箇所に追記します
const _origSwitchTab = switchTab;
switchTab = function(tabId) {
    _origSwitchTab(tabId);
    if (tabId === 'program') {
        stopProgressPolling();   // ← 追加
        loadProgramList();
    }
};