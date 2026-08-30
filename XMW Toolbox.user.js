// ==UserScript==
// @name         XMW Toolbox
// @version      2.1.0
// @description  使你的小码王更易于使用
// @author       RSPqfgn
// @match        https://world.xiaomawang.com/*
// @icon         https://world.xiaomawang.com/favicon.ico
// @license      GNU GPLv3
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/marked@12/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js
// @updateURL    https://raw.githubusercontent.com/RSPqfgn/XMW-Toolbox/main/XMW%20Toolbox.user.js
// @downloadURL  https://raw.githubusercontent.com/RSPqfgn/XMW-Toolbox/main/XMW%20Toolbox.user.js
// @run-at       document-idle
// ==/UserScript==

/**
 * ============================================================
 *  XMW Toolbox 架构说明
 * ------------------------------------------------------------
 *  META / SELECTORS   元信息与站点选择器集中管理（CSS 类名带哈希，
 *                     优先用 [class*="前缀"] 匹配以抵抗哈希变化）
 *  Util               通用工具函数
 *  Watcher            中央 DOM 监听器（MutationObserver + 低频兜底轮询，
 *                     替代原先散落各处的 setInterval）
 *  Settings           声明式设置系统：功能注册设置项，设置界面自动生成，
 *                     支持变更回调（悬浮球显隐 / 大小即时生效），
 *                     并自动迁移 v1 的旧版配置
 *  UI                 内置 UI 组件（Shadow DOM 弹窗 / 确认框 / Toast，
 *                     替代外部依赖 SweetAlert2，样式与站点完全隔离）
 *  Menu               油猴菜单注册表（扩展可通过 API 追加条目）
 *  Features           功能注册表：每个功能是独立模块，声明自己的设置项
 *  AutoTask           自动任务：持久化状态机（步骤队列 + runId 标签页隔离），
 *                     在单个标签页内跨页面自动完成签到 / 点赞 / 收藏 / 发布
 *  Panels             内置面板（自动任务 / 查询 / 设置）
 *  悬浮球             可拖动、记忆位置的工具入口
 *  扩展 API           unsafeWindow.XMWToolbox，供未来扩展系统使用
 * ============================================================
 */

