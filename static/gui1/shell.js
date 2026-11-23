// shell.js - 枠ページ（Control / Node GUI / System のタブ切替）
//
// 各画面は iframe として保持し、タブ切替で表示/非表示を切り替える
// （各画面の選択状態・絞り込み等はタブを切り替えても保持される）。
//   - Controlタブへ戻ったとき : Control画面を再読み込みする
//       （Node GUI / Systemでの素材登録・編集を反映するため。
//         従来の「← 戻る」でGUI①を再読み込みしていた動作の置き換え）
//   - Node GUI / Systemタブを開いたとき : 各画面の一覧のみ読み直す
//       （各画面の window.onShellShow() を呼ぶ）
//   - 表示中のタブはURL末尾（#control / #node / #system）に保持する

const SHELL_TABS = {
    control: { label: 'Control',  src: '/static/gui1/control.html' },
    node:    { label: 'Node GUI', src: '/node/' },
    system:  { label: 'System',   src: '/system/' }
};
const DEFAULT_TAB = 'control';

let currentTab = null;

function getFrame(key) {
    return document.getElementById(`frame-${key}`);
}

function switchShellTab(key) {
    if (!SHELL_TABS[key]) key = DEFAULT_TAB;
    if (key === currentTab) {
        focusFrame(getFrame(key));
        return;
    }

    const prevTab = currentTab;
    currentTab = key;

    // タブボタン・iframeの表示切替
    document.querySelectorAll('.shell-tab').forEach(btn => {
        const active = btn.dataset.tab === key;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.shell-frame').forEach(frame => {
        frame.classList.toggle('active', frame.dataset.tab === key);
    });

    const frame = getFrame(key);
    if (!frame.getAttribute('src')) {
        // 初めて開くタブ：ここで読み込む
        frame.src = SHELL_TABS[key].src;
    } else if (key === 'control' && prevTab !== null) {
        // Controlへ戻ったとき：再読み込み
        reloadFrame(frame);
    } else {
        // Node GUI / System：一覧のみ読み直す
        try {
            const fn = frame.contentWindow?.onShellShow;
            if (typeof fn === 'function') fn();
        } catch (e) {
            console.error('[Shell] 一覧の読み直しエラー:', e);
        }
    }

    document.title = `NMOS Controller - ${SHELL_TABS[key].label}`;
    history.replaceState(null, '', `#${key}`);
    focusFrame(frame);
}

function reloadFrame(frame) {
    try {
        frame.contentWindow.location.reload();
    } catch (e) {
        frame.src = frame.getAttribute('src');
    }
}

// iframe内にフォーカスを移す
// （Control画面のキーボードショートカットはiframe内にフォーカスが
//   無いと反応しないため）
function focusFrame(frame) {
    try {
        frame?.contentWindow?.focus();
    } catch (e) {
        // 読み込み前などは無視（load時に再度フォーカスする）
    }
}

function getTabFromHash() {
    const key = location.hash.replace('#', '');
    return SHELL_TABS[key] ? key : DEFAULT_TAB;
}

document.addEventListener('DOMContentLoaded', () => {
    // 読み込み完了した画面が表示中ならフォーカスを移す
    document.querySelectorAll('.shell-frame').forEach(frame => {
        frame.addEventListener('load', () => {
            if (frame.dataset.tab === currentTab) focusFrame(frame);
        });
    });

    switchShellTab(getTabFromHash());
});

// URL末尾（#node 等）を手で書き換えた場合にも追従する
window.addEventListener('hashchange', () => {
    switchShellTab(getTabFromHash());
});