(function () {
    'use strict';

    /* ==========================================================
     * 0. 元信息与选择器
     * ======================================================== */

    const META = {
        name: 'XMW Toolbox',
        get version() { return GM_info.script.version; },
        author: 'RSPqfgn',
        license: 'GNU GPLv3',
        repo: 'https://github.com/RSPqfgn/XMW-Toolbox',
        issues: 'https://github.com/RSPqfgn/XMW-Toolbox/issues',
        authorLink: 'https://github.com/RSPqfgn/',
    };

    const ORIGIN = 'https://world.xiaomawang.com';

    const SELECTORS = {
        receiveButton: '[class*="taskReceiveReward"]',
        signInButton: "//div[contains(@class,'goTaskCenter') and text()='签到']",
        moreComments: '[class*="more-comment-icon"]',
        moreReplies: 'span[class*="reply-more-button-text"]',
        seeMore: '[class*="seeMore"]',
        messageCount: '[class*="message-count"]',
        dynamicRedDot: '[class*="dynamic-red-dot"]',
        taskCenterBadgeA: '//*[@id="header"]/div/div/div[1]/div/div/div/ul/li[4]/a/span/sup',
        taskCenterBadgeB: '//*[@id="__next"]/div[2]/div[2]/div[2]/div[3]/div[1]/div[2]/span/sup',
        avatarFrame: '[class*="headDecoration"], [class*="decorationImg"]',
        magicReview: '.outer__3SbsJ',
        workMenu: 'ul[class*="work-item-copy"]',
        // 自动任务使用
        taskItem: '[class*="taskItem"]',
        taskName: '[class*="taskName"]',
        taskAction: '[class*="taskAction"]',
        workLinkBox: '[class*="workNameNoLinkBox"] a[href]',
        likeButton: '[class*="infoBtnMain"]',
        collectButton: '[class*="textCollectBtn"]',
        editorPublishButton: '[class*="menu-bar-button-publish"]',
        releaseTitle: '#title',
        releaseDescription: '#description',
        releaseSubmit: '.ant-btn.ant-btn-primary',
        // 查询功能解析页面时使用
        pageErrorA: '.title__3aW-0',
        pageErrorB: '.title__3tuHf',
        // Markdown 功能使用
        commentText: '[class*="comment-text"]',
        introItem: '[class*="intro-item"]',
    };

    /* 任务中心操作按钮的 class 片段（类名含构建哈希，取稳定部分匹配） */
    const TASK_ACTION_CLASS = {
        finished: 'taskFinished',       // 任务已完成
        active: 'activeTaskAction',     // 任务待完成
        receive: 'taskReceiveReward',   // 已完成待领奖
    };

    const log = {
        info: (...args) => console.info('[XMW Toolbox]', ...args),
        warn: (...args) => console.warn('[XMW Toolbox]', ...args),
        error: (...args) => console.error('[XMW Toolbox]', ...args),
    };

    /* ==========================================================
     * 1. 工具函数
     * ======================================================== */

    /**
     * 创建元素的辅助函数。
     * @param {string} tag 标签名
     * @param {object} props 属性：class / dataset / style(对象) / onXxx(事件) / 其他
     * @param {...(Node|string|null|Array)} children 子节点（自动展开数组）
     */
    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value == null) continue;
            if (key === 'class') el.className = value;
            else if (key === 'dataset') Object.assign(el.dataset, value);
            else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
            else if (key in el && typeof value !== 'string') el[key] = value;
            else el.setAttribute(key, value);
        }
        for (const child of children.flat(Infinity)) {
            if (child == null || child === false) continue;
            el.append(child.nodeType ? child : document.createTextNode(String(child)));
        }
        return el;
    }

    /** 通过 GM_xmlhttpRequest 发起 GET 请求，返回 Promise<Response> */
    function gmFetch(url, { timeout = 10000 } = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout,
                onload: resolve,
                onerror: () => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('请求超时')),
            });
        });
    }

    /** 校验响应状态码，失败时抛错 */
    function ensureOk(response) {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        return response;
    }

    /** 解析 HTML 文本为 Document */
    function parseHtml(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    /** 静默请求（只用于触发服务端状态，如清除未读） */
    function silentFetch(url) {
        gmFetch(url).catch(err => log.warn(`静默请求失败：${url}`, err));
    }

    /** 等待指定毫秒 */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 轮询等待 fn() 返回真值。
     * @returns {Promise<*>} fn 的返回值
     * @throws {Error} 超时
     */
    async function waitFor(fn, { timeout = 10000, interval = 200 } = {}) {
        const deadline = Date.now() + timeout;
        for (;;) {
            let result = null;
            try { result = fn(); } catch { /* 下次重试 */ }
            if (result) return result;
            if (Date.now() > deadline) throw new Error(`等待超时（${Math.round(timeout / 1000)}s）`);
            await sleep(interval);
        }
    }

    /** 等待选择器命中文档 */
    function waitForSelector(selector, options) {
        return waitFor(() => document.querySelector(selector), options);
    }

    /**
     * 设置 React 受控输入的值：原生 setter + input/change 事件。
     * 直接改 el.value 不会更新 React 状态。
     */
    function setReactValue(el, value) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /* 共享的视口可见性观察器：元素进入屏幕后执行一次回调 */
    const visibleCallbacks = new WeakMap();
    const visibilityObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            visibilityObserver.unobserve(entry.target);
            visibleCallbacks.get(entry.target)?.(entry.target);
        }
    }, { threshold: 0.5 });

    /** 等元素在屏幕中可见后再执行回调（用于「更多评论」等按需加载按钮，避免连锁展开导致页面卡顿） */
    function whenVisible(el, callback) {
        visibleCallbacks.set(el, callback);
        visibilityObserver.observe(el);
    }

    /* ==========================================================
     * Markdown（marked + DOMPurify 由 @require 提供）
     * ======================================================== */

    /** 将裸 URL 转为显式 Markdown 链接。marked 的 GFM 自动链接会把 URL 后
     *  紧跟的中文一并识别进链接，这里手动按 ASCII 边界截取。前置字符排除
     *  引号 / 等号 / 尖括号 / 圆括号 / 方括号 / 反引号，避免破坏已有的
     *  [文本](链接)、<autolink>、HTML 属性和行内代码 */
    function autolinkBareUrls(text) {
        return text.replace(/(^|[^"'=<([`])(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+)/gm,
            (m, pre, url) => {
                const link = url.replace(/[.,;:!?*_~'"]+$/, '');  // 句末标点不属于链接
                return `${pre}[${link}](${link})`;
            });
    }

    /** 只有一段时去掉 <p> 包裹：评论区正文多为单段文本，保留 <p> 会引入
     *  原有布局没有的段间距，看起来像多了一个空行 */
    function unwrapSingleParagraph(html) {
        return html.replace(/^<p>((?:(?!<\/p>)[\s\S])*)<\/p>\s*$/, '$1');
    }

    /** 将 Markdown 文本渲染为安全 HTML（marked 解析 + DOMPurify 消毒，防 XSS） */
    function renderMarkdown(text) {
        const html = marked.parse(autolinkBareUrls(text ?? ''), { gfm: true, breaks: true });
        return unwrapSingleParagraph(DOMPurify.sanitize(html));
    }

    /** 渲染元素内的 Markdown；元素的子节点（"置顶"角标、表情图片等）原样
     *  保留，不会因取 textContent 而丢失标签和样式 */
    function renderElementMarkdown(el) {
        // 子元素替换为占位符文本参与解析，渲染后再原位换回
        const tokens = [...el.children].map((child, i) => {
            const token = `xmwmd${i}x`;
            child.replaceWith(document.createTextNode(token));
            return [token, child];
        });
        el.classList.add('xmw-md-body');
        el.innerHTML = renderMarkdown(el.textContent);
        for (const [token, child] of tokens) restoreToken(el, token, child);
        el.dataset.xmwMdRendered = '1';
    }

    /** 把占位符文本替换回对应的元素节点 */
    function restoreToken(root, token, element) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const targets = [];
        while (walker.nextNode()) {
            if (walker.currentNode.textContent.includes(token)) targets.push(walker.currentNode);
        }
        for (const node of targets) {
            const text = node.textContent;
            const idx = text.indexOf(token);
            const frag = document.createDocumentFragment();
            if (idx > 0) frag.append(document.createTextNode(text.slice(0, idx)));
            frag.append(element);
            if (idx + token.length < text.length) frag.append(document.createTextNode(text.slice(idx + token.length)));
            node.replaceWith(frag);
        }
    }

    /* Markdown 功能的页面级样式（渲染内容在站点 DOM 内，Shadow DOM 隔离不到） */
    const PAGE_CSS = `
        /* white-space 强制正常：评论区容器多为 pre-wrap，会把 marked 输出中
           块级标签之间的换行文本节点渲染成多余空行；Markdown 的换行已由
           breaks: true 转成 <br>，无需保留原始空白 */
        .xmw-md-body { line-height: 1.7; word-break: break-word; white-space: normal; }
        .xmw-md-body > :first-child { margin-top: 0; }
        .xmw-md-body > :last-child { margin-bottom: 0; }
        .xmw-md-body h1, .xmw-md-body h2, .xmw-md-body h3,
        .xmw-md-body h4, .xmw-md-body h5, .xmw-md-body h6 { margin: 0.6em 0 0.4em; line-height: 1.4; }
        .xmw-md-body h1 { font-size: 1.5em; }
        .xmw-md-body h2 { font-size: 1.3em; }
        .xmw-md-body h3 { font-size: 1.15em; }
        .xmw-md-body p { margin: 0.4em 0; }
        .xmw-md-body code { padding: 0.15em 0.4em; border-radius: 4px; background: rgba(0, 0, 0, 0.06); font-size: 0.9em; font-family: Consolas, Monaco, 'Courier New', monospace; }
        .xmw-md-body pre { margin: 0.6em 0; padding: 0.8em 1em; border-radius: 8px; background: rgba(0, 0, 0, 0.06); overflow-x: auto; }
        .xmw-md-body pre code { padding: 0; background: none; }
        .xmw-md-body blockquote { margin: 0.6em 0; padding: 0.2em 1em; border-left: 3px solid #ffa31a; border-radius: 2px; background: rgba(255, 163, 26, 0.08); color: #666; }
        .xmw-md-body ul, .xmw-md-body ol { margin: 0.4em 0; padding-left: 1.6em; }
        .xmw-md-body img { max-width: 100%; border-radius: 8px; }
        .xmw-md-body a { color: #e88b00; }
        .xmw-md-body hr { margin: 1em 0; border: none; border-top: 1px solid rgba(0, 0, 0, 0.12); }
        .xmw-md-body table { margin: 0.6em 0; border-collapse: collapse; }
        .xmw-md-body th, .xmw-md-body td { padding: 0.3em 0.7em; border: 1px solid rgba(0, 0, 0, 0.15); }

        .xmw-mde-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin-bottom: 4px; }
        .xmw-mde-btn { padding: 5px 8px; border: none; border-radius: 6px; background: transparent; color: #666; font-size: 13px; line-height: 1; cursor: pointer; transition: background 0.2s ease, color 0.2s ease; }
        .xmw-mde-btn:hover { background: rgba(255, 163, 26, 0.12); color: #e88b00; }
        .xmw-mde-toggle { margin-left: auto; font-weight: 600; }
        .xmw-mde-toggle.xmw-mde-active { background: rgba(255, 163, 26, 0.18); color: #e88b00; }
        .xmw-mde-preview { margin-bottom: 4px; padding: 8px 12px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 8px; background: rgba(0, 0, 0, 0.02); max-height: 400px; overflow-y: auto; }
    `;

    let pageCssInjected = false;
    /** 向页面注入 Markdown 相关样式（一次性） */
    function injectPageCss() {
        if (pageCssInjected) return;
        pageCssInjected = true;
        document.head.append(h('style', { id: 'xmw-md-style' }, PAGE_CSS));
    }

    /* Markdown 编辑器工具栏动作 */
    const MDE_ACTIONS = [
        { label: 'B', title: '粗体', style: 'font-weight:700', left: '**', right: '**' },
        { label: 'I', title: '斜体', style: 'font-style:italic', left: '*', right: '*' },
        { label: 'S', title: '删除线', style: 'text-decoration:line-through', left: '~~', right: '~~' },
        { label: '‹/›', title: '行内代码', left: '`', right: '`' },
        { label: '{ }', title: '代码块', left: '\n```\n', right: '\n```\n' },
        { label: '链接', title: '链接', left: '[', right: '](https://)' },
        { label: '图片', title: '图片', left: '![', right: '](图片链接)' },
        { label: '引用', title: '引用', line: '> ' },
        { label: '• 列表', title: '无序列表', line: '- ' },
        { label: '1. 列表', title: '有序列表', line: '1. ' },
        { label: 'H', title: '标题', line: '## ' },
    ];

    /** 点击任务中心所有「领取」按钮，直到无剩余或超时，返回点击次数 */
    async function clickAllReceiveButtons({ timeout = 6000 } = {}) {
        const deadline = Date.now() + timeout;
        let clicked = 0;
        while (Date.now() < deadline) {
            const buttons = [...document.querySelectorAll(SELECTORS.receiveButton)]
                .filter(el => el.textContent.trim() === '领取');
            if (!buttons.length) break;
            for (const button of buttons) {
                button.click();
                clicked += 1;
                await sleep(300);
            }
            await sleep(500);
        }
        return clicked;
    }

    /**
     * 执行签到：循环点击首页「签到」入口，直到页面出现「已领取」或超时。
     * 供「自动签到」功能与自动任务的签到步骤共用。
     * @returns {Promise<boolean>} 是否确认签到成功
     */
    async function performSignIn({ timeout = 5 * 60 * 1000 } = {}) {
        const deadline = Date.now() + timeout;
        for (;;) {
            if (document.body?.textContent.includes('已领取')) return true;
            if (Date.now() > deadline) return false;
            Watcher.xpath(SELECTORS.signInButton)?.click();
            await sleep(1000);
        }
    }

    /* 内置 SVG 图标（静态可信内容）；描边图标用 currentColor 跟随文字颜色 */
    const ICONS = {
        query: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        tasks: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        cube: '<polygon points="12 2 20.7 7 12 12 3.3 7" fill-opacity="0.95"/><polygon points="3.3 7 12 12 12 22 3.3 17" fill-opacity="0.6"/><polygon points="20.7 7 12 12 12 22 20.7 17" fill-opacity="0.85"/>',
    };

    /** 创建 SVG 图标元素 */
    function svgIcon(name) {
        const container = h('span', { class: 'xt-icon', 'aria-hidden': 'true' });
        const attrs = name === 'cube'
            ? 'fill="currentColor"'
            : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
        container.innerHTML = `<svg viewBox="0 0 24 24" ${attrs}>${ICONS[name]}</svg>`;
        return container;
    }

    /* ==========================================================
     * 2. Watcher —— 中央 DOM 监听器
     * ----------------------------------------------------------
     * watch(selector, callback, options)
     *   - MutationObserver 提供即时响应，1s 兜底轮询保证状态变化感知
     *     （例如元素未重新插入但文本发生变化）。
     *   - options.cooldown：同一元素的两次回调最小间隔（毫秒），
     *     供"自动点击"类功能防止抖动。
     *   - options.once：每个元素只回调一次（配合 data 标记自行去重）。
     * ======================================================== */

    const Watcher = (() => {
        const listeners = new Set();
        let observer = null;
        let ticker = null;

        function trigger(listener, el) {
            if (listener.once && listener.seen.has(el)) return;
            const last = listener.lastCall.get(el) || 0;
            const now = Date.now();
            if (now - last < listener.cooldown) return;
            listener.lastCall.set(el, now);
            if (listener.once) listener.seen.add(el);
            try {
                listener.callback(el);
            } catch (err) {
                log.error(`Watcher 回调执行失败（${listener.selector}）：`, err);
            }
        }

        function scanSelector(listener) {
            if (!document.documentElement) return;
            document.querySelectorAll(listener.selector).forEach(el => trigger(listener, el));
        }

        function scanAddedNode(listener, node) {
            if (node.nodeType !== Node.ELEMENT_NODE || !node.matches) return;
            if (node.matches(listener.selector)) trigger(listener, node);
            node.querySelectorAll(listener.selector).forEach(el => trigger(listener, el));
        }

        function ensureTimers() {
            if (observer) return;
            observer = new MutationObserver(mutations => {
                for (const listener of listeners) {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) scanAddedNode(listener, node);
                    }
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            ticker = setInterval(() => listeners.forEach(scanSelector), 1000);
        }

        return {
            watch(selector, callback, { cooldown = 0, once = false } = {}) {
                const listener = {
                    selector, callback, cooldown, once,
                    lastCall: new WeakMap(),
                    seen: new WeakSet(),
                };
                listeners.add(listener);
                ensureTimers();
                scanSelector(listener);
                return () => listeners.delete(listener);
            },

            /** 定时执行（用于 XPath 定位等无法用选择器表达的场景） */
            every(ms, fn) {
                const timer = setInterval(() => {
                    try { fn(); } catch (err) { log.error('定时任务执行失败：', err); }
                }, ms);
                return () => clearInterval(timer);
            },

            /** 单次 XPath 查询 */
            xpath(expression) {
                return document.evaluate(
                    expression, document, null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
            },
        };
    })();

    /* ==========================================================
     * 3. Settings —— 声明式设置系统
     * ----------------------------------------------------------
     * 每个功能通过 Settings.defineGroup / Features.register 声明
     * 设置项，设置界面据此自动生成，新增设置无需改界面代码。
     * 存储为单个 JSON 对象；首次运行时自动从 v1 的散键迁移。
     * set() 会触发 onChange 回调，使悬浮球等控件无需刷新即时生效。
     * ======================================================== */

    const SETTINGS_KEY = 'toolbox.settings';

    const Settings = {
        groups: [],
        schema: [],
        cache: {},
        _listeners: {},

        defineGroup(group) {
            if (!this.groups.some(g => g.id === group.id)) this.groups.push(group);
        },

        define(defs) {
            for (const def of defs) {
                if (!this.schema.some(d => d.key === def.key)) this.schema.push(def);
                if (this.cache[def.key] === undefined) this.cache[def.key] = def.default;
            }
        },

        load() {
            const stored = GM_getValue(SETTINGS_KEY, null);
            if (stored && typeof stored === 'object') Object.assign(this.cache, stored);

            // 从 v1 散键迁移旧设置；不再使用的旧键直接清理
            const deprecatedKeys = ['autoCheckUpdate', 'lastUpdateCheck', 'autoShowAnnouncement', 'lastAnnouncementDate'];
            for (const def of this.schema) {
                if (this.cache[def.key] === undefined) {
                    const legacy = GM_getValue(def.key, undefined);
                    if (legacy !== undefined) this.cache[def.key] = legacy;
                }
                if (typeof GM_deleteValue === 'function') GM_deleteValue(def.key);
            }
            for (const key of deprecatedKeys) {
                if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
            }

            // 补齐缺失项的默认值
            for (const def of this.schema) {
                if (this.cache[def.key] === undefined) this.cache[def.key] = def.default;
            }
            this.save();
        },

        get(key) { return this.cache[key]; },

        set(key, value) {
            this.cache[key] = value;
            this.save();
            for (const fn of this._listeners[key] ?? []) {
                try { fn(value); } catch (err) { log.error(`设置变更回调失败（${key}）：`, err); }
            }
        },

        onChange(key, fn) {
            (this._listeners[key] ??= []).push(fn);
        },

        reset() {
            this.cache = {};
            for (const def of this.schema) this.cache[def.key] = def.default;
            this.save();
            for (const def of this.schema) {
                for (const fn of this._listeners[def.key] ?? []) {
                    try { fn(this.cache[def.key]); } catch (err) { log.error(err); }
                }
            }
        },

        save() { GM_setValue(SETTINGS_KEY, this.cache); },
    };

    /* ==========================================================
     * 4. UI —— Shadow DOM 弹窗 / 确认框 / Toast
     * ----------------------------------------------------------
     * 所有 UI 挂载在独立的 Shadow Root 中，与站点样式互不干扰；
     * 不再依赖 SweetAlert2 等外部库。
     * ======================================================== */

    const SHADOW_CSS = `
        :host { all: initial; }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host, .xt-overlay {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                "PingFang SC", "Microsoft YaHei", sans-serif;
        }

        /* ---------- 弹窗 ---------- */
        .xt-overlay {
            position: fixed; inset: 0; z-index: 2147483000;
            display: flex; align-items: center; justify-content: center;
            background: rgba(17, 24, 39, 0.5);
            animation: xt-fade 0.15s ease both;
        }
        .xt-dialog {
            display: flex; flex-direction: column;
            max-height: min(680px, calc(100vh - 48px));
            min-width: 320px;
            background: #fff; border-radius: 14px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.08);
            color: #1f2329; font-size: 14px; line-height: 1.6;
            overflow: hidden;
            animation: xt-pop 0.2s cubic-bezier(0.34, 1.4, 0.44, 1) both;
        }
        @keyframes xt-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes xt-pop {
            from { opacity: 0; transform: translateY(12px) scale(0.97); }
            to   { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
            .xt-overlay, .xt-dialog, .xt-toast, .xt-ball-menu {
                animation: none !important; transition: none !important;
            }
        }
        .xt-dialog__header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 18px 20px 10px;
        }
        .xt-dialog__title { font-size: 17px; font-weight: 600; }
        .xt-dialog__close {
            display: flex; align-items: center; justify-content: center;
            width: 28px; height: 28px; border: none; border-radius: 8px;
            background: transparent; color: #8f959e; font-size: 16px;
            cursor: pointer; transition: background 0.15s, color 0.15s;
        }
        .xt-dialog__close:hover { background: #f2f3f5; color: #1f2329; }
        .xt-dialog__body { padding: 4px 20px 18px; overflow-y: auto; }
        .xt-dialog__body::-webkit-scrollbar { width: 8px; }
        .xt-dialog__body::-webkit-scrollbar-thumb { background: #d9dce1; border-radius: 4px; }
        .xt-dialog__footer {
            display: flex; align-items: center; gap: 10px;
            padding: 12px 20px 16px; border-top: 1px solid #f0f1f3;
        }

        /* ---------- 按钮 ---------- */
        .xt-btn {
            padding: 7px 16px; border-radius: 8px; border: 1px solid transparent;
            font-size: 14px; font-family: inherit; cursor: pointer;
            transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        .xt-btn--primary { background: #3370ff; color: #fff; }
        .xt-btn--primary:hover { background: #2860d8; }
        .xt-btn--ghost { background: #fff; border-color: #dcdfe4; color: #1f2329; }
        .xt-btn--ghost:hover { background: #f5f6f7; }

        /* ---------- 链接与空状态 ---------- */
        .xt-link { color: #3370ff; text-decoration: none; }
        .xt-link:hover { text-decoration: underline; }
        .xt-empty { text-align: center; color: #8f959e; padding: 24px 0; }

        /* ---------- Toast ---------- */
        .xt-toast-wrap {
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            z-index: 2147483600; display: flex; flex-direction: column; gap: 10px;
            align-items: center; pointer-events: none;
        }
        .xt-toast {
            display: flex; align-items: center; gap: 8px;
            padding: 9px 16px; background: #fff; border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
            font-size: 14px; color: #1f2329;
            animation: xt-toast-in 0.25s cubic-bezier(0.34, 1.3, 0.44, 1) both;
        }
        .xt-toast--leaving { animation: xt-toast-out 0.2s ease both; }
        .xt-toast__dot { width: 8px; height: 8px; border-radius: 50%; background: #3370ff; }
        .xt-toast--success .xt-toast__dot { background: #34c724; }
        .xt-toast--error .xt-toast__dot { background: #d54941; }
        @keyframes xt-toast-in {
            from { opacity: 0; transform: translateY(-10px) scale(0.95); }
            to   { opacity: 1; transform: none; }
        }
        @keyframes xt-toast-out {
            from { opacity: 1; } to { opacity: 0; transform: translateY(-6px); }
        }

        /* ---------- 悬浮球 ---------- */
        .xt-ball-root {
            position: fixed; z-index: 2147482000;
            width: var(--xt-ball-size, 46px); height: var(--xt-ball-size, 46px);
        }
        .xt-ball {
            width: 100%; height: 100%; border-radius: 50%;
            background: linear-gradient(135deg, #3370ff, #7b5cff);
            color: #fff; display: flex; align-items: center; justify-content: center;
            box-shadow: 0 6px 18px rgba(51, 112, 255, 0.4);
            cursor: grab; user-select: none; touch-action: none;
            transition: transform 0.15s, box-shadow 0.15s;
        }
        .xt-ball:hover { transform: scale(1.06); box-shadow: 0 8px 24px rgba(51, 112, 255, 0.5); }
        .xt-ball:active { cursor: grabbing; }
        .xt-icon { display: inline-flex; flex-shrink: 0; }
        .xt-icon svg { width: 100%; height: 100%; display: block; }
        .xt-ball .xt-icon {
            width: calc(var(--xt-ball-size, 46px) * 0.54);
            height: calc(var(--xt-ball-size, 46px) * 0.54);
        }
        .xt-ball-menu .xt-icon { width: 15px; height: 15px; }
        .xt-ball-menu {
            position: absolute; bottom: calc(100% + 10px); left: 50%;
            transform: translateX(-50%) translateY(4px) scale(0.95);
            display: flex; flex-direction: column; gap: 2px;
            background: #fff; border-radius: 12px; padding: 6px;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
            opacity: 0; visibility: hidden; pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s;
        }
        .xt-ball-menu-open .xt-ball-menu {
            opacity: 1; visibility: visible; pointer-events: auto;
            transform: translateX(-50%) translateY(0) scale(1);
        }
        .xt-ball-menu-below .xt-ball-menu {
            bottom: auto; top: calc(100% + 10px);
            transform: translateX(-50%) translateY(-4px) scale(0.95);
        }
        .xt-ball-menu-below.xt-ball-menu-open .xt-ball-menu {
            transform: translateX(-50%) translateY(0) scale(1);
        }
        .xt-ball-menu button {
            display: flex; align-items: center; gap: 6px;
            padding: 8px 18px; border: none; border-radius: 8px;
            background: transparent; color: #1f2329; font-size: 14px;
            font-family: inherit; cursor: pointer; white-space: nowrap;
            transition: background 0.15s, color 0.15s;
        }
        .xt-ball-menu button:hover { background: #f5f6f7; color: #3370ff; }

        /* ---------- 设置页 ---------- */
        .xt-settings { display: flex; gap: 16px; min-height: 380px; }
        .xt-settings__nav {
            display: flex; flex-direction: column; gap: 4px;
            width: 120px; flex-shrink: 0;
            border-right: 1px solid #f0f1f3; padding-right: 12px;
        }
        .xt-settings__nav-item {
            padding: 8px 12px; border-radius: 8px; cursor: pointer;
            color: #4e5358; font-size: 14px; user-select: none;
            transition: background 0.15s, color 0.15s;
        }
        .xt-settings__nav-item:hover { background: #f5f6f7; }
        .xt-settings__nav-item--active { background: #edf3ff; color: #3370ff; font-weight: 500; }
        .xt-settings__content { flex: 1; min-width: 0; }
        .xt-setting {
            display: flex; align-items: center; justify-content: space-between;
            gap: 16px; padding: 11px 2px; border-bottom: 1px solid #f5f6f7;
        }
        .xt-setting:last-child { border-bottom: none; }
        .xt-setting__label { font-size: 14px; color: #1f2329; }
        .xt-setting__desc { font-size: 12px; color: #8f959e; margin-top: 2px; }
        .xt-toggle {
            appearance: none; -webkit-appearance: none; flex-shrink: 0;
            width: 40px; height: 22px; border-radius: 11px;
            background: #d5d9de; position: relative; cursor: pointer;
            transition: background 0.2s; outline: none;
        }
        .xt-toggle::before {
            content: ''; position: absolute; top: 2px; left: 2px;
            width: 18px; height: 18px; border-radius: 50%; background: #fff;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); transition: transform 0.2s;
        }
        .xt-toggle:checked { background: #3370ff; }
        .xt-toggle:checked::before { transform: translateX(18px); }
        .xt-select {
            padding: 6px 10px; border: 1px solid #dcdfe4; border-radius: 8px;
            font-size: 14px; font-family: inherit; background: #fff; color: #1f2329;
            outline: none; cursor: pointer;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .xt-select:focus { border-color: #3370ff; box-shadow: 0 0 0 3px rgba(51, 112, 255, 0.12); }
        .xt-about-row { display: flex; gap: 8px; padding: 6px 2px; }
        .xt-about-row__label { color: #8f959e; flex-shrink: 0; }
        .xt-about-title { margin: 2px 2px 10px; font-size: 22px; font-weight: 700; letter-spacing: 0.5px; }

        /* ---------- 查询面板 ---------- */
        .xt-query-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .xt-query-label { width: 70px; flex-shrink: 0; color: #4e5358; }
        .xt-query-input {
            flex: 1; min-width: 0; padding: 7px 10px;
            border: 1px solid #dcdfe4; border-radius: 8px; font-size: 14px;
            font-family: inherit; outline: none;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .xt-query-input:focus { border-color: #3370ff; box-shadow: 0 0 0 3px rgba(51, 112, 255, 0.12); }
        .xt-query-row__buttons { display: flex; gap: 6px; flex-shrink: 0; }
        .xt-query-result {
            margin-top: 6px; padding-top: 10px;
            border-top: 1px solid #f0f1f3; min-height: 24px; max-height: 220px;
            overflow-y: auto;
        }
        .xt-query-result__row { display: flex; gap: 6px; padding: 3px 0; }
        .xt-query-result__label { color: #8f959e; flex-shrink: 0; }
        .xt-query-result__value { color: #1f2329; word-break: break-all; white-space: pre-line; }
        .xt-query-error { color: #d54941; padding: 4px 0; }

        /* ---------- 自动任务遮罩 ---------- */
        .xt-mask-overlay {
            position: fixed; inset: 0; z-index: 2147483500;
            display: flex; align-items: center; justify-content: center;
            background: rgba(15, 23, 42, 0.72);
            backdrop-filter: blur(4px);
            pointer-events: auto;
            animation: xt-fade 0.15s ease both;
        }
        .xt-mask-card {
            display: flex; flex-direction: column; align-items: center; gap: 8px;
            max-width: min(460px, calc(100vw - 48px));
            padding: 30px 40px; border-radius: 16px; text-align: center;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
        }
        .xt-mask-title { font-size: 20px; font-weight: 600; color: #fff; }
        .xt-mask-sub { font-size: 14px; color: rgba(255, 255, 255, 0.72); }
        .xt-mask-progress {
            min-height: 18px; margin-top: 4px; white-space: pre-line;
            font-size: 12px; color: rgba(255, 255, 255, 0.55);
        }
        .xt-mask-abort {
            margin-top: 8px; padding: 4px 14px; border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.3); background: transparent;
            color: rgba(255, 255, 255, 0.7); font-size: 12px; font-family: inherit;
            cursor: pointer; transition: background 0.15s, color 0.15s;
        }
        .xt-mask-abort:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }

        /* ---------- 自动任务面板 ---------- */
        .xt-task-hint { font-size: 12px; color: #8f959e; line-height: 1.7; padding: 2px 0 8px; }
        .xt-task-row {
            display: flex; align-items: center; justify-content: space-between;
            gap: 16px; padding: 11px 2px; border-bottom: 1px solid #f5f6f7;
        }
        .xt-task-row:last-child { border-bottom: none; }
        .xt-task-row__label { font-size: 14px; color: #1f2329; }
        .xt-task-row__desc { font-size: 12px; color: #8f959e; margin-top: 2px; }
    `;

    const UI = (() => {
        const modalStack = [];
        let toastWrap = null;
        let escapeBound = false;

        /** 创建一个挂载在 Shadow Root 中的独立容器，返回其根节点 */
        function mount(className) {
            const host = document.createElement('div');
            host.className = className;
            const root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = SHADOW_CSS;
            root.append(style);
            document.documentElement.append(host);
            return { host, root };
        }

        function bindEscapeOnce() {
            if (escapeBound) return;
            escapeBound = true;
            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                const top = modalStack[modalStack.length - 1];
                if (top) {
                    event.stopImmediatePropagation();
                    top.close('escape');
                }
            }, true);
        }

        /**
         * 打开弹窗。
         * @param {object} options { title, width, content(Node|string), footer(Node[]), onClose(reason) }
         * @returns {{ close: (reason?: string) => void, body: HTMLElement }}
         */
        function openModal({ title = '', width = 560, content = null, footer = [], onClose = null }) {
            const { host, root } = mount('xt-modal-host');
            const body = h('div', { class: 'xt-dialog__body' });
            const footerEl = h('div', { class: 'xt-dialog__footer' }, ...footer);
            const dialog = h('div', {
                class: 'xt-dialog',
                style: { width: `${width}px`, maxWidth: 'calc(100vw - 32px)' },
            },
                h('div', { class: 'xt-dialog__header' },
                    h('span', { class: 'xt-dialog__title' }, title),
                    h('button', { class: 'xt-dialog__close', title: '关闭', onclick: () => api.close('close') }, '✕'),
                ),
                body,
                footer.length ? footerEl : null,
            );
            const overlay = h('div', { class: 'xt-overlay' }, dialog);
            overlay.addEventListener('click', event => {
                if (event.target === overlay) api.close('overlay');
            });
            root.append(overlay);

            const api = {
                close(reason = 'close') {
                    if (!host.isConnected) return;
                    host.remove();
                    const index = modalStack.indexOf(api);
                    if (index !== -1) modalStack.splice(index, 1);
                    onClose?.(reason);
                },
                body,
                root,
            };
            modalStack.push(api);
            bindEscapeOnce();

            if (typeof content === 'string') body.innerHTML = content;
            else if (content) body.append(content);

            return api;
        }

        /** 确认框，返回 Promise<boolean> */
        function confirm({ title = '确认', message, okText = '确定', cancelText = '取消' }) {
            return new Promise(resolve => {
                const modal = openModal({
                    title,
                    width: 380,
                    content: h('div', { style: { padding: '4px 0 8px' } }, message),
                    onClose: reason => { if (reason !== 'ok') resolve(false); },
                    footer: [
                        h('button', { class: 'xt-btn xt-btn--ghost', onclick: () => modal.close('cancel') }, cancelText),
                        h('button', {
                            class: 'xt-btn xt-btn--primary',
                            onclick: () => { modal.close('ok'); resolve(true); },
                        }, okText),
                    ],
                });
            });
        }

        /** Toast 提示 */
        function toast(message, { type = 'info', duration = 2400 } = {}) {
            if (!toastWrap) {
                const { root } = mount('xt-toast-host');
                toastWrap = h('div', { class: 'xt-toast-wrap' });
                root.append(toastWrap);
            }
            const item = h('div', { class: `xt-toast xt-toast--${type}` },
                h('span', { class: 'xt-toast__dot' }), message);
            toastWrap.append(item);
            setTimeout(() => {
                item.classList.add('xt-toast--leaving');
                setTimeout(() => item.remove(), 220);
            }, duration);
        }

        return { mount, openModal, confirm, toast };
    })();

    /* ==========================================================
     * 5. Menu —— 油猴菜单注册表
     * ======================================================== */

    const Menu = {
        items: [],
        register(label, handler) {
            this.items.push({ label, handler });
        },
        setup() {
            for (const { label, handler } of this.items) {
                try { GM_registerMenuCommand(label, handler); } catch (err) { log.warn(err); }
            }
        },
    };

    /* ==========================================================
     * 6. Features —— 功能注册表
     * ======================================================== */

    const Features = {
        list: [],
        register(def) {
            if (def.settings) Settings.define(def.settings);
            this.list.push(def);
        },
        start() {
            for (const feature of this.list) {
                try {
                    feature.setup?.();
                } catch (err) {
                    log.error(`功能「${feature.id}」启动失败：`, err);
                }
            }
        },
    };

    Settings.defineGroup({ id: 'tasks', label: '自动化' });
    Settings.defineGroup({ id: 'appearance', label: '界面定制' });

    /* ---------- 自动领取奖励 ---------- */
    Features.register({
        id: 'auto-receive',
        settings: [{
            key: 'autoReceive', group: 'tasks', label: '自动领取奖励',
            desc: '自动点击任务中心中可领取的奖励', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('autoReceive')) return;
            Watcher.watch(SELECTORS.receiveButton, el => {
                if (el.textContent.trim() === '领取') el.click();
            }, { cooldown: 900 });
        },
    });

    /* ---------- 自动签到 ---------- */
    Features.register({
        id: 'auto-sign-in',
        settings: [{
            key: 'autoSignIn', group: 'tasks', label: '自动签到',
            desc: '进入首页后自动点击签到，5 分钟后自动停止', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('autoSignIn')) return;
            if (!location.href.startsWith(`${ORIGIN}/w/index`)) return;
            performSignIn({ timeout: 5 * 60 * 1000 }).catch(err => log.warn('自动签到失败：', err));
        },
    });

    /* ---------- 自动展开评论 ---------- */
    Features.register({
        id: 'auto-load-comments',
        settings: [{
            key: 'autoLoadComments', group: 'tasks', label: '自动展开评论',
            desc: '"更多评论"按钮进入屏幕后自动点击', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('autoLoadComments')) return;
            Watcher.watch(SELECTORS.moreComments, el => whenVisible(el, target => target.click()), { cooldown: 900 });
        },
    });

    /* ---------- 自动展开子回复 ---------- */
    Features.register({
        id: 'auto-expand-replies',
        settings: [{
            key: 'autoExpandReplies', group: 'tasks', label: '自动展开子回复',
            desc: '"展开更多回复"按钮进入屏幕后自动点击', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('autoExpandReplies')) return;
            Watcher.watch(SELECTORS.moreReplies, el => whenVisible(el, target => target.click()), { cooldown: 900 });
        },
    });

    /* ---------- 自动点击"查看更多" ---------- */
    Features.register({
        id: 'auto-click-more',
        settings: [{
            key: 'autoClickMore', group: 'tasks', label: '自动点击"查看更多"',
            desc: '在个人主页自动加载更多作品', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('autoClickMore')) return;
            Watcher.watch(SELECTORS.seeMore, el => {
                if (el.textContent.trim() === '查看更多') el.click();
            }, { cooldown: 900 });
        },
    });

    /* ---------- 消息免打扰 ---------- */
    Features.register({
        id: 'message-do-not-disturb',
        settings: [{
            key: 'messageDoNotDisturb', group: 'appearance', label: '消息免打扰',
            desc: '隐藏顶栏消息红点，并静默访问消息页清除未读状态', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('messageDoNotDisturb')) return;
            Watcher.watch(SELECTORS.messageCount, el => { el.style.display = 'none'; });
            silentFetch(`${ORIGIN}/w/message`);
        },
    });

    /* ---------- 动态免打扰 ---------- */
    Features.register({
        id: 'dynamic-do-not-disturb',
        settings: [{
            key: 'removeDynamicRedDot', group: 'appearance', label: '移除动态红点',
            desc: '隐藏顶栏动态红点，并静默访问动态页清除未读状态', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('removeDynamicRedDot')) return;
            Watcher.watch(SELECTORS.dynamicRedDot, el => { el.style.display = 'none'; });
            silentFetch(`${ORIGIN}/w/dynamic`);
        },
    });

    /* ---------- 任务中心免打扰 ---------- */
    Features.register({
        id: 'task-center-do-not-disturb',
        settings: [{
            key: 'taskCenterDoNotDisturb', group: 'appearance', label: '任务中心免打扰',
            desc: '隐藏任务中心的数字角标', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('taskCenterDoNotDisturb')) return;
            Watcher.every(500, () => {
                for (const path of [SELECTORS.taskCenterBadgeA, SELECTORS.taskCenterBadgeB]) {
                    const badge = Watcher.xpath(path);
                    if (badge) badge.style.display = 'none';
                }
            });
        },
    });

    /* ---------- 移除头像框 ---------- */
    Features.register({
        id: 'remove-avatar-frame',
        settings: [{
            key: 'removeAvatarFrame', group: 'appearance', label: '移除头像框',
            desc: '隐藏头像上的装扮挂件', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('removeAvatarFrame')) return;
            Watcher.watch(SELECTORS.avatarFrame, el => { el.style.display = 'none'; });
        },
    });

    /* ---------- 移除魔力测评 ---------- */
    Features.register({
        id: 'remove-magic-review',
        settings: [{
            key: 'removeMagicReview', group: 'appearance', label: '移除魔力测评',
            desc: '隐藏右下角的魔力测评悬浮窗', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('removeMagicReview')) return;
            Watcher.watch(SELECTORS.magicReview, el => { el.style.display = 'none'; });
        },
    });

    /* ---------- 自适应文本框 ---------- */
    Features.register({
        id: 'adaptive-textbox',
        settings: [{
            key: 'adaptiveTextbox', group: 'appearance', label: '自适应文本框',
            desc: '文本域高度随内容自动调整', default: false, reload: true,
        }],
        setup() {
            if (!Settings.get('adaptiveTextbox')) return;

            function adjust(el) {
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
            }

            Watcher.watch('textarea', el => {
                if (el.dataset.xmwAdaptiveBound) return;
                el.dataset.xmwAdaptiveBound = '1';
                el.addEventListener('input', () => adjust(el));
                adjust(el);
            }, { once: true });

            window.addEventListener('resize', () => {
                document.querySelectorAll('textarea').forEach(el => {
                    if (el.dataset.xmwAdaptiveBound) adjust(el);
                });
            });
        },
    });

    /* ---------- 作品菜单"编辑信息"按钮 ---------- */
    Features.register({
        id: 'edit-info-button',
        settings: [{
            key: 'editInfoButton', group: 'appearance', label: '"编辑信息"入口',
            desc: '在作品操作菜单中添加跳转编辑页的按钮', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('editInfoButton')) return;
            Watcher.watch(SELECTORS.workMenu, menu => {
                if (menu.querySelector('a[data-xmw-edit]')) return;
                const createLink = menu.querySelector('a[name="继续创作"]');
                if (!createLink) return;
                const match = createLink.href.match(/compositionId=([a-zA-Z0-9]+)/);
                if (!match) return;

                const editLink = h('a', {
                    dataset: { xmwEdit: '1' },
                    href: `${ORIGIN}/w/release/${match[1]}`,
                    target: '_blank',
                    title: '编辑信息（由 XMW Toolbox 添加）',
                    style: { transition: 'color 0.3s ease', cursor: 'pointer', color: '#666' },
                }, '编辑信息');
                editLink.addEventListener('mouseover', () => { editLink.style.color = '#ffa31a'; });
                editLink.addEventListener('mouseout', () => { editLink.style.color = '#666'; });

                const li = h('li', { class: 'person-operate-item__aOISu' }, editLink);
                createLink.parentElement.insertAdjacentElement('afterend', li);
                menu.style.gap = '8px';
            });
        },
    });

    /* ---------- Markdown 渲染 ---------- */
    Features.register({
        id: 'markdown-render',
        settings: [{
            key: 'markdownRender', group: 'appearance', label: 'Markdown 渲染',
            desc: '评论与作品简介支持 Markdown 显示', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('markdownRender')) return;
            injectPageCss();

            // 评论区正文
            Watcher.watch(SELECTORS.commentText, el => {
                if (el.dataset.xmwMdRendered) return;
                // 跳过输入区容器（如 comment-textarea，类名同样含 "comment-text"）
                if (el.querySelector('textarea, input')) return;
                renderElementMarkdown(el);
            }, { once: true });

            // 作品简介条目：标题不做处理，渲染其余内容块
            Watcher.watch(SELECTORS.introItem, el => {
                if (el.dataset.xmwMdRendered) return;
                el.dataset.xmwMdRendered = '1';
                const title = el.querySelector('[class*="intro-title"]');
                const targets = title ? [...el.children].filter(child => child !== title) : [el];
                for (const target of targets) renderElementMarkdown(target);
            }, { once: true });
        },
    });

    /* ---------- Markdown 编辑器 ---------- */
    Features.register({
        id: 'markdown-editor',
        settings: [{
            key: 'markdownEditor', group: 'appearance', label: 'Markdown 编辑器',
            desc: '为多行文本框添加格式工具栏与预览', default: true, reload: true,
        }],
        setup() {
            if (!Settings.get('markdownEditor')) return;
            injectPageCss();

            /** 在光标处应用 Markdown 语法并同步 React 状态 */
            function applyAction(ta, action) {
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                const value = ta.value;
                let newValue, selStart, selEnd;
                if (action.line) {
                    // 行级语法：作用于光标所在行的行首，已有前缀则移除（切换）
                    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                    if (value.startsWith(action.line, lineStart)) {
                        newValue = value.slice(0, lineStart) + value.slice(lineStart + action.line.length);
                        selStart = selEnd = lineStart;
                    } else {
                        newValue = value.slice(0, lineStart) + action.line + value.slice(lineStart);
                        selStart = selEnd = lineStart + action.line.length;
                    }
                } else {
                    // 包裹语法：保留选中文本，光标/选区落在标记内
                    const selected = value.slice(start, end);
                    newValue = value.slice(0, start) + action.left + selected + action.right + value.slice(end);
                    selStart = start + action.left.length;
                    selEnd = selStart + selected.length;
                }
                // 必须走原生 setter 写回：setRangeText 绕过 React 的值追踪器，
                // 受控组件会在下次提交时把修改回滚
                setReactValue(ta, newValue);
                ta.setSelectionRange(selStart, selEnd);
                ta.focus();
            }

            Watcher.watch('textarea', ta => {
                if (ta.dataset.xmwMdeBound) return;
                if (ta.readOnly || ta.disabled) return;
                ta.dataset.xmwMdeBound = '1';

                let previewOpen = false;
                const preview = h('div', { class: 'xmw-md-body xmw-mde-preview', hidden: true });
                const toggleBtn = h('button', {
                    class: 'xmw-mde-btn xmw-mde-toggle', type: 'button', title: '预览',
                    onclick: () => setPreview(!previewOpen),
                }, '预览');

                function setPreview(open) {
                    previewOpen = open;
                    toggleBtn.classList.toggle('xmw-mde-active', open);
                    toggleBtn.textContent = open ? '编辑' : '预览';
                    if (open) {
                        preview.innerHTML = renderMarkdown(ta.value);
                        preview.hidden = false;
                        ta.style.display = 'none';
                    } else {
                        preview.hidden = true;
                        ta.style.display = '';
                        ta.focus();
                    }
                }

                const buttons = MDE_ACTIONS.map(action => h('button', {
                    class: 'xmw-mde-btn', type: 'button', title: action.title,
                    style: action.style || undefined,
                    onclick: () => applyAction(ta, action),
                }, action.label));

                // 只插入相邻节点，不改动 textarea 自身的父子关系，避免破坏 React 协调
                ta.insertAdjacentElement('beforebegin', h('div', { class: 'xmw-mde-bar' }, [...buttons, toggleBtn]));
                ta.insertAdjacentElement('afterend', preview);

                ta.addEventListener('input', () => {
                    if (previewOpen) preview.innerHTML = renderMarkdown(ta.value);
                });
            }, { once: true });
        },
    });

    /* ---------- 悬浮球 ---------- */
    Features.register({
        id: 'floating-ball',
        settings: [
            {
                key: 'floatingBallShow', group: 'appearance', type: 'toggle',
                label: '悬浮球', desc: '显示可拖动的工具悬浮球，位置自动记忆',
                default: true, reload: false,
            },
            {
                key: 'floatingBallSize', group: 'appearance', type: 'select',
                label: '悬浮球大小', desc: '调整悬浮球的直径',
                default: 46, reload: false,
                options: [
                    { value: 38, label: '小' },
                    { value: 46, label: '中' },
                    { value: 60, label: '大' },
                ],
            },
        ],
        setup() {
            const { root } = UI.mount('xt-ball-host');

            const menu = h('div', { class: 'xt-ball-menu' },
                h('button', { onclick: () => { closeMenu(); openAutoTaskPanel(); } },
                    svgIcon('tasks'), '自动任务'),
                h('button', { onclick: () => { closeMenu(); openQueryPanel(); } },
                    svgIcon('query'), '查询'),
                h('button', { onclick: () => { closeMenu(); openSettingsPanel(); } },
                    svgIcon('settings'), '设置'));
            const ball = h('div', { class: 'xt-ball', title: 'XMW Toolbox' }, svgIcon('cube'));
            const ballRoot = h('div', { class: 'xt-ball-root' }, menu, ball);
            root.append(ballRoot);

            const state = { x: 0, y: 0, open: false };

            function clamp(x, y) {
                const size = Settings.get('floatingBallSize') ?? 46;
                const pad = 8;
                return {
                    x: Math.min(Math.max(x, pad), window.innerWidth - size - pad),
                    y: Math.min(Math.max(y, pad), window.innerHeight - size - pad),
                };
            }

            function moveTo(x, y) {
                const pos = clamp(x, y);
                state.x = pos.x;
                state.y = pos.y;
                ballRoot.style.left = `${pos.x}px`;
                ballRoot.style.top = `${pos.y}px`;
            }

            function applySavedPosition() {
                const saved = Settings.get('floatingBallPos');
                moveTo(saved?.x ?? window.innerWidth - 96, saved?.y ?? window.innerHeight * 0.6);
            }

            function applySize() {
                ballRoot.style.setProperty('--xt-ball-size', `${Settings.get('floatingBallSize') ?? 46}px`);
                moveTo(state.x, state.y);
            }

            function applyVisibility() {
                ballRoot.style.display = Settings.get('floatingBallShow') ? '' : 'none';
                if (!Settings.get('floatingBallShow')) closeMenu();
            }

            function openMenu() {
                state.open = true;
                // 球太靠上时菜单改为向下展开
                const menuHeight = menu.offsetHeight || 96;
                ballRoot.classList.toggle('xt-ball-menu-below', state.y < menuHeight + 10);
                ballRoot.classList.add('xt-ball-menu-open');
            }

            function closeMenu() {
                state.open = false;
                ballRoot.classList.remove('xt-ball-menu-open');
            }

            // 拖动与点击：pointer 移动超过 5px 视为拖动，否则视为点击
            let drag = null;
            ball.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                event.preventDefault();
                ball.setPointerCapture(event.pointerId);
                drag = {
                    startX: event.clientX, startY: event.clientY,
                    origX: state.x, origY: state.y, moved: false,
                };
            });
            ball.addEventListener('pointermove', event => {
                if (!drag) return;
                const dx = event.clientX - drag.startX;
                const dy = event.clientY - drag.startY;
                if (!drag.moved && Math.hypot(dx, dy) < 5) return;
                drag.moved = true;
                moveTo(drag.origX + dx, drag.origY + dy);
            });
            ball.addEventListener('pointerup', () => {
                if (!drag) return;
                const wasDrag = drag.moved;
                drag = null;
                if (wasDrag) {
                    Settings.set('floatingBallPos', { x: state.x, y: state.y });
                    if (state.open) openMenu(); // 拖动后按新位置重新判断展开方向
                } else {
                    state.open ? closeMenu() : openMenu();
                }
            });
            ball.addEventListener('pointercancel', () => { drag = null; });

            // 点击悬浮球以外的区域时收起菜单（composedPath 以穿透 Shadow DOM 判断）
            document.addEventListener('pointerdown', event => {
                if (!state.open) return;
                if (!event.composedPath().includes(ballRoot)) closeMenu();
            }, true);

            window.addEventListener('resize', applySavedPosition);
            Settings.onChange('floatingBallShow', applyVisibility);
            Settings.onChange('floatingBallSize', applySize);
            Settings.onChange('floatingBallPos', applySavedPosition);

            applySavedPosition();
            applySize();
            applyVisibility();
        },
    });

    /* ==========================================================
     * 7. AutoTask —— 自动任务状态机
     * ----------------------------------------------------------
     * 整页跳转会让脚本重新执行、闭包变量全部丢失，因此运行状态
     * 持久化在 GM_setValue('toolbox.taskRun')，由「步骤队列 + 游标」驱动：
     *
     * 1. 开始时生成 runId 写入状态，并用
     *    window.open('…/w/task-center#xmwtb-run=<runId>') 打开新标签页；
     * 2. 新标签页把 hash 里的 runId 存入 sessionStorage（标签页私有、
     *    整页跳转不丢失），与状态中的 runId 一致才接管执行，
     *    保证只有这一个标签页会自动操作；
     * 3. 每次页面加载执行一次 tick()：当前步骤的 url 与页面不符就
     *    location.assign 跳转（下次加载继续），匹配则执行动作并推进
     *    游标；单步失败重试 1 次，仍失败记为该任务失败并跳过其剩余
     *    步骤，不整体中断；
     * 4. 全部步骤完成后回到任务中心领奖，移除遮罩并弹窗报告。
     * ======================================================== */

    const AutoTask = (() => {
        const RUN_KEY = 'toolbox.taskRun';
        const SELECTION_KEY = 'toolbox.autoTask.selection';
        const RUN_ID_PARAM = 'xmwtb-run';
        const SESSION_RUN_KEY = 'xmwtb.runId';
        const MAX_AGE = 20 * 60 * 1000;     // 陈旧状态保护：超时后状态自动清除
        const STEP_TIMEOUT = 45 * 1000;     // 单步等待上限（编辑器页单独放宽）
        const EXPLORE_URL = `${ORIGIN}/w/explore?type=2&tagId=-1&page=1&pageSize=20`;
        const TASK_CENTER_URL = `${ORIGIN}/w/task-center`;
        const PUBLISH_TITLE = '完成每周任务用，领奖后自行删除';
        const PUBLISH_DESC = '该作品由账号主授权 XMW Toolbox 自动发布，用于完成每周任务。'
            + 'XMW Toolbox 项目链接：github.com/RSPqfgn/XMW-Toolbox';

        const TASKS = {
            signIn: { label: '每日签到', desc: '进入首页完成每日签到', aliases: ['每日签到'] },
            like: { label: '每日点赞', desc: '为社区作品点赞 3 次', aliases: ['每日点赞'] },
            collect: { label: '每日收藏', desc: '收藏 1 个社区作品', aliases: ['每日收藏'] },
            publish: { label: '每周作品发布', desc: '自动发布一个作品（完成后需手动删除）', aliases: ['每周作品发布', '发布作品'] },
        };
        const DEFAULT_SELECTION = { signIn: true, like: true, collect: false, publish: false };

        /* 点赞/收藏按钮是切换式的，需要尽量识别激活态避免"点成取消" */
        const REACT_CONFIG = {
            like: { selector: SELECTORS.likeButton, need: 3, label: '点赞', countKey: 'likeOk' },
            collect: { selector: SELECTORS.collectButton, need: 1, label: '收藏', countKey: 'collectOk' },
        };
        const RESULT_LABELS = {
            success: '✅ 成功', already: '✅ 已完成', skipped: '➖ 已跳过', failed: '❌ 失败',
        };

        let maskApi = null;
        let abortedRunId = null;    // 中止后禁止残留的执行流程把状态写回

        /* ---------- 状态读写 ---------- */

        function readState() {
            try {
                const state = GM_getValue(RUN_KEY, null);
                return state && typeof state === 'object' && Array.isArray(state.steps) ? state : null;
            } catch { return null; }
        }

        function writeState(state) {
            if (!state || state.runId === abortedRunId) return;
            GM_setValue(RUN_KEY, state);
        }

        function clearRun(state) {
            if (state) abortedRunId = state.runId;
            if (typeof GM_deleteValue === 'function') GM_deleteValue(RUN_KEY);
        }

        function setProgress(state, text) {
            state.progress = text;
            if (readState()?.runId === state.runId) writeState(state);
            maskApi?.progress(text);
        }

        function logStep(state, msg) {
            state.logs.push({ t: Date.now(), msg });
            if (state.logs.length > 100) state.logs.shift();
            log.info('[自动任务]', msg);
        }

        /* ---------- runId 标签页隔离 ---------- */

        function readSessionRunId() {
            try { return sessionStorage.getItem(SESSION_RUN_KEY); } catch { return null; }
        }

        function writeSessionRunId(runId) {
            try { sessionStorage.setItem(SESSION_RUN_KEY, runId); } catch { /* 无法使用 sessionStorage 时放弃接管 */ }
        }

        /** 从 URL hash 认领 runId（仅新打开的任务标签页会带有） */
        function claimRunFromHash() {
            const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
            if (!hash) return;
            const params = new URLSearchParams(hash);
            const runId = params.get(RUN_ID_PARAM);
            if (!runId) return;
            writeSessionRunId(runId);
            params.delete(RUN_ID_PARAM);
            const rest = params.toString();
            history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
        }

        /* ---------- 遮罩层 ---------- */

        function mountMask(progressText) {
            const { root } = UI.mount('xt-mask-host');
            const progressEl = h('div', { class: 'xt-mask-progress' }, progressText || '');
            const overlay = h('div', { class: 'xt-mask-overlay' },
                h('div', { class: 'xt-mask-card' },
                    h('div', { class: 'xt-mask-title' }, 'XMW Toolbox 正在操作'),
                    h('div', { class: 'xt-mask-sub' }, '请勿关闭该页面'),
                    progressEl,
                    h('button', { class: 'xt-mask-abort', onclick: () => abort() }, '中止'),
                ));
            root.append(overlay);
            maskApi = {
                progress(text) { progressEl.textContent = text || ''; },
                remove() { overlay.remove(); maskApi = null; },
            };
            return maskApi;
        }

        /* ---------- 步骤调度 ---------- */

        function isAt(url) {
            if (!url) return true;
            const target = new URL(url, ORIGIN);
            return location.origin === target.origin
                && location.pathname === target.pathname
                && location.search === target.search;
        }

        function stepLabel(step) {
            const labels = {
                receive: '正在领取任务奖励…',
                detect: '正在检测任务状态…',
                finish: '正在收尾…',
                signIn: '正在签到…',
                collectLinks: '正在获取候选作品…',
                openEditor: '正在打开作品编辑器…',
                fillRelease: '正在填写发布信息…',
            };
            if (step.kind === 'react') return `正在${REACT_CONFIG[step.data.type].label}…`;
            return labels[step.kind] ?? '正在执行任务…';
        }

        /** 同页推进或跳转到下一步所需页面 */
        async function advance(state) {
            if (readState()?.runId !== state.runId) return; // 运行已被中止或清除
            writeState(state);
            const next = state.steps[state.cursor];
            if (!next) return doFinish(state);
            if (next.url && !isAt(next.url)) {
                location.assign(next.url);
                return;
            }
            await tick();
        }

        async function tick() {
            const state = readState();
            if (!state || state.runId === abortedRunId) return;
            if (state.phase === 'error') return;
            if (Date.now() - state.startedAt > MAX_AGE) {
                log.warn('自动任务状态已过期，清除');
                clearRun(state);
                maskApi?.remove();
                return;
            }

            const step = state.steps[state.cursor];
            if (!step) return doFinish(state);
            if (step.url && !isAt(step.url)) {
                location.assign(step.url);
                return;
            }

            setProgress(state, stepLabel(step));
            const handler = HANDLERS[step.kind];
            try {
                if (!handler) throw new Error(`未知步骤类型：${step.kind}`);
                await handler(state, step);
            } catch (err) {
                await handleStepError(state, step, err);
            }
        }

        async function handleStepError(state, step, err) {
            log.error(`自动任务步骤「${step.kind}」执行失败：`, err);
            step.attempts = (step.attempts || 0) + 1;
            // 重试 1 次：整页重载后由 tick 重新执行当前步骤
            if (step.attempts === 1 && readState()?.runId === state.runId) {
                setProgress(state, `步骤执行失败，正在重试…（${err.message}）`);
                location.reload();
                return;
            }
            if (step.taskId) {
                // 记为该任务失败，跳过其剩余步骤，继续下一个任务
                state.results[step.taskId] = 'failed';
                state.errors[step.taskId] = err.message;
                logStep(state, `「${TASKS[step.taskId]?.label ?? step.taskId}」执行失败：${err.message}`);
                while (state.cursor < state.steps.length && state.steps[state.cursor].taskId === step.taskId) {
                    state.cursor += 1;
                }
                await advance(state);
            } else {
                finalizeReactResults(state);
                failRun(state, err);
            }
        }

        function failRun(state, err) {
            state.phase = 'error';
            state.error = err.message;
            writeState(state);
            maskApi?.progress(`执行出错：${err.message}。可点击「中止」退出，残留状态会自动过期清除。`);
        }

        function abort() {
            const state = readState();
            clearRun(state);
            maskApi?.remove();
            UI.toast('自动任务已中止', { type: 'info' });
        }

        /* ---------- 各步骤实现 ---------- */

        /** 领奖：点击所有「领取」按钮，规范化任务状态 */
        async function doReceive(state) {
            setProgress(state, '正在领取任务奖励…');
            try {
                await waitForSelector(SELECTORS.taskItem, { timeout: STEP_TIMEOUT });
            } catch { /* 页面结构变化时仍尝试直接点击 */ }
            await sleep(500);
            const clicked = await clickAllReceiveButtons({ timeout: 6000 });
            logStep(state, clicked ? `领取了 ${clicked} 个奖励` : '暂无可领取的奖励');
            state.cursor += 1;
            await advance(state);
        }

        /** 检测任务状态，生成后续步骤 */
        async function doDetect(state) {
            setProgress(state, '正在检测任务状态…');
            await waitForSelector(SELECTORS.taskItem, { timeout: STEP_TIMEOUT });
            await sleep(800);

            const statuses = detectTaskStates();
            const extra = [];
            for (const [taskId, def] of Object.entries(TASKS)) {
                if (!state.tasks[taskId]) {
                    state.results[taskId] = 'skipped';
                    continue;
                }
                const status = statuses[taskId] ?? 'unknown';
                if (status === 'done' || status === 'receivable') {
                    state.results[taskId] = 'already';
                    logStep(state, `「${def.label}」已完成，跳过`);
                    continue;
                }
                state.results[taskId] = 'pending';
                logStep(state, `「${def.label}」待执行`);
                extra.push(...buildTaskSteps(taskId));
            }
            if (!extra.length) logStep(state, '没有需要执行的任务');

            // 用生成的步骤替换 detect 之后的占位 finish
            state.steps.splice(state.cursor + 1, state.steps.length,
                ...extra, { kind: 'finish', url: TASK_CENTER_URL, attempts: 0 });
            state.phase = 'running';
            state.cursor += 1;
            await advance(state);
        }

        /** 读取任务中心各任务的完成情况 */
        function detectTaskStates() {
            const statuses = {};
            for (const item of document.querySelectorAll(SELECTORS.taskItem)) {
                const nameEl = item.querySelector(SELECTORS.taskName) ?? item;
                const taskId = matchTaskId(nameEl.textContent.trim());
                if (!taskId || statuses[taskId]) continue;
                const cls = String(item.querySelector(SELECTORS.taskAction)?.className ?? '');
                if (cls.includes(TASK_ACTION_CLASS.receive)) statuses[taskId] = 'receivable';
                else if (cls.includes(TASK_ACTION_CLASS.finished)) statuses[taskId] = 'done';
                else if (cls.includes(TASK_ACTION_CLASS.active)) statuses[taskId] = 'todo';
                else statuses[taskId] = 'unknown';
            }
            return statuses;
        }

        function matchTaskId(name) {
            for (const [taskId, def] of Object.entries(TASKS)) {
                if (def.aliases.some(alias => name.includes(alias))) return taskId;
            }
            return null;
        }

        function buildTaskSteps(taskId) {
            if (taskId === 'signIn') {
                return [{ kind: 'signIn', taskId, url: `${ORIGIN}/w/index`, attempts: 0 }];
            }
            if (taskId === 'like' || taskId === 'collect') {
                return [{ kind: 'collectLinks', taskId, url: EXPLORE_URL, attempts: 0 }];
            }
            if (taskId === 'publish') {
                return [
                    { kind: 'openEditor', taskId, url: `${ORIGIN}/scratch3-playground?platform=3`, attempts: 0 },
                    { kind: 'fillRelease', taskId, url: null, attempts: 0 },
                ];
            }
            return [];
        }

        /** 签到：复用共享的 performSignIn 逻辑 */
        async function doSignIn(state) {
            setProgress(state, '正在签到…');
            const ok = await performSignIn({ timeout: STEP_TIMEOUT });
            if (!ok) throw new Error('未检测到「已领取」，签到可能未成功');
            state.results.signIn = 'success';
            logStep(state, '签到成功');
            state.cursor += 1;
            await advance(state);
        }

        /** 在作品列表页收集候选作品链接，并插入后续的点赞/收藏步骤 */
        async function doCollectLinks(state, step) {
            setProgress(state, '正在获取候选作品…');
            await waitForSelector(SELECTORS.workLinkBox, { timeout: STEP_TIMEOUT });
            await sleep(800);
            const links = [...new Set(
                [...document.querySelectorAll(SELECTORS.workLinkBox)]
                    .map(a => a.getAttribute('href'))
                    .filter(Boolean)
                    .map(href => new URL(href, ORIGIN).href)
                    .filter(href => href.includes('/community/main/compose/')),
            )].slice(0, 6);
            if (!links.length) throw new Error('作品列表为空，无法获取候选作品');
            logStep(state, `获取到 ${links.length} 个候选作品`);

            const config = REACT_CONFIG[step.taskId];
            const reactSteps = links.map((url, index) => ({
                kind: 'react', taskId: step.taskId, url, attempts: 0,
                data: { type: step.taskId, index, total: links.length, need: config.need },
            }));
            state.steps.splice(state.cursor + 1, 0, ...reactSteps);
            state.cursor += 1;
            await advance(state);
        }

        /** 在作品页执行点赞/收藏，带幂等保护与激活态校验 */
        async function doReact(state, step) {
            const config = REACT_CONFIG[step.data.type];
            const okCount = state.data[config.countKey] || 0;
            // 所需次数已达成：剩余候选步骤直接跳过，避免继续点击（对已点过的作品会点成取消）
            if (okCount >= config.need) {
                logStep(state, `${config.label}任务已完成，跳过第 ${step.data.index + 1} 个候选作品`);
                state.cursor += 1;
                await advance(state);
                return;
            }
            setProgress(state, `正在${config.label}（${okCount}/${config.need}）…`);

            const button = await waitForSelector(config.selector, { timeout: STEP_TIMEOUT });
            await sleep(600);
            const before = reactSignature(button);
            if (reactLooksActive(before)) {
                logStep(state, `第 ${step.data.index + 1} 个作品已是${config.label}状态，跳过`);
            } else {
                button.click();
                await sleep(1200);
                const after = reactSignature(document.querySelector(config.selector) ?? button);
                if (reactSucceeded(before, after)) {
                    state.data[config.countKey] = okCount + 1;
                    logStep(state, `${config.label}成功（第 ${step.data.index + 1} 个作品）`);
                } else {
                    logStep(state, `第 ${step.data.index + 1} 个作品${config.label}未生效，换下一个`);
                }
            }
            state.cursor += 1;
            // 达成所需次数后剔除该任务剩余的候选步骤，不再逐个打开候选作品页
            if ((state.data[config.countKey] || 0) >= config.need) {
                const remaining = state.steps.length;
                state.steps = state.steps.filter((s, i) =>
                    i < state.cursor || !(s.kind === 'react' && s.taskId === step.data.type));
                if (state.steps.length < remaining) {
                    logStep(state, `${config.label}任务已完成，跳过剩余候选作品`);
                }
            }
            await advance(state);
        }

        function reactSignature(el) {
            return {
                cls: typeof el.className === 'string' ? el.className : (el.className?.baseVal ?? ''),
                text: el.textContent.trim(),
                pressed: el.getAttribute('aria-pressed'),
            };
        }

        function reactLooksActive(sig) {
            if (sig.pressed === 'true') return true;
            if (/inactive/i.test(sig.cls)) return false;
            return /active|selected|liked|isLike/i.test(sig.cls);
        }

        function reactSucceeded(before, after) {
            if (reactLooksActive(after)) return true;
            const beforeCount = before.text.match(/\d+/)?.[0];
            const afterCount = after.text.match(/\d+/)?.[0];
            // 计数可读时以 +1 为准（避免误把"取消"当作成功）
            if (beforeCount != null && afterCount != null) {
                return Number(afterCount) === Number(beforeCount) + 1;
            }
            return after.cls !== before.cls;
        }

        /** 打开作品编辑器并点击「发布」 */
        async function doOpenEditor(state) {
            setProgress(state, '正在打开作品编辑器（页面较重，请耐心等待）…');
            await waitForSelector(SELECTORS.editorPublishButton, { timeout: 90 * 1000 });
            await sleep(1000);
            document.querySelector(SELECTORS.editorPublishButton).click();
            logStep(state, '已点击编辑器「发布」按钮');
            state.cursor += 1;
            await advance(state);
        }

        /** 等待跳转到发布页，填写标题与简介并提交 */
        async function doFillRelease(state) {
            setProgress(state, '正在填写发布信息…');
            await waitFor(() => location.pathname.startsWith('/w/release/'), { timeout: 90 * 1000 });
            await waitForSelector(SELECTORS.releaseTitle, { timeout: 30 * 1000 });
            await sleep(500);
            setReactValue(document.querySelector(SELECTORS.releaseTitle), PUBLISH_TITLE);
            const desc = document.querySelector(SELECTORS.releaseDescription);
            if (desc) setReactValue(desc, PUBLISH_DESC);
            await sleep(500);

            const submit = pickSubmitButton();
            if (!submit) throw new Error('未找到发布提交按钮');
            submit.click();
            await sleep(1500);
            const confirmButton = pickModalConfirmButton();
            if (confirmButton) {
                confirmButton.click();
                logStep(state, '已确认发布弹窗');
            }
            state.results.publish = 'success';
            logStep(state, '作品已提交发布');
            state.cursor += 1;
            await advance(state);
        }

        function isVisible(el) {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0
                && style.visibility !== 'hidden' && style.display !== 'none';
        }

        /** 多个提交按钮时按可见性 + 文本筛选，取最后一个匹配项 */
        function pickSubmitButton() {
            const candidates = [...document.querySelectorAll(SELECTORS.releaseSubmit)]
                .filter(isVisible)
                .filter(el => /发布|确定/.test(el.textContent.trim()));
            return candidates[candidates.length - 1] ?? null;
        }

        function pickModalConfirmButton() {
            const candidates = [...document.querySelectorAll('.ant-modal .ant-btn-primary')]
                .filter(isVisible)
                .filter(el => /发布|确定|提交/.test(el.textContent.trim()));
            return candidates[candidates.length - 1] ?? null;
        }

        /** 收尾：再领奖 → 移除遮罩 → 弹窗报告 → 清除运行状态 */
        async function doFinish(state) {
            setProgress(state, '正在领取任务奖励…');
            await sleep(1200);
            try {
                const clicked = await clickAllReceiveButtons({ timeout: 6000 });
                if (clicked) logStep(state, `领取了 ${clicked} 个奖励`);
            } catch (err) {
                log.warn('收尾领奖失败：', err);
            }
            finalizeReactResults(state);
            state.phase = 'done';
            writeState(state);
            const report = {
                results: { ...state.results },
                errors: { ...state.errors },
            };
            maskApi?.remove();
            clearRun(state);
            showReport(report);
        }

        /** 结算点赞/收藏任务的最终结果（执行中只记 pending） */
        function finalizeReactResults(state) {
            for (const [type, config] of Object.entries(REACT_CONFIG)) {
                if (state.results[type] !== 'pending') continue;
                const done = state.data[config.countKey] || 0;
                if (done >= config.need) {
                    state.results[type] = 'success';
                } else {
                    state.results[type] = 'failed';
                    state.errors[type] = `仅成功 ${done}/${config.need}，候选作品不足或操作未生效`;
                }
            }
        }

        /* ---------- 完成报告 ---------- */

        function showReport({ results, errors }) {
            const rows = Object.entries(TASKS).map(([taskId, def]) => {
                const result = results[taskId] ?? 'skipped';
                const error = errors[taskId];
                return h('div', {},
                    `${RESULT_LABELS[result] ?? result}　${def.label}`,
                    error ? `（${error}）` : null);
            });
            const executed = Object.values(results).some(v => v === 'success' || v === 'failed');
            const modal = UI.openModal({
                title: executed ? '自动任务完成' : '自动任务',
                width: 420,
                content: h('div', { style: { padding: '4px 0 8px', lineHeight: '2' } },
                    ...rows,
                    executed ? null : h('div', { style: { color: '#8f959e' } }, '本次没有需要执行的任务。')),
                footer: [h('button', {
                    class: 'xt-btn xt-btn--primary',
                    onclick: () => modal.close(),
                }, '完成')],
            });
        }

        /* ---------- 对外入口 ---------- */

        const HANDLERS = {
            receive: doReceive,
            detect: doDetect,
            finish: doFinish,
            signIn: doSignIn,
            collectLinks: doCollectLinks,
            react: doReact,
            openEditor: doOpenEditor,
            fillRelease: doFillRelease,
        };

        /** 开始一次自动任务：写入运行状态并打开任务标签页 */
        function start(selection) {
            const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            writeState({
                runId,
                startedAt: Date.now(),
                version: 1,
                tasks: { ...DEFAULT_SELECTION, ...selection },
                steps: [
                    { kind: 'receive', url: TASK_CENTER_URL, attempts: 0 },
                    { kind: 'detect', url: TASK_CENTER_URL, attempts: 0 },
                    { kind: 'finish', url: TASK_CENTER_URL, attempts: 0 },
                ],
                cursor: 0,
                phase: 'detect',
                data: { likeOk: 0, collectOk: 0 },
                results: {},
                errors: {},
                logs: [],
                progress: '',
                error: null,
            });
            const opened = window.open(`${TASK_CENTER_URL}#${RUN_ID_PARAM}=${runId}`, '_blank');
            if (!opened) {
                clearRun(readState());
                UI.toast('任务标签页被浏览器拦截，请允许弹窗后重试', { type: 'error', duration: 5000 });
            }
        }

        /** 每次页面加载调用：判定本标签页是否为执行标签页并接管 */
        function resume() {
            claimRunFromHash();
            const state = readState();
            if (!state) return;
            if (state.phase === 'done' || Date.now() - state.startedAt > MAX_AGE) {
                clearRun(state);
                return;
            }
            const sessionRunId = readSessionRunId();
            if (!sessionRunId || sessionRunId !== state.runId) return;

            mountMask(state.progress);
            tick().catch(err => failRun(state, err));
        }

        return { TASKS, DEFAULT_SELECTION, SELECTION_KEY, start, resume, abort };
    })();

    /* ==========================================================
     * 8. Panels —— 内置面板
     * ======================================================== */

    /* ---------- 自动任务 ---------- */

    function openAutoTaskPanel() {
        let selection = { ...AutoTask.DEFAULT_SELECTION };
        try {
            const saved = GM_getValue(AutoTask.SELECTION_KEY, null);
            if (saved && typeof saved === 'object') selection = { ...selection, ...saved };
        } catch (err) {
            log.warn(err);
        }

        const rows = Object.entries(AutoTask.TASKS).map(([taskId, def]) => {
            const toggle = h('input', { type: 'checkbox', class: 'xt-toggle' });
            toggle.checked = !!selection[taskId];
            toggle.addEventListener('change', () => { selection[taskId] = toggle.checked; });
            return h('div', { class: 'xt-task-row' },
                h('div', {},
                    h('div', { class: 'xt-task-row__label' }, def.label),
                    h('div', { class: 'xt-task-row__desc' }, def.desc)),
                toggle);
        });

        const modal = UI.openModal({
            title: '自动任务',
            width: 460,
            content: h('div', {},
                h('div', { class: 'xt-task-hint' },
                    '点击「开始」后会打开任务中心页面并自动执行勾选的任务，',
                    h('br'),
                    '执行期间请勿操作该页面。勾选状态会自动保存。'),
                ...rows),
            footer: [
                h('button', { class: 'xt-btn xt-btn--ghost', onclick: () => modal.close('cancel') }, '取消'),
                h('button', { class: 'xt-btn xt-btn--primary', onclick: () => onStart() }, '开始'),
            ],
        });

        async function onStart() {
            if (!Object.values(selection).some(Boolean)) {
                UI.toast('请至少勾选一个任务', { type: 'error' });
                return;
            }
            if (selection.publish) {
                const ok = await UI.confirm({
                    title: '发布作品确认',
                    message: '「每周作品发布」会在你的账号下自动公开发布一个作品用于完成任务，'
                        + '该作品需要你之后手动删除。确定继续吗？',
                    okText: '继续',
                });
                if (!ok) return;
            }
            try { GM_setValue(AutoTask.SELECTION_KEY, { ...selection }); } catch (err) { log.warn(err); }
            modal.close('start');
            AutoTask.start({ ...selection });
        }
    }

    /* ---------- 查询 ---------- */

    class QueryError extends Error {}

    /** 检测站点的"页面不存在"错误页 */
    function assertPageExists(doc, message) {
        const errorA = doc.querySelector(SELECTORS.pageErrorA);
        if (errorA && errorA.textContent.includes('去火星了')) throw new QueryError(message);
        const errorB = doc.querySelector(SELECTORS.pageErrorB);
        if (errorB && errorB.textContent.includes('页面不存在')) throw new QueryError(message);
    }

    /** 提取带链接的值；无链接时退化为纯文本 */
    function extractLink(el) {
        if (!el) return '未知';
        const href = el.closest('a')?.getAttribute('href');
        return href
            ? { text: el.textContent.trim(), href: new URL(href, ORIGIN).href }
            : el.textContent.trim() || '未知';
    }

    function extractUserInfo(doc) {
        assertPageExists(doc, '用户可能不存在');
        const infoDivs = [...doc.querySelectorAll('[class*="leftInfo"] div')];
        const findInfo = keyword => {
            for (const div of infoDivs) {
                const text = div.textContent;
                if (text.includes(keyword)) return text.split('：')[1]?.trim() || '-';
            }
            return '-';
        };
        const studioEl = doc.querySelector('[class*="leftStudioLogoName"]');
        return [
            { label: '用户名', value: doc.querySelector('[class*="topheader__NickName"]')?.textContent.trim() || '未获取' },
            { label: '个人简介', value: doc.querySelector('[class*="privateSigNoInput"]')?.textContent.trim() || '暂无简介' },
            { label: '性别', value: findInfo('性别：') },
            { label: '年龄', value: findInfo('年龄：') },
            { label: '城市', value: findInfo('城市：') },
            { label: '学校', value: findInfo('学校：') },
            { label: '工作室', value: studioEl ? extractLink(studioEl) : '未加入工作室' },
        ];
    }

    function extractWorkInfo(doc) {
        assertPageExists(doc, '作品可能不存在');
        const extractIntro = titleText => {
            for (const item of doc.querySelectorAll('[class*="intro-item"]')) {
                if (item.querySelector('[class*="intro-title"]')?.textContent !== titleText) continue;
                return item.querySelector('div:not([class*="intro-title"])')?.textContent || '暂无内容';
            }
            return '暂无内容';
        };
        return [
            { label: '作品名', value: doc.querySelector('[class*="title__9ezjz"]')?.textContent.trim() || '未获取作品名' },
            { label: '作者', value: extractLink(doc.querySelector('[class*="userNickname"]')) },
            { label: '作品说明', value: extractIntro('作品说明') },
            { label: '操作说明', value: extractIntro('操作说明') },
        ];
    }

    async function extractStudioInfo(doc, id) {
        assertPageExists(doc, '工作室可能不存在');
        const masterResponse = ensureOk(await gmFetch(`${ORIGIN}/w/studio-members?studioId=${id}`));
        const membersDoc = parseHtml(masterResponse.responseText);
        return [
            { label: '工作室名', value: doc.querySelector('[class*="studioInfoName"]')?.textContent.trim() || '未获取工作室名' },
            { label: '简介', value: doc.querySelector('[class*="studioInfoIntro"]')?.textContent.trim() || '暂无简介' },
            { label: '标语', value: doc.querySelector('[class*="sloganText"]')?.textContent.trim() || '暂无标语' },
            { label: '室长', value: extractLink(membersDoc.querySelector('[class*="nickname__2KqRn"]')) },
            { label: '公告栏', value: doc.querySelector('[class*="bulletinBody"]')?.textContent.trim() || '暂无公告' },
        ];
    }

    const QUERY_TYPES = [
        {
            id: 'user', label: '用户', placeholder: '输入用户ID',
            url: id => `${ORIGIN}/w/person/project/all/${id}`,
            extract: extractUserInfo,
        },
        {
            id: 'work', label: '作品', placeholder: '输入作品ID',
            url: id => `${ORIGIN}/community/main/compose/${id}`,
            extract: extractWorkInfo,
        },
        {
            id: 'studio', label: '工作室', placeholder: '输入工作室ID',
            url: id => `${ORIGIN}/w/studio-home/${id}`,
            extract: extractStudioInfo,
        },
    ];

    function renderResultRow(item) {
        const value = item.value;
        const valueNode = value && typeof value === 'object' && value.href
            ? h('a', { class: 'xt-link', href: value.href, target: '_blank' }, value.text)
            : h('span', { class: 'xt-query-result__value' }, String(value));
        return h('div', { class: 'xt-query-result__row' },
            h('span', { class: 'xt-query-result__label' }, `${item.label}：`),
            valueNode);
    }

    async function runQuery(type, id, container) {
        container.replaceChildren(h('div', { class: 'xt-empty' }, '查询中…'));
        try {
            const response = ensureOk(await gmFetch(type.url(id)));
            const doc = parseHtml(response.responseText);
            const items = await type.extract(doc, id);
            container.replaceChildren(...items.map(renderResultRow));
        } catch (err) {
            const message = err instanceof QueryError ? `查询失败，${err.message}` : `查询失败：${err.message}`;
            container.replaceChildren(h('div', { class: 'xt-query-error' }, message));
        }
    }

    function openQueryPanel() {
        const inputs = {};
        const result = h('div', { class: 'xt-query-result' });

        const rows = QUERY_TYPES.map(type => {
            const input = h('input', { class: 'xt-query-input', placeholder: type.placeholder });
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') doQuery(type);
            });
            inputs[type.id] = input;
            return h('div', { class: 'xt-query-row' },
                h('span', { class: 'xt-query-label' }, type.label),
                input,
                h('div', { class: 'xt-query-row__buttons' },
                    h('button', { class: 'xt-btn xt-btn--primary', onclick: () => doQuery(type) }, '查询'),
                    h('button', { class: 'xt-btn xt-btn--ghost', onclick: () => doJump(type) }, '快速跳转'),
                ));
        });

        UI.openModal({
            title: '查询',
            width: 620,
            content: h('div', {}, ...rows, result),
        });

        function readId(type) {
            const id = inputs[type.id].value.trim();
            if (!id) {
                UI.toast(`请输入${type.label}ID`, { type: 'error' });
                return null;
            }
            return id;
        }

        function doQuery(type) {
            const id = readId(type);
            if (id) runQuery(type, id, result);
        }

        function doJump(type) {
            const id = readId(type);
            if (id) window.open(type.url(id), '_blank');
        }
    }

    /* ---------- 设置 ---------- */

    function renderAboutGroup(container) {
        const row = (label, value) => h('div', { class: 'xt-about-row' },
            h('span', { class: 'xt-about-row__label' }, label),
            value);
        container.replaceChildren(
            h('div', { class: 'xt-about-title' }, META.name),
            row('版本：', `v${META.version}`),
            row('作者：', h('a', { class: 'xt-link', href: META.authorLink, target: '_blank' }, META.author)),
            row('许可证：', META.license),
            row('项目主页：', h('a', { class: 'xt-link', href: META.repo, target: '_blank' }, META.repo)),
            row('问题反馈：', h('a', { class: 'xt-link', href: META.issues, target: '_blank' }, META.issues)),
        );
    }

    function renderSettingRow(def) {
        const text = h('div', {},
            h('div', { class: 'xt-setting__label' }, def.label),
            def.desc ? h('div', { class: 'xt-setting__desc' }, def.desc) : null);

        if ((def.type ?? 'toggle') === 'select') {
            const select = h('select', { class: 'xt-select' },
                ...def.options.map(option => h('option', { value: option.value }, option.label)));
            select.value = String(Settings.get(def.key));
            select.addEventListener('change', () => {
                const value = def.options.find(option => String(option.value) === select.value)?.value ?? select.value;
                Settings.set(def.key, value);
                UI.toast(def.reload ? '已保存，刷新页面后生效' : '已保存', { type: 'success' });
            });
            return h('div', { class: 'xt-setting' }, text, select);
        }

        const toggle = h('input', { type: 'checkbox', class: 'xt-toggle' });
        toggle.checked = !!Settings.get(def.key);
        toggle.addEventListener('change', () => {
            Settings.set(def.key, toggle.checked);
            UI.toast(def.reload ? '已保存，刷新页面后生效' : '已保存', { type: 'success' });
        });
        return h('div', { class: 'xt-setting' }, text, toggle);
    }

    function renderSettingsGroup(container, groupId) {
        if (groupId === 'about') {
            renderAboutGroup(container);
            return;
        }
        const rows = Settings.schema
            .filter(def => def.group === groupId)
            .map(renderSettingRow);
        container.replaceChildren(...(rows.length ? rows : [h('div', { class: 'xt-empty' }, '暂无设置')]));
    }

    function openSettingsPanel() {
        const nav = h('div', { class: 'xt-settings__nav' });
        const content = h('div', { class: 'xt-settings__content' });
        const navItems = [];
        let currentGroupId = null;
        let dirty = false;

        // 事件委托：面板内开关 / 下拉的任何变更（change 事件会冒泡）都标记为已修改
        content.addEventListener('change', () => { dirty = true; });

        const tabs = [...Settings.groups, { id: 'about', label: '关于' }];
        for (const group of tabs) {
            const item = h('div', {
                class: 'xt-settings__nav-item',
                onclick: () => activate(group.id),
            }, group.label);
            navItems.push({ groupId: group.id, el: item });
            nav.append(item);
        }

        function activate(groupId) {
            currentGroupId = groupId;
            for (const { groupId: id, el } of navItems) {
                el.classList.toggle('xt-settings__nav-item--active', id === groupId);
            }
            renderSettingsGroup(content, groupId);
        }

        const hint = h('span', {
            style: { flex: '1', fontSize: '12px', color: '#8f959e' },
        }, '修改后立即保存，部分功能需刷新页面后生效');
        const restoreButton = h('button', {
            class: 'xt-btn xt-btn--ghost',
            onclick: restoreDefaults,
        }, '恢复默认');

        UI.openModal({
            title: `${META.name} 设置`,
            width: 640,
            content: h('div', { class: 'xt-settings' }, nav, content),
            footer: [hint, restoreButton],
            onClose: askRefreshIfDirty,
        });

        activate(tabs[0].id);

        function restoreDefaults() {
            UI.confirm({
                title: '恢复默认设置',
                message: '确定要将所有设置恢复为默认值吗？',
            }).then(ok => {
                if (!ok) return;
                Settings.reset();
                dirty = true;
                UI.toast('已恢复默认设置', { type: 'success' });
                renderSettingsGroup(content, currentGroupId);
            });
        }

        /** 面板关闭时：若有未生效的修改，询问是否立即刷新 */
        function askRefreshIfDirty() {
            if (!dirty) return;
            UI.confirm({
                title: '刷新页面',
                message: '设置已更改，是否立即刷新页面使设置生效？',
                okText: '刷新',
            }).then(ok => { if (ok) location.reload(); });
        }
    }

    /* ==========================================================
     * 9. 对外扩展 API
     * ----------------------------------------------------------
     * 其他脚本可通过 unsafeWindow.XMWToolbox 注册设置项、菜单入口
     * 与功能，为未来的扩展系统预留接口。
     * ======================================================== */

    function exposeExtensionAPI() {
        const api = Object.freeze({
            version: META.version,
            settings: Object.freeze({
                define: defs => Settings.define(defs ?? []),
                get: key => Settings.get(key),
                set: (key, value) => Settings.set(key, value),
            }),
            menu: Object.freeze({
                register: (label, handler) => Menu.register(label, handler),
            }),
            ui: Object.freeze({
                mount: UI.mount,
                openModal: UI.openModal,
                confirm: UI.confirm,
                toast: UI.toast,
            }),
            watcher: Object.freeze({
                watch: (selector, callback, options) => Watcher.watch(selector, callback, options),
            }),
        });
        try {
            unsafeWindow.XMWToolbox = api;
        } catch (err) {
            log.warn('无法暴露扩展 API：', err);
        }
    }

    /* ==========================================================
     * 10. 启动流程
     * ======================================================== */

    function main() {
        Settings.load();

        Menu.register('自动任务', openAutoTaskPanel);
        Menu.register('查询', openQueryPanel);
        Menu.register('设置', openSettingsPanel);
        Menu.setup();

        Features.start();
        exposeExtensionAPI();

        // 判定本标签页是否为自动任务的执行标签页，是则接管
        try {
            AutoTask.resume();
        } catch (err) {
            log.error('自动任务恢复执行失败：', err);
        }

        log.info(`v${META.version} 已加载`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();
