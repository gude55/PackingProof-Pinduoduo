// ==UserScript==
// @name         拼多多打单订单备注播报插件
// @namespace    https://github.com/gude55/PackingProof-Pinduoduo
// @version      3.6
// @description  从拼多多官方打单（待打印/已发货/打印后变化订单）页面提取订单备注、快递单号与商品信息，并自动推送"待处理"的打印后变化订单到已配对的电脑和手机录像设备
// @author       gude55
// @icon         https://raw.githubusercontent.com/PackingProof/PackingProof-Desktop/main/ExpressPackingMonitoring/app.ico
// @match        *://mms.pinduoduo.com/print/order/*
// @match        *://mms.pinduoduo.com/print/exception-order*
// @connect      *
// PACKING_PROOF_CONNECT_TARGETS
// PACKING_PROOF_UPDATE_URLS
// 本脚本基于 PackingProof 官方第三方油猴脚本开发规范实现，源码仓库：https://github.com/gude55/PackingProof-Pinduoduo
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============ 配置 ============
    const PACKING_PROOF_RECORDERS = [];
    const PACKING_PROOF_HOST = null;
    // 上面两行是「内置默认设备」（桌面程序生成脚本时会覆写这两行）。
    // 用户在页面「设备管理」面板里的增删改会写入油猴存储，优先级高于内置默认值，
    // 且脚本升级（@updateURL 拉取新版）后依然保留，不会被覆盖回去。
    const RECORDERS_STORAGE_KEY = 'packingproof_recorders_v1';
    const HOST_STORAGE_KEY = 'packingproof_host_v1';
    const DEFAULT_PORT = 5280;          // 手机端 PackingProof-Mobile 固定监听端口
    const DEFAULT_HOST_PORT = 5555;     // 电脑端（上位机）默认端口
    const DEVICE_PROBE_TIMEOUT = 2000;  // 设备连通性检测超时
    const LAN_SCAN_TIMEOUT = 900;       // 局域网扫描单机超时
    const LAN_SCAN_CONCURRENCY = 24;    // 局域网扫描并发数
    const HOST_CHECK_TIMEOUT = 1200;
    const RECORDER_STATUS_TIMEOUT = 900;
    const RECORDER_STATUS_CACHE_MS = 15000;
    const MOBILE_PROBE_TIMEOUT = 1500;
    const ONLINE_RECORDER_TIMEOUT = 8000;
    const OFFLINE_RECORDER_TIMEOUT = 3000;
    const UNKNOWN_RECORDER_TIMEOUT = 10000;
    // v3.5.7 patch：录像设备熔断 + 失败日志降频（解决"抓门端不可达 → 控制台刷屏"雪崩）
    const DEVICE_CIRCUIT_FAIL_THRESHOLD = 3;       // 同一设备连续失败 N 次触发熔断
    const DEVICE_CIRCUIT_OPEN_DURATION_MS = 60000; // 熔断后 60 秒内不再推送，自动重试一次
    const DEVICE_CIRCUIT_WARN_COOLDOWN_MS = 30000; // 同样错误的失败日志 30 秒只打一条
    const ORDER_LOOKUP_RECONNECT_MS = 250;
    const PRINTED_REFUND_QUERY_TIMEOUT_MS = 6000;
    const PRINTED_REFUND_STABLE_MS = 500;
    // 拼多多 beast-core 表格为虚拟滚动：DOM 里只挂载可视区约 10~12 行，
    // 因此必须滚动扫描整个列表容器才能取全一页订单（这是"每次只推 11 条"的根因）。
    const VIRTUAL_SCROLL_SETTLE_MS = 180;   // 每次滚动后等待重新渲染的时间
    const VIRTUAL_SCROLL_MAX_STEPS = 120;   // 滚动步数上限，防御死循环
    // 桌面端 WebServer.cs 限制 MaxOrderInfoItems = 200 / body ≤ 1MB，超出需分批推送
    const MAX_ORDER_ITEMS_PER_REQUEST = 200;
    // 采集时间窗口：默认只采集/推送最近 48 小时内的订单，0 = 不限制。
    // 注意：退款核验（按快递单号精确查询）路径不受此限制，
    // 否则几天前打印、今天才退款的包裹会查不到退款状态。
    const DEFAULT_COLLECT_WINDOW_HOURS = 48;
    const COLLECT_WINDOW_HOURS_KEY = 'collect_window_hours';
    const PRINTED_REFUND_FILTER_COOLDOWN_MS = 30000;
    const USER_ACTIVITY_IDLE_MS = 30000;
    const REFUND_WORKER_PARAM = 'epm_refund_worker';
    const REFUND_WORKER_HEARTBEAT_KEY = 'refund_worker_heartbeat';
    const REFUND_WORKER_OPEN_LOCK_KEY = 'refund_worker_open_lock';
    const REFUND_WORKER_HEARTBEAT_INTERVAL_MS = 30000;
    const REFUND_WORKER_RECHECK_INTERVAL_MS = 30000;
    // Chrome 可能暂停长时间处于后台的标签页，不应因短时无心跳反复新建工作页。
    const REFUND_WORKER_STALE_MS = 10 * 60 * 1000;
    const REFUND_WORKER_OPEN_COOLDOWN_MS = 10 * 60 * 1000;
    const CONNECTION_CLIENT_ID_KEY = 'connection_client_id';

    // 防重复推送：记录已推送订单的内容签名；内容未变化时跳过，避免页面频繁变动导致无限重复扫描+推送。
    const pushedOrderSigs = new Map(); // key(orderId/orderSn) -> 上次推送的内容签名
    // v3.5.7 patch：录像设备熔断状态（endpoint -> failCount/circuitOpenUntil/lastWarnAt/lastWarnErrorKey）
    // 设计：连续失败 N 次熔断 60s，熔断期内不再推送避免雪崩；60s 后自动重试，成功则重置。
    const deviceCircuitState = new Map();
    function getDeviceCircuitState(endpoint) {
        let state = deviceCircuitState.get(endpoint);
        if (!state) {
            state = { failCount: 0, firstFailAt: 0, circuitOpenUntil: 0, lastWarnAt: 0, lastWarnErrorKey: '' };
            deviceCircuitState.set(endpoint, state);
        }
        return state;
    }
    function isDeviceCircuitOpen(endpoint) {
        const state = getDeviceCircuitState(endpoint);
        const now = Date.now();
        if (state.circuitOpenUntil > now) return true;
        if (state.circuitOpenUntil > 0) {
            // 熔断到期，重置
            state.failCount = 0;
            state.circuitOpenUntil = 0;
            state.firstFailAt = 0;
        }
        return false;
    }
    function recordDeviceSendResult(endpoint, ok) {
        const state = getDeviceCircuitState(endpoint);
        const now = Date.now();
        if (ok) {
            state.failCount = 0;
            state.firstFailAt = 0;
            state.circuitOpenUntil = 0;
            return;
        }
        if (state.firstFailAt === 0) state.firstFailAt = now;
        state.failCount++;
        if (state.failCount >= DEVICE_CIRCUIT_FAIL_THRESHOLD && state.circuitOpenUntil === 0) {
            state.circuitOpenUntil = state.firstFailAt + DEVICE_CIRCUIT_OPEN_DURATION_MS;
        }
    }
    function shouldLogDeviceFailure(endpoint, errorKey) {
        const state = getDeviceCircuitState(endpoint);
        const now = Date.now();
        if (state.lastWarnErrorKey === errorKey && (now - state.lastWarnAt) < DEVICE_CIRCUIT_WARN_COOLDOWN_MS) {
            return false;
        }
        state.lastWarnErrorKey = errorKey;
        state.lastWarnAt = now;
        return true;
    }
    function orderPushSignature(o) {
        return [
            o?.trackingNumber, o?.orderId, o?.goodsQuantity,
            o?.hasRefund, o?.refundStatus, o?.sellerMemo, o?.buyerMessage,
            o?.productInfo, o?.shipTime
        ].join('\u0000');
    }
    const CONNECTION_HEARTBEAT_INTERVAL_MS = 15000;
    const IS_REFUND_WORKER = new URL(location.href).searchParams.get(REFUND_WORKER_PARAM) === '1';
    const REFUND_WORKER_TOKEN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const CHANGELOG = 'v3.5.8：失败日志补 body——服务端返回 5xx（500/502/503 等）时，除了 status 还会顺带打印响应体摘要（最长 240 字节，含堆栈/error message），避免被服务端异常当成"看不见的盲盒"。特别用于诊断 NEO/PackingProof-Desktop 等录像端点返回 500 时排查后端抛错原因；与 v3.5.7 的设备熔断+降频日志配合，仅 5xx 才打 body，且同样走 30 秒降频不会刷屏。v3.5.7：修复售后管理/售后查询页（/print/after-sale-query）被误采集导致控制台重复刷屏的问题——明确限定只有 /print/order/* 和 /print/exception-order* 才自动采集，其他 print 子页面（售后、设置等）一律跳过；主入口增加 isSupportedOrderPage 兜底，不在范围内的页面直接不启动 DOM observer；无新增/变更订单时减少 console.info 日志刷屏。v3.5.6：修复两类问题——①防重复推送：新增订单内容签名去重，同一订单内容未变化不再重复扫描+推送（解决"一直重复扫描商品并推送"），采集日志增加"新/变更 N 条"计数；并随每条订单推送 mergedOrderCount（同快递单号聚合订单数）供手机端播报。②退款核验页打不开：claimRefundWorkerLease 改用"是否已有存活工作页(GM_getTabs)"判定重复，修正旧逻辑用每页随机 token 比对、导致上一工作页异常退出后心跳残留、新开工作页误判为重复而自我关闭的缺陷。v3.5.5：新增 goodsQuantity 字段推送（商品列 x2/x1 件数），手机端据此播报"共 N 件"。v3.5.4：修复「已发货订单页面不自动采集」——v3.5.3 把「未识别到标签」默认策略改为阻止后，进入「已发货订单」页（URL 路径 /print/order/delivered）时因该页没有「已打印」打印状态标签，被误判为跳过自动采集。已发货订单本身就是已发货状态，应当推送。本次在 shouldAutoExtractOnOrderPage 中增加已发货/已送达页面路径白名单（/print/order/delivered|shipped|sent），这些页面不再依赖打印状态标签，直接允许自动全量采集；同时日志增加 pathname，方便排查跳过原因。v3.5.3：修复「打开待发货/全部等标签时仍会全量采集」——上版本 getCurrentPrintTab 的选择器没覆盖拼多多 beast-core 组件的实际 class，且 shouldAutoExtractOnOrderPage 在「未识别到标签」时保守返回 true，导致进入「待发货订单」「全部」「未打印」等页面时选择器失效、脚本误判为允许采集，从而推送了大量未打印订单。本次重写标签识别：URL 参数 printStatus/status/tab 增加常见值到中文标签的映射；active tab 选择器扩展为 beast-core-tabs / TabBar / role="tab" 等多种组合；fallback 扫描页面上所有包含「未打印/待打印/已打印/全部/已锁定/寄件下单」文本的元素并校验 active 状态。同时把「未识别到标签」策略从「保守允许」改为「默认阻止」，只有明确识别到「已打印」才自动全量采集，宁可少推不可误采。v3.5.2：修复「采集位置错误，采集了未打印界面」——普通打单页现在只在「已打印」标签下自动全量采集/推送；「未打印/待打印/全部」等标签下不再因页面加载或列表翻页自动推送订单到录像设备。识别方式优先读取 URL printStatus/status/tab 参数，其次扫描 DOM 中的 active tab；用户点击「打印/发货/批量/生成面单」等操作按钮后的推送不受此限制。v3.5.0：新增「设备管理」可视化面板（油猴菜单打开）——支持手动添加/删除/改名录像设备、一键测试连通性（手机端探 /api/storage、电脑端探 /api/node-info）、扫描整个局域网网段自动发现手机录像端、单独配置上位机地址、一键恢复内置默认配置。设备配置改为存在油猴存储中，优先级高于脚本内置常量，脚本升级（@updateURL 拉新版）后不会被覆盖丢失；脚本头新增 @connect * 使自定义 IP 不被油猴跨域拦截，并补上遗漏的 @grant GM_setClipboard；内网地址白名单与手机端 isPrivateAddress 对齐（新增 169.254 链路本地段）；地址解析改为「填了但非法则判空」，不再静默改写成其他设备地址导致重复推送。v3.4.2：优化虚拟滚动扫描——开启 48 小时时间窗口时，滚动过程中一旦连续 3 屏采到的订单都有明确时间且全部超期，就提前停止滚动，避免扫完整页历史订单；控制台会输出"滚动提前终止: 连续 3 屏订单均超 48 小时窗口"。顺带修复"复制当前页推送数据"失败：优先使用 GM_setClipboard，不受 HTTPS/焦点限制，超长 JSON 自动截断到 prompt。v3.4.1：修复向手机端(PackingProof-Mobile)推送大量订单时 timeout 失败——手机端处理 POST /api/orderinfo 需要解析 JSON+写入 SQLite+回调 Dart，188 条订单超出原 3000ms 未知设备超时，改为单 mobile 设备直接探测 /api/storage 确认在线并采用 8000ms 超时，未知状态也放宽到 10000ms；桌面端/离线设备超时同步调大。v3.4.0：新增采集时间窗口——默认只采集并推送最近 48 小时内的订单，避免把列表里的历史旧单反复推给录像设备。每行时间取"发货/打印时间"列（取不到则扫描整行）解析出的最新时间，支持 2026-08-09 22:31:05 / 08-09 22:31 / 8月9日 22:31 / 2小时前 / 昨天 22:31 等格式，并做数字边界防护避免把订单号误判成日期；解析不到时间的行保守保留（宁可多推不可漏推）。窗口可在油猴菜单"采集时间范围"里修改，填 0 为不限；退款核验按快递单号精确查询时始终不受窗口限制，保证几天前打印、今天才退款的包裹仍能查到。诊断菜单同步输出每行的解析时间与是否会被过滤。v3.3.0：①修复每次只推送约11条——拼多多表格是虚拟滚动，DOM 只挂载可视区行，改为滚动扫描整个列表容器并去重累积(collectAllOrders)，取全当前页订单；②修复已退款单号不提示——退款判定新增"全行退款标签扫描"(detectRowRefundText)，正常打单页(无变化说明列)也能识别退款；同时取消"已处理即静默"对退款单的误伤，退款单一律弹提示并置 hasRefund；③修复商品信息抓成"0.00"——原列定位用 forEach 覆盖赋值导致金额列胜出，改为候选打分择优(pickProductColumn)并排除纯金额单元格，异常页新增按商品图兜底；④推送超过200条自动分批(桌面端 MaxOrderInfoItems 限制)；⑤新增油猴菜单"诊断：打印表格行结构"输出列定位明细。v3.2.7：推送订单对象补充 pushTimeMilliseconds（手机端 OrderInfo.fromMap 期望的推送时间戳字段，此前缺失导致手机端 pushTime 为 null）；其余契约字段(trackingNumber/orderId/buyerMessage/sellerMemo/productInfo/hasRefund/isPrintedRefund/refundStatus/refundProductInfo)与桌面/手机端契约一致。v3.2.6：重构订单提取——改用按单元格结构/内容定位语义列（不再依赖表头文案与固定下标），修复商品信息(productInfo)为空、商家备注/买家留言未提取、买家名混入"查看/修改"、店铺名误取<style>样式文本、地址为空等问题；手机端可正确识别商品与备注并播报。';
    const DEBUG_LOG = false;

    let lastUserActivityAt = Date.now();
    function recordUserActivity(event) {
        if (event.isTrusted) lastUserActivityAt = Date.now();
    }
    document.addEventListener('mousemove', recordUserActivity, { capture: true, passive: true });
    document.addEventListener('pointerdown', recordUserActivity, { capture: true, passive: true });
    document.addEventListener('wheel', recordUserActivity, { capture: true, passive: true });
    document.addEventListener('touchstart', recordUserActivity, { capture: true, passive: true });
    document.addEventListener('keydown', recordUserActivity, true);

    function isUserActivelyUsingPage(now) {
        return document.visibilityState === 'visible' &&
            document.hasFocus() &&
            now - lastUserActivityAt < USER_ACTIVITY_IDLE_MS;
    }

    function debugLog(...args) {
        if (DEBUG_LOG) console.log(...args);
    }

    function buildRefundWorkerUrl() {
        // 退款核验数据源应使用拼多多官方的"打印后订单发生变化"页，而非复制当前页。
        const url = new URL('https://mms.pinduoduo.com/print/exception-order');
        url.searchParams.set(REFUND_WORKER_PARAM, '1');
        return url.href;
    }

    function getRefundWorkerHeartbeat() {
        const value = GM_getValue(REFUND_WORKER_HEARTBEAT_KEY, 0);
        return typeof value === 'object' && value
            ? { token: String(value.token || ''), time: Number(value.time || 0) }
            : { token: '', time: Number(value || 0) };
    }

    function writeRefundWorkerHeartbeat() {
        GM_setValue(REFUND_WORKER_HEARTBEAT_KEY, { token: REFUND_WORKER_TOKEN, time: Date.now() });
    }

    function releaseRefundWorkerLease() {
        const heartbeat = getRefundWorkerHeartbeat();
        if (heartbeat.token === REFUND_WORKER_TOKEN) {
            GM_setValue(REFUND_WORKER_HEARTBEAT_KEY, 0);
        }
    }

    function saveRefundWorkerTabIdentity(isWorker) {
        return new Promise(resolve => {
            GM_getTab(tab => {
                tab.epmRefundWorker = isWorker;
                tab.epmRefundWorkerToken = isWorker ? REFUND_WORKER_TOKEN : '';
                GM_saveTab(tab, resolve);
            });
        });
    }

    function hasOpenRefundWorkerTab() {
        return new Promise(resolve => {
            GM_getTabs(tabs => {
                resolve(Object.values(tabs || {}).some(tab => tab?.epmRefundWorker === true));
            });
        });
    }

    function closeDuplicateRefundWorker() {
        document.title = '【重复的退款核验页】正在关闭';
        window.close();
        setTimeout(() => location.replace('about:blank'), 300);
    }

    async function claimRefundWorkerLease() {
        // 用「是否已有存活的工作页(GM_getTabs)」判定重复，而非旧的「每页随机 token 比对」：
        // 旧逻辑在上一工作页异常退出、心跳残留未清时，新开的工作页会因 token 不符而误判为重复并自我关闭，
        // 表现为“退款核验页打不开”。本页尚未写入 epmRefundWorker=true，故只可能命中“已存在的其它工作页”。
        if (await hasOpenRefundWorkerTab()) {
            closeDuplicateRefundWorker();
            return false;
        }

        writeRefundWorkerHeartbeat();
        await delay(100 + Math.floor(Math.random() * 150));
        // 二次确认：延迟窗口内若有其它工作页抢先声明，则本页作为重复关闭。
        if (await hasOpenRefundWorkerTab()) {
            closeDuplicateRefundWorker();
            return false;
        }
        return true;
    }

    async function startRefundWorkerHeartbeat() {
        if (!await claimRefundWorkerLease()) return false;
        await saveRefundWorkerTabIdentity(true);

        window.addEventListener('pagehide', event => {
            if (!event.persisted) releaseRefundWorkerLease();
        });
        setInterval(() => {
            const heartbeat = getRefundWorkerHeartbeat();
            if (heartbeat.token && heartbeat.token !== REFUND_WORKER_TOKEN) {
                closeDuplicateRefundWorker();
                return;
            }
            writeRefundWorkerHeartbeat();
        }, REFUND_WORKER_HEARTBEAT_INTERVAL_MS);
        const workerTitle = '【退款核验专用】请勿操作';
        const applyWorkerIdentity = () => {
            if (document.title !== workerTitle) document.title = workerTitle;
        };
        applyWorkerIdentity();
        const titleElement = document.querySelector('title');
        if (titleElement) {
            new MutationObserver(applyWorkerIdentity).observe(titleElement, { childList: true, subtree: true, characterData: true });
        }

        const overlay = document.createElement('div');
        overlay.setAttribute('data-epm-refund-worker-overlay', '');
        overlay.innerHTML = `
            <div style="width:min(560px,calc(100vw - 48px));padding:48px 40px;border:1px solid rgba(255,255,255,.22);border-radius:20px;background:rgba(15,23,42,.72);box-shadow:0 24px 80px rgba(0,0,0,.38);text-align:center;">
                <img src="https://raw.githubusercontent.com/PackingProof/PackingProof-Desktop/main/ExpressPackingMonitoring/app.ico" alt="" style="width:88px;height:88px;margin-bottom:24px;" />
                <div style="font-size:34px;line-height:1.35;font-weight:800;letter-spacing:1px;">退款核验专用工作页</div>
                <div style="margin-top:18px;font-size:22px;line-height:1.6;font-weight:700;color:#fecaca;">请勿操作或关闭此页面</div>
                <div style="margin-top:22px;font-size:15px;line-height:1.8;color:#cbd5e1;">此页面由拼多多打单监控自动管理<br />用于在后台核验打印后退款订单</div>
            </div>`;
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '2147483647',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(145deg,rgba(127,29,29,.64) 0%,rgba(153,27,27,.6) 42%,rgba(69,10,10,.68) 100%)',
            color: '#fff', fontFamily: 'Microsoft YaHei, sans-serif',
            pointerEvents: 'auto', userSelect: 'none'
        });
        document.body.appendChild(overlay);
        return true;
    }

    async function ensureRefundWorker(force, monitorReachable) {
        if (IS_REFUND_WORKER) return;
        if (!force && !document.querySelector('tr[data-testid="beast-core-table-body-tr"]')) return;
        // 退款检测页面（采集 exception-order 退款订单并推送给录像设备）不依赖上位机；
        // 只要存在可推送的录像设备，或上位机在线，就应当打开。
        // 之前硬性要求 monitorReachable===true，导致用户只用手机端录像、未配置/未连上位机时
        // 退款检测页面始终打不开（点开打单页也不会自动弹出退款核验页）。
        if (!force && monitorReachable !== true && getRecorderDevices().length === 0) return;

        const now = Date.now();
        const heartbeat = getRefundWorkerHeartbeat();
        if (!force && heartbeat.time > 0 && now - heartbeat.time < REFUND_WORKER_STALE_MS) return;
        if (!force && await hasOpenRefundWorkerTab()) return;

        const currentLock = GM_getValue(REFUND_WORKER_OPEN_LOCK_KEY, null);
        if (!force && currentLock && now - Number(currentLock.time || 0) < REFUND_WORKER_OPEN_COOLDOWN_MS) return;

        const token = `${now}-${Math.random().toString(36).slice(2)}`;
        GM_setValue(REFUND_WORKER_OPEN_LOCK_KEY, { token, time: now });
        await delay(100);
        const ownedLock = GM_getValue(REFUND_WORKER_OPEN_LOCK_KEY, null);
        if (!ownedLock || ownedLock.token !== token) return;

        // 默认追加到标签栏末尾，不与用户正在操作的打印页并排插入。
        GM_openInTab(buildRefundWorkerUrl(), { active: false, setParent: false });
        debugLog('[打包监控] 已在后台打开退款核验工作页');
    }

    let refundWorkerMaintenancePromise = null;
    function maintainRefundWorker(monitorReachable) {
        if (IS_REFUND_WORKER) return Promise.resolve();
        if (refundWorkerMaintenancePromise) return refundWorkerMaintenancePromise;

        refundWorkerMaintenancePromise = (async () => {
            if (monitorReachable === undefined) {
                const heartbeat = getRefundWorkerHeartbeat();
                if (heartbeat.time > 0 && Date.now() - heartbeat.time < REFUND_WORKER_STALE_MS) return;
                if (await hasOpenRefundWorkerTab()) return;

                monitorReachable = await canConnectHost();
            }
            await ensureRefundWorker(false, monitorReachable);
        })().finally(() => { refundWorkerMaintenancePromise = null; });
        return refundWorkerMaintenancePromise;
    }

    function getOrderLookupPendingUrl() { return `${getHostBaseUrl()}/api/order-lookup/pending`; }
    function getOrderLookupResultUrl() { return `${getHostBaseUrl()}/api/order-lookup/result`; }
    function getConnectionHeartbeatUrl() { return `${getHostBaseUrl()}/api/connections/heartbeat`; }
    function getBaseUrl(host, port) {
        const address = normalizeAddress(host, port);
        return `http://${address.host}:${address.port}`;
    }
    function normalizeAddress(host, port) {
        let value = String(host || '').trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/g, '');
        const parts = value.split(':');
        let normalizedHost = parts[0] || getDefaultHost();
        if (!isAllowedMonitorHost(normalizedHost)) {
            // 传入了明确但非法的地址时返回空，避免被静默改写成别的设备地址造成重复推送；
            // 只有「完全没传地址」才回退到默认设备。
            normalizedHost = parts[0] ? '' : getDefaultHost();
        }
        const parsedPort = Number(parts[1] || port || DEFAULT_PORT);
        return {
            host: normalizedHost,
            port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT
        };
    }
    function isAllowedMonitorHost(host) {
        const value = String(host || '').trim().toLowerCase();
        const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!match) return false;
        const octets = match.slice(1).map(Number);
        if (octets.some(octet => octet < 0 || octet > 255)) return false;
        // 与手机端 OrderInfoReceiverRuntime.isPrivateAddress 保持一致（含 169.254 链路本地，
        // 手机热点/Wi-Fi Direct 场景会分到这一段）
        return octets[0] === 10 ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] === 192 && octets[1] === 168) ||
            (octets[0] === 169 && octets[1] === 254);
    }
    function formatAddress(address) {
        const normalized = normalizeAddress(address.host, address.port);
        return normalized.host ? `${normalized.host}:${normalized.port}` : '';
    }
    // ============ 设备配置存储（用户可增删改，优先于内置默认值） ============
    function parseHostPart(url) {
        return String(url || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/g, '').split(':')[0] || '';
    }

    // 默认主机：取第一台合法的录像设备地址，没有则取上位机地址。
    // 注意这里必须直接解析原始字符串，不能调用 normalizeAddress，否则会无限递归。
    function getDefaultHost() {
        for (const device of getConfiguredRecorders()) {
            const host = parseHostPart(device?.url);
            if (isAllowedMonitorHost(host)) return host;
        }
        const hostConfig = getConfiguredHost();
        const hostAddr = parseHostPart(hostConfig?.address || hostConfig?.Address || '');
        return isAllowedMonitorHost(hostAddr) ? hostAddr : '';
    }

    function getConfiguredRecorders() {
        try {
            const raw = GM_getValue(RECORDERS_STORAGE_KEY, null);
            if (raw) {
                const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (Array.isArray(list)) return list;
            }
        } catch (e) {
            console.warn('[PackingProof] 读取自定义设备失败，回退内置配置:', e);
        }
        return PACKING_PROOF_RECORDERS;
    }

    function saveConfiguredRecorders(list) {
        GM_setValue(RECORDERS_STORAGE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
        recorderStatusCache = { checkedAt: 0, onlineEndpoints: null };
    }

    // 恢复到脚本内置的默认设备（清除用户自定义）
    function resetConfiguredRecorders() {
        GM_setValue(RECORDERS_STORAGE_KEY, null);
        GM_setValue(HOST_STORAGE_KEY, null);
        recorderStatusCache = { checkedAt: 0, onlineEndpoints: null };
    }

    function isUsingCustomRecorders() {
        return !!GM_getValue(RECORDERS_STORAGE_KEY, null);
    }

    function getConfiguredHost() {
        try {
            const raw = GM_getValue(HOST_STORAGE_KEY, null);
            if (raw) {
                const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (obj && typeof obj === 'object') return obj;
            }
        } catch (e) {
            console.warn('[PackingProof] 读取自定义上位机失败，回退内置配置:', e);
        }
        return PACKING_PROOF_HOST;
    }

    function saveConfiguredHost(config) {
        GM_setValue(HOST_STORAGE_KEY, config ? JSON.stringify(config) : null);
    }

    function getRecorderDevices() {
        const result = [];
        const endpoints = new Set();
        for (const device of getConfiguredRecorders()) {
            const address = normalizeAddress(device?.url || '', DEFAULT_PORT);
            const text = formatAddress(address);
            if (!text || endpoints.has(text)) continue;
            endpoints.add(text);
            result.push({
                nodeId: String(device?.nodeId || text),
                name: String(device?.name || text),
                type: String(device?.type || 'unknown'),
                url: `http://${text}`
            });
        }
        return result;
    }

    let recorderStatusCache = { checkedAt: 0, onlineEndpoints: null };
    async function getOnlineRecorderEndpoints() {
        const now = Date.now();
        if (now - recorderStatusCache.checkedAt < RECORDER_STATUS_CACHE_MS) {
            return recorderStatusCache.onlineEndpoints;
        }

        const baseUrl = getHostBaseUrl();
        if (!baseUrl) return null;
        const result = await gmGet(`${baseUrl}/api/recording-devices`, RECORDER_STATUS_TIMEOUT);
        if (!result.ok || !Array.isArray(result.response?.devices)) {
            recorderStatusCache = { checkedAt: now, onlineEndpoints: null };
            return null;
        }

        const onlineEndpoints = new Set();
        for (const device of result.response.devices) {
            if (device?.online !== true) continue;
            const address = normalizeAddress(device?.address || '', DEFAULT_PORT);
            const endpoint = formatAddress(address);
            if (!endpoint) continue;
            onlineEndpoints.add(`${String(device?.nodeId || '').trim().toLowerCase()}|${endpoint.toLowerCase()}`);
        }
        recorderStatusCache = { checkedAt: now, onlineEndpoints };
        return onlineEndpoints;
    }

    async function probeMobileRecorder(address) {
        const baseUrl = getBaseUrl(address.host, address.port);
        const result = await gmGet(`${baseUrl}/api/storage`, MOBILE_PROBE_TIMEOUT);
        return result.ok && result.response?.service === 'packingproof-mobile';
    }

    async function buildRecorderDeliveryPlan(devices) {
        // 对单一 mobile 设备，直接探测 /api/storage 确定是否在线，不再依赖桌面端中转。
        if (devices.length === 1 && String(devices[0]?.type || '').toLowerCase() === 'mobile') {
            const device = devices[0];
            const address = normalizeAddress(device.url, DEFAULT_PORT);
            const online = address.host ? await probeMobileRecorder(address) : false;
            return [{
                device,
                online,
                timeout: online ? ONLINE_RECORDER_TIMEOUT : UNKNOWN_RECORDER_TIMEOUT,
                index: 0
            }];
        }

        if (devices.length <= 1) {
            return devices.map(device => ({ device, online: null, timeout: UNKNOWN_RECORDER_TIMEOUT }));
        }

        const onlineEndpoints = await getOnlineRecorderEndpoints();
        if (onlineEndpoints === null) {
            return devices.map(device => ({ device, online: null, timeout: UNKNOWN_RECORDER_TIMEOUT }));
        }

        return devices
            .map((device, index) => {
                const address = normalizeAddress(device.url, DEFAULT_PORT);
                const endpoint = formatAddress(address).toLowerCase();
                const key = `${String(device.nodeId || '').trim().toLowerCase()}|${endpoint}`;
                const online = onlineEndpoints.has(key);
                return {
                    device,
                    online,
                    timeout: online ? ONLINE_RECORDER_TIMEOUT : OFFLINE_RECORDER_TIMEOUT,
                    index
                };
            })
            .sort((left, right) => Number(right.online) - Number(left.online) || left.index - right.index);
    }

    function getHostAddress() {
        const config = getConfiguredHost();
        const value = String(config?.address || config?.Address || '').trim();
        // 用户在面板里主动清空上位机地址时必须返回空 host，
        // 否则会被 normalizeAddress 回退成第一台手机的 IP，导致对手机的 5555 端口空跑心跳。
        if (!value) return { host: '', port: DEFAULT_HOST_PORT };
        return normalizeAddress(value, DEFAULT_HOST_PORT);
    }

    function getHostBaseUrl() {
        const address = getHostAddress();
        return address.host ? getBaseUrl(address.host, address.port) : '';
    }

    function parseJsonResponse(text) {
        try { return JSON.parse(text || '{}'); } catch (e) { return {}; }
    }

    function gmGet(url, timeout) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout,
                onload: res => resolve({
                    ok: res.status >= 200 && res.status < 300,
                    response: parseJsonResponse(res.responseText)
                }),
                onerror: () => resolve({ ok: false, response: {} }),
                ontimeout: () => resolve({ ok: false, response: {} })
            });
        });
    }

    async function canConnectHost() {
        const baseUrl = getHostBaseUrl();
        if (!baseUrl) return false;
        const result = await gmGet(`${baseUrl}/api/node-info`, HOST_CHECK_TIMEOUT);
        return result.ok &&
            result.response?.protocol === 'packingproof' &&
            Number(result.response?.protocolVersion) === 1;
    }

    // ============ 设备管理：探测 / 增删 / 局域网扫描 ============
    // 手机端(PackingProof-Mobile)：GET /api/storage -> {ok:true, service:"packingproof-mobile", port:5280}
    // 电脑端(PackingProof-Desktop)：GET /api/node-info -> {protocol:"packingproof", protocolVersion:1, ...}
    async function probeDeviceEndpoint(host, port) {
        const cleanHost = String(host || '').trim();
        const cleanPort = Number(port) || DEFAULT_PORT;
        if (!isAllowedMonitorHost(cleanHost)) {
            return { ok: false, kind: 'invalid', detail: '只允许局域网内网地址（10.x / 172.16~31.x / 192.168.x / 169.254.x）' };
        }
        const baseUrl = `http://${cleanHost}:${cleanPort}`;
        const storage = await gmGet(`${baseUrl}/api/storage`, DEVICE_PROBE_TIMEOUT);
        if (storage.ok && storage.response?.service === 'packingproof-mobile') {
            return { ok: true, kind: 'mobile', detail: '手机录像端' };
        }
        const node = await gmGet(`${baseUrl}/api/node-info`, DEVICE_PROBE_TIMEOUT);
        if (node.ok && node.response?.protocol === 'packingproof') {
            return {
                ok: true,
                kind: 'desktop',
                detail: '电脑端',
                nodeId: String(node.response?.nodeId || node.response?.NodeId || ''),
                nodeName: String(node.response?.nodeName || node.response?.NodeName || '')
            };
        }
        return { ok: false, kind: 'unreachable', detail: '连不上，请确认 App 已开启接收服务且在同一局域网' };
    }

    function recorderEndpointOf(device) {
        const raw = String(device?.url || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
        const parts = raw.split(':');
        const host = parts[0] || '';
        const port = Number(parts[1]) || DEFAULT_PORT;
        return host ? `${host}:${port}` : '';
    }

    function addRecorderDevice(entry) {
        const host = String(entry?.host || '').trim();
        const port = Number(entry?.port) || DEFAULT_PORT;
        if (!isAllowedMonitorHost(host)) return { ok: false, message: '地址无效：只允许局域网内网 IP' };
        if (!(port > 0 && port <= 65535)) return { ok: false, message: '端口无效' };
        const endpoint = `${host}:${port}`;
        const list = getConfiguredRecorders().slice();
        if (list.some(device => recorderEndpointOf(device) === endpoint)) {
            return { ok: false, message: `设备已存在：${endpoint}` };
        }
        const kind = entry?.kind === 'desktop' ? 'desktop' : 'mobile';
        list.push({
            nodeId: String(entry?.nodeId || '').trim() || `${kind}-${endpoint.replace(/[^0-9]/g, '-')}`,
            name: String(entry?.name || '').trim() || `${kind === 'desktop' ? '电脑' : '手机'}(${host})`,
            type: kind,
            url: `http://${endpoint}`
        });
        saveConfiguredRecorders(list);
        return { ok: true, message: `已添加：${endpoint}` };
    }

    function removeRecorderDevice(endpoint) {
        const list = getConfiguredRecorders().filter(device => recorderEndpointOf(device) !== endpoint);
        saveConfiguredRecorders(list);
        return { ok: true, message: `已删除：${endpoint}` };
    }

    function renameRecorderDevice(endpoint, name) {
        const list = getConfiguredRecorders().map(device => recorderEndpointOf(device) === endpoint
            ? Object.assign({}, device, { name: String(name || '').trim() || device.name })
            : device);
        saveConfiguredRecorders(list);
        return { ok: true };
    }

    // 扫描一个 /24 网段，找出所有正在监听的手机录像端
    async function scanLanForRecorders(prefix, port, onProgress, isAborted) {
        const targets = [];
        for (let i = 1; i <= 254; i++) targets.push(`${prefix}${i}`);
        const found = [];
        let scanned = 0;
        for (let i = 0; i < targets.length; i += LAN_SCAN_CONCURRENCY) {
            if (isAborted && isAborted()) break;
            const batch = targets.slice(i, i + LAN_SCAN_CONCURRENCY);
            const results = await Promise.all(batch.map(async host => {
                const res = await gmGet(`http://${host}:${port}/api/storage`, LAN_SCAN_TIMEOUT);
                return (res.ok && res.response?.service === 'packingproof-mobile')
                    ? { host, port: Number(port) || DEFAULT_PORT, kind: 'mobile' }
                    : null;
            }));
            scanned += batch.length;
            results.filter(Boolean).forEach(item => found.push(item));
            if (onProgress) onProgress(scanned, targets.length, found.slice());
        }
        return found;
    }

    // 专用工作页不显示业务菜单，避免用户误在工作页执行普通推送。
    if (!IS_REFUND_WORKER) {
        GM_registerMenuCommand('设备管理（添加/删除录像设备）', () => {
            openDeviceManager();
        });
        GM_registerMenuCommand('查看订单联动设备', () => {
            const devices = getRecorderDevices();
            const summary = devices.map(device =>
                `${device.name}：${device.url.replace(/^https?:\/\//i, '')}`).join('\n');
            showNotification(devices.length > 0
                ? `订单将群发给 ${devices.length} 台录像设备：\n${summary}`
                : '当前没有录像设备，请用菜单「设备管理」添加');
        });
        GM_registerMenuCommand('发送测试订单到全部设备', async () => {
            await sendTestOrder();
        });
        GM_registerMenuCommand('立即发送当前订单', () => {
            extractAndPush();
        });
        GM_registerMenuCommand('重新打开退款核验页', () => {
            GM_setValue(REFUND_WORKER_HEARTBEAT_KEY, 0);
            ensureRefundWorker(true, true);
        });
        const currentWindow = getCollectWindowHours();
        GM_registerMenuCommand(
            `采集时间范围：${currentWindow > 0 ? currentWindow + ' 小时内' : '不限'}（点击修改）`,
            () => {
                const input = prompt(
                    '只采集并推送最近多少小时内的订单？\n'
                    + '填 0 表示不限制。\n'
                    + '（退款核验按快递单号查询时始终不受此限制）',
                    String(getCollectWindowHours()));
                if (input === null) return;
                const hours = Number(String(input).trim());
                if (!Number.isFinite(hours) || hours < 0) {
                    showNotification('输入无效，请填写大于等于 0 的数字');
                    return;
                }
                setCollectWindowHours(hours);
                showNotification(hours > 0
                    ? `采集时间范围已设为最近 ${hours} 小时（菜单文字刷新页面后更新）`
                    : '采集时间范围已设为不限');
            });
        GM_registerMenuCommand('复制当前页推送数据(JSON)', () => {
            copyCurrentOrdersToClipboard();
        });
        GM_registerMenuCommand('诊断：打印表格行结构', () => {
            dumpRowStructure();
        });
    }

    // ============ 数据提取（拼多多官方打单） ============
    // 拼多多 beast-core 表格：订单行 = tr[data-testid="beast-core-table-body-tr"]
    // 各页签（待打印/已发货/打印后变化）列顺序不同，且表头文案不稳定，
    // 因此改用“按单元格内容/结构定位语义列”的方式，比固定下标或表头文案更稳健。
    // 纯金额/纯数量占位符判定（用于排除把“实付金额”列误判成商品列）
    function isPriceLikeText(text) {
        const t = String(text || '').replace(/\s+/g, '');
        if (!t) return true;
        // ¥0.00 / 0.00 / 12 / x1 / ¥9.9x2 等只由金额数量符号组成的文本
        return /^[¥￥]?[\d.]+([x×]\d+)?$/.test(t) || /^[¥￥\d.x×,，]+$/.test(t);
    }

    // 从多个“像商品列”的候选里挑真正的商品列：
    // 拼多多每个单元格都可能包 .render-content，原实现用 forEach 覆盖赋值导致
    // 最后一个候选（通常是金额列）胜出 → productInfo 变成 "0.00"。
    function pickProductColumn(tds, candidates, cols) {
        const taken = [cols.order, cols.remark, cols.shop, cols.recipient, cols.express, cols.change];
        const scored = candidates
            .filter(i => !taken.includes(i))
            .map(i => {
                const td = tds[i];
                const text = (td.textContent || '').replace(/\s+/g, ' ').trim();
                // 去掉金额/数量字符后剩余的“实义文字”长度——商品名一定有实义文字
                const meaningful = text.replace(/[¥￥\d.\sx×,，]/g, '').length;
                let score = meaningful;
                if (td.querySelector('img')) score += 50;      // 商品缩略图是强信号
                if (td.querySelector('.content-wrapper')) score += 15;
                return { i, score, priceLike: isPriceLikeText(text), meaningful };
            })
            .filter(s => !s.priceLike && s.meaningful >= 2)
            .sort((a, b) => b.score - a.score || a.i - b.i);
        return scored.length ? scored[0].i : -1;
    }

    function locateColumns(row) {
        const tds = Array.from(row.querySelectorAll('td'));
        const cols = { recipient: -1, express: -1, shipTime: -1, shop: -1, product: -1, remark: -1, change: -1, order: -1 };
        // 第一遍：先定位最稳定的“订单号”列（最右侧、含 .order-sn）
        tds.forEach((td, i) => {
            if (td.querySelector('.order-sn, span.order-sn')) cols.order = i;
        });
        // 第二遍：按结构与内容判定其余语义列（一律“首个匹配胜出”，避免被后面的列覆盖）
        const shipCandidates = [];
        const productCandidates = [];
        tds.forEach((td, i) => {
            if (i === cols.order) return;
            const text = td.textContent || '';
            if (td.querySelector('.render-content, .content-wrapper, .sc-gojNiO')) productCandidates.push(i);
            if (cols.remark === -1 && td.querySelector('.sc-frDJqD, .top_title')) cols.remark = i;
            else if (cols.shop === -1 && td.querySelector('.beast-core-ellipsis-1') && !/[省市区]/.test(text) && !/查看|修改/.test(text)) cols.shop = i;
            else if (cols.recipient === -1 && td.querySelector('.beast-core-ellipsis-1') && /[省市区]/.test(text)) cols.recipient = i;
            else if (cols.change === -1 && /退款|售后|退货|换货|修改地址/.test(text) && !td.querySelector('.sc-frDJqD')) cols.change = i;
            else if (cols.express === -1 && /\b(?:\d{11,}|[A-Z]{1,3}\d{9,})\b/.test(text)) cols.express = i;
            else if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) shipCandidates.push(i);
        });
        if (shipCandidates.length) cols.shipTime = Math.min.apply(null, shipCandidates);
        // 商品列：从候选里择优（排除金额列），而不是“最后一个覆盖”
        cols.product = pickProductColumn(tds, productCandidates, cols);
        // 商品列兜底：异常订单页结构不同，改找“带商品图且有实义文字”的单元格
        if (cols.product === -1) {
            const taken = [cols.order, cols.remark, cols.shop, cols.recipient, cols.express, cols.change];
            const idx = tds.findIndex((td, i) => !taken.includes(i) &&
                td.querySelector('img') &&
                !isPriceLikeText(td.textContent));
            if (idx >= 0) cols.product = idx;
        }
        // 兜底：若仍未定位到收件人/快递，则按固定相对位置（checkbox 之后第一列=收件人，第二列=快递）
        if (cols.recipient === -1 && tds.length > 1) cols.recipient = 1;
        if (cols.express === -1 && cols.recipient !== -1 && tds.length > cols.recipient + 1) cols.express = cols.recipient + 1;
        return cols;
    }

    function getExpressTd(row) {
        const cols = locateColumns(row);
        if (cols.express < 0) return null;
        const tds = row.querySelectorAll('td');
        return tds[cols.express] || null;
    }

    // 快递单号：在“快递信息”列出现（如 圆通 + YT0701933278209）。
    function extractTrackingNumber(td) {
        if (!td) return '';
        const text = td.textContent || '';
        const m = text.match(/\b(?:\d{11,}|[A-Z]{1,3}\d{9,})\b/);
        return m ? m[0] : '';
    }

    // 商品规格列：取 .content-wrapper 内的标题与规格文本，过滤掉“修改/查看”按钮、
    // 纯价格（¥x.xx）、纯数量（xN）与“0.00”占位符。
    function extractProductInfo(td) {
        if (!td) return '';
        const wrappers = td.querySelectorAll('.content-wrapper');
        const targets = wrappers.length ? wrappers : td.querySelectorAll('.render-content');
        const items = [];
        const seen = new Set();
        Array.from(targets).forEach(w => {
            const spans = Array.from(w.querySelectorAll('span'))
                .map(s => s.textContent.trim())
                .filter(t => t &&
                    !['修改', '查看', '添加备注'].includes(t) &&
                    !/^[x×]\d+$/.test(t) &&
                    !/^[¥￥]?\d+(\.\d+)?$/.test(t));
            const text = spans.join(' ').trim();
            if (text && !seen.has(text)) { seen.add(text); items.push(text); }
        });
        let joined = items.join('，').trim();
        if (!joined) {
            const clone = td.cloneNode(true);
            clone.querySelectorAll('a, button, style, input, img').forEach(n => n.remove());
            const txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
            const parts = txt.split(/\s{2,}|\n/).map(s => s.trim()).filter(Boolean)
                .filter(t => !['修改', '查看', '添加备注'].includes(t) &&
                    !/^[x×]\d+$/.test(t) &&
                    !/^[¥￥]?\d+(\.\d+)?$/.test(t));
            joined = parts.join(' ');
        }
        return joined;
    }

    // 商品件数提取：只信任结构化的数量标记，绝不从商品名文本里猜数字（否则会把
    // "爱心-12个装"的"12"误判成购买数量）。可信来源：
    //  ① .light-span 类角标（拼多多打单页数量徽章专用 class，如 <span class="light-span">x5</span>）
    //  ② 兜底：独立 span 文本恰好是 "xN/×N" 形式（其他页面变体）
    function extractQuantity(td) {
        if (!td) return 1;
        let total = 0;
        // ① 首选：.light-span 类角标
        td.querySelectorAll('.light-span').forEach(badge => {
            const t = (badge.textContent || '').trim();
            const m = t.match(/^[x×X*]\s*(\d+)$/);
            if (m) { const n = parseInt(m[1], 10); if (n > 0) total += n; }
        });
        if (total > 0) return total;
        // ② 兜底：整段文本为 xN/×N 的独立 span
        td.querySelectorAll('span').forEach(span => {
            const t = (span.textContent || '').trim();
            if (/^[x×X*]\s*(\d+)$/.test(t)) { const n = parseInt(t.replace(/^[x×X*]\s*/, ''), 10); if (n > 0) total += n; }
        });
        if (total > 0) return total;
        return 1;
    }

    // 备注留言列拆分：同一列内"N条备注"块=商家备注(sellerMemo)，"N条留言"块=买家留言(buyerMessage)。
    // 块结构：.sc-frDJqD > .top_title(含“备注”/“留言”文案) + .beast-core-ellipsis-2 span(文本)。
    function extractRemarkBlocks(td) {
        let buyerMessage = '';
        let sellerMemo = '';
        if (!td) return { buyerMessage, sellerMemo };
        const blocks = td.querySelectorAll('.sc-frDJqD');
        if (blocks.length) {
            blocks.forEach(block => {
                const title = (block.querySelector('.top_title')?.textContent || '');
                let textEl = block.querySelector('.beast-core-ellipsis-2 span, .beast-core-ellipsis-1 span, [data-testid="beast-core-ellipsis"] span');
                let text = (textEl?.textContent || '').trim();
                if (!text) {
                    const clone = block.cloneNode(true);
                    clone.querySelectorAll('a, button, style, input').forEach(n => n.remove());
                    text = clone.textContent.replace(/添加备注|条备注|条留言|修改/g, '').replace(/\s+/g, ' ').trim();
                }
                if (!text) return;
                if (/备注/.test(title)) sellerMemo = sellerMemo ? (sellerMemo + '，' + text) : text;
                else if (/留言/.test(title)) buyerMessage = buyerMessage ? (buyerMessage + '，' + text) : text;
                else buyerMessage = buyerMessage ? (buyerMessage + '，' + text) : text;
            });
        }
        if (!buyerMessage && !sellerMemo) {
            const clone = td.cloneNode(true);
            clone.querySelectorAll('a, button, style, input').forEach(n => n.remove());
            const fb = clone.textContent.replace(/添加备注|条备注|条留言|修改/g, '').replace(/\s+/g, ' ').trim();
            if (fb) buyerMessage = fb;
        }
        return { buyerMessage: buyerMessage.trim(), sellerMemo: sellerMemo.trim() };
    }

    function extractOrderId(row) {
        const byClass = (row.querySelector('.order-sn')?.textContent || '').trim();
        if (byClass) return byClass;
        // exception-order 页订单号在操作列且无 order-sn class，用订单号正则兜底
        const m = row.textContent.match(/\d{6}-\d{15}/);
        return m ? m[0] : '';
    }

    function extractChangeInfo(td) {
        if (!td) return { changeInfo: '', changeStatus: '' };
        const divs = Array.from(td.querySelectorAll('div'))
            .map(d => (d.textContent || '').trim())
            .filter(Boolean);
        // 变化说明列结构：<div>变化类型</div><div></div><div>处理状态</div>
        const changeStatus = divs.length ? divs[divs.length - 1] : '';
        const changeInfo = divs.slice(0, -1).join(' ').trim();
        return { changeInfo, changeStatus };
    }

    // 全行扫描退款标签：正常打单页没有“变化说明”列，退款状态是以红色小标签
    // （退款中/已退款/仅退款/退货退款…）的形式挂在状态列或商品列里。
    // 只看“叶子节点 + 短文本”，避免把买家留言里的“我要退款”误判为平台退款状态。
    function detectRowRefundText(row, cols) {
        const tds = Array.from(row.querySelectorAll('td'));
        const hits = [];
        tds.forEach((td, i) => {
            if (i === cols.remark) return; // 备注/留言列里的“退款”是买家诉求，不是订单状态
            td.querySelectorAll('span, div, em, i, label, p').forEach(node => {
                if (node.children.length) return;              // 只取叶子节点
                const text = (node.textContent || '').trim();
                if (!text || text.length > 12) return;          // 标签文本都很短
                if (/(仅退款|退货退款|退款成功|退款中|已退款|退款|退货|售后|换货)/.test(text)) hits.push(text);
            });
        });
        return Array.from(new Set(hits)).join('·');
    }

    function extractOrders(options) {
        options = options || {};
        const isExceptionPage = /\/print\/exception-order/.test(location.pathname || location.href);
        const orders = [];
        document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]').forEach(row => {
            try {
                const tds = row.querySelectorAll('td');
                const cols = locateColumns(row);
                const get = key => (cols[key] >= 0 && tds[cols[key]]) ? tds[cols[key]] : null;
                const recipientTd = get('recipient');
                const expressTd = get('express');
                const productTd = get('product');
                const remarkTd = get('remark');
                const shopTd = get('shop');
                const shipTd = get('shipTime');
                const changeTd = get('change');

                const orderId = extractOrderId(row);
                const trackingNumber = extractTrackingNumber(expressTd);
                const productInfo = extractProductInfo(productTd);
                const goodsQuantity = extractQuantity(productTd);
                const { buyerMessage, sellerMemo } = extractRemarkBlocks(remarkTd);
                const { changeInfo, changeStatus } = extractChangeInfo(changeTd);

                // 退款判定有两个来源：①异常页"变化说明"列 ②任意页面上的退款状态标签（正常打单页只有这个）
                const refundTagText = detectRowRefundText(row, cols);
                const isRefundChange = /(退款|售后|退货|refund|aftersale)/i.test([changeInfo, changeStatus].join(' '));
                // 仅变化说明属于退款/售后类时才算退款单，避免"修改地址"等非退款异常被误报为"已退款"
                const isRefundOrder = isRefundChange || !!refundTagText;
                // 静默规则：非退款类异常且已处理完毕 → 只归档不提示；
                // 退款单无论处理状态如何都必须提示（打印后退款要立刻拦截包裹，这是本工具的核心场景）。
                const isSilentRecord = !!(isExceptionPage && changeStatus && !/待处理/.test(changeStatus) && !isRefundOrder);

                // 买家名：收件人列内“white-space:nowrap”的 span（去掉查看/修改按钮）
                const nameSpan = recipientTd?.querySelector('span[style*="nowrap"]') || recipientTd?.querySelector('span');
                const buyerName = (nameSpan?.textContent || '').trim();
                // 地址：收件人列内 [data-testid="beast-core-ellipsis"] 的 span
                const address = (recipientTd?.querySelector('[data-testid="beast-core-ellipsis"] span')?.textContent || '').trim();
                // 店铺：店铺列 .beast-core-ellipsis-1 内的文本 span（跳过 <style>）
                const shop = (shopTd?.querySelector('.beast-core-ellipsis-1 span, .beast-core-ellipsis-2 span')?.textContent || '').trim();
                const shipTime = shipTd ? shipTd.textContent.trim() : '';
                // 该行最新时间(epoch ms)，供“默认只采集 48 小时内订单”的窗口过滤使用；0=未解析到时间
                const rowTimeMs = resolveRowTimestamp(row, shipTd);

                if (trackingNumber || buyerMessage || sellerMemo || productInfo || orderId || changeInfo) {
                    orders.push({
                        trackingNumber: trackingNumber,
                        orderId: orderId,
                        buyerMessage: buyerMessage,
                        sellerMemo: sellerMemo,
                        productInfo: productInfo,
                        goodsQuantity: goodsQuantity,
                        totalItemCount: goodsQuantity,
                        buyerName: buyerName,
                        address: address,
                        shop: shop,
                        shipTime: shipTime,
                        rowTimeMs: rowTimeMs,
                        changeInfo: changeInfo,
                        changeStatus: changeStatus,
                        silentRecord: isSilentRecord,
                        // 退款/异常信息映射到手机端可识别的退款字段：手机端 OrderInfoRecord.fromJson 只读 refundStatus/hasRefund 等固定字段，
                        // 故将"变化说明"写入 refundStatus、退款类变化置 hasRefund=true，使手机历史与原生播报(_announceOrderInfo)能识别该单为退款单。
                        // 普通订单页保持 NO_REFUND；手机端仅在录制开始、单号匹配当前录像会话条码时播报，无需改动手机 App。
                        hasRefund: isRefundOrder,
                        // isPrintedRefund 语义是"打印后退款"，仅异常页(打印后订单变化)才成立
                        isPrintedRefund: isExceptionPage && isRefundOrder,
                        refundStatus: isRefundOrder
                            ? ([changeInfo, changeStatus, refundTagText].filter(Boolean).join('·') || '退款')
                            : 'NO_REFUND',
                        refundProductInfo: '',
                        // 手机端 OrderInfo.fromMap 优先读取 pushTimeMilliseconds（epoch ms）；
                        // 桌面端 OrderInfo.PushTime 默认取 DateTime.Now，多出的字段会被忽略且不报错，故补充无害。
                        pushTimeMilliseconds: Date.now()
                    });
                }
            } catch (e) {
                console.warn('[打包监控] 提取订单异常:', e);
            }
        });
        // 合并单数：同一快递单号(面单)下聚合的订单数，写入每条订单（供手机端播报“本包裹包含 N 个订单”）。
        // 注意：同面单真正合并（productInfo 拼接 + totalItemCount 求和）在 collectAllOrders 末尾的
        // mergeOrdersByTracking 统一完成，这里只算行级订单数，避免两处重复求和。
        {
            const tCounts = Object.create(null);
            for (const o of orders) {
                const t = String(o.trackingNumber || '').trim().toUpperCase();
                if (t) tCounts[t] = (tCounts[t] || 0) + 1;
            }
            for (const o of orders) {
                const t = String(o.trackingNumber || '').trim().toUpperCase();
                o.mergedOrderCount = t ? (tCounts[t] || 1) : 1;
            }
        }
        return orders;
    }

    // ============ 虚拟滚动全量采集 ============
    // beast-core 表格只渲染可视区的十来行，直接 querySelectorAll 只能拿到约 11 条。
    // 这里找到真正的滚动容器，逐屏滚动并累积去重，取全当前页的订单。
    function findTableScrollContainer(startEl) {
        let node = startEl;
        while (node && node !== document.body && node !== document.documentElement) {
            const style = window.getComputedStyle(node);
            if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
                return node;
            }
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    // 读取分页信息，推算“当前页应该有多少行”。
    // 若 DOM 已挂载足够行数则无需滚动扫描，避免打扰正在操作列表的用户。
    // 任一信息解析不到就返回 -1，交由调用方保守地执行滚动扫描。
    function getExpectedPageRowCount() {
        try {
            const bodyText = document.body.innerText || '';
            const total = Number((bodyText.match(/共\s*(\d+)\s*条/) || [])[1]);
            const pageSize = Number((bodyText.match(/(\d+)\s*条\s*\/\s*页/) || [])[1]);
            if (!total || !pageSize) return -1;
            const activeEl = document.querySelector(
                '[class*="pagination"] [class*="active"], [class*="pagination"] [aria-current="true"]');
            const page = Number((activeEl?.textContent || '1').trim()) || 1;
            const expected = Math.min(pageSize, Math.max(total - (page - 1) * pageSize, 0));
            return expected > 0 ? expected : -1;
        } catch (e) {
            return -1;
        }
    }

    // ============ 采集时间窗口（默认最近 48 小时） ============
    // 目的：避免把列表里的历史旧单反复推给录像设备。
    // 时间来源：优先“发货/打印时间”列；该列没定位到时退化为扫描整行，取行内最新的一个时间。

    function getCollectWindowHours() {
        const raw = Number(GM_getValue(COLLECT_WINDOW_HOURS_KEY, DEFAULT_COLLECT_WINDOW_HOURS));
        return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_COLLECT_WINDOW_HOURS;
    }

    function setCollectWindowHours(hours) {
        GM_setValue(COLLECT_WINDOW_HOURS_KEY, hours);
    }

    // 用空格拼接元素内的文本节点：直接取 textContent 会把相邻 span 粘成
    // “2026-08-0922:31”，导致时间解析失败。
    function textWithSeparators(el) {
        if (!el) return '';
        const parts = [];
        const walk = node => {
            if (node.nodeType === 3) {
                const text = (node.nodeValue || '').trim();
                if (text) parts.push(text);
                return;
            }
            if (node.nodeType !== 1) return;
            if (/^(SCRIPT|STYLE)$/i.test(node.tagName || '')) return;
            Array.from(node.childNodes || []).forEach(walk);
        };
        walk(el);
        return parts.join(' ');
    }

    // 缺年份的日期按当前年推算；若推算结果比现在超前 1 天以上，说明它其实是去年的（跨年场景）
    function resolveYearlessTimestamp(month, day, hour, minute, second, now) {
        const base = new Date(now);
        const candidate = new Date(base.getFullYear(), month - 1, day, hour, minute, second);
        if (candidate.getTime() - now > 24 * 3600 * 1000) candidate.setFullYear(base.getFullYear() - 1);
        return candidate.getTime();
    }

    // 解析文本中出现的所有时间，返回 epoch ms 数组；解析不到返回空数组
    function parseTimestampsFromText(text, now) {
        const stamps = [];
        if (!text) return stamps;
        now = now || Date.now();
        let m;

        // ① 绝对日期：2026-08-09 22:31:05 / 2026/8/9 22:31 / 08-09 22:31
        //    前后加数字边界，避免把订单号 260803-243122880900908 的片段误判成日期
        const absolute = /(?<!\d)(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?!\d)/g;
        while ((m = absolute.exec(text)) !== null) {
            const month = Number(m[2]);
            const day = Number(m[3]);
            if (month < 1 || month > 12 || day < 1 || day > 31) continue;
            const hour = Number(m[4] || 0);
            const minute = Number(m[5] || 0);
            const second = Number(m[6] || 0);
            if (hour > 23 || minute > 59 || second > 59) continue;
            stamps.push(m[1]
                ? new Date(Number(m[1]), month - 1, day, hour, minute, second).getTime()
                : resolveYearlessTimestamp(month, day, hour, minute, second, now));
        }

        // ② 中文日期：2026年8月9日 22:31 / 8月9日 22:31
        const chinese = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/g;
        while ((m = chinese.exec(text)) !== null) {
            const month = Number(m[2]);
            const day = Number(m[3]);
            if (month < 1 || month > 12 || day < 1 || day > 31) continue;
            const hour = Number(m[4] || 0);
            const minute = Number(m[5] || 0);
            if (hour > 23 || minute > 59) continue;
            stamps.push(m[1]
                ? new Date(Number(m[1]), month - 1, day, hour, minute, 0).getTime()
                : resolveYearlessTimestamp(month, day, hour, minute, 0, now));
        }

        // ③ 相对时间：刚刚 / 3分钟前 / 2小时前 / 1天前
        if (/刚刚/.test(text)) stamps.push(now);
        const relative = /(\d+)\s*(分钟|小时|天)前/g;
        while ((m = relative.exec(text)) !== null) {
            const unit = m[2] === '分钟' ? 60000 : (m[2] === '小时' ? 3600000 : 86400000);
            stamps.push(now - Number(m[1]) * unit);
        }

        // ④ 今天/昨天/前天 + 时刻
        const dayWord = /(今天|昨天|前天)\s*(\d{1,2}):(\d{2})/g;
        while ((m = dayWord.exec(text)) !== null) {
            const offset = m[1] === '今天' ? 0 : (m[1] === '昨天' ? 1 : 2);
            const d = new Date(now);
            d.setDate(d.getDate() - offset);
            d.setHours(Number(m[2]), Number(m[3]), 0, 0);
            stamps.push(d.getTime());
        }

        return stamps;
    }

    // 取该行最新的时间作为参考时间（一行可能同时有下单时间与打印时间）；0 表示未解析到
    function resolveRowTimestamp(row, shipTd, now) {
        now = now || Date.now();
        let stamps = shipTd ? parseTimestampsFromText(textWithSeparators(shipTd), now) : [];
        if (!stamps.length && row) stamps = parseTimestampsFromText(textWithSeparators(row), now);
        return stamps.length ? Math.max.apply(null, stamps) : 0;
    }

    // 按时间窗口过滤；hours<=0 表示不限制。
    // 解析不到时间的行保守保留——宁可多推一条，也不能漏掉需要录像取证的订单。
    function filterOrdersByTimeWindow(orders, hours) {
        const list = orders || [];
        if (!hours || hours <= 0) return { kept: list, skipped: 0, unknown: 0, cutoff: 0 };
        const cutoff = Date.now() - hours * 3600 * 1000;
        let skipped = 0;
        let unknown = 0;
        const kept = list.filter(order => {
            const ms = Number(order && order.rowTimeMs) || 0;
            if (!ms) { unknown++; return true; }
            if (ms >= cutoff) return true;
            skipped++;
            return false;
        });
        return { kept, skipped, unknown, cutoff };
    }

    function orderDedupeKey(order) {
        return order.orderId ||
               order.trackingNumber ||
               [order.buyerName, order.productInfo, order.shipTime].filter(Boolean).join('|');
    }

    // 同一运单号(面单)下多个子订单（合并发货 / 一单多件）合并成一条订单：
    // 桌面端 v0.0.57 按运单号缓存单条订单（GetOrderInfo 命中最后一条），若不合并，
    // 扫码只会播报最后一个商品名。合并后 productInfo 拼接该包裹所有商品名（去重），
    // totalItemCount = 该包裹所有子订单件数求和，mergedOrderCount = 子订单数。
    // 必须在 collectAllOrders 收集完整个列表之后再合并——虚拟滚动下同面单的几行可能
    // 不同时出现在 DOM 中，若在 extractOrders 内合并会漏并。
    function mergeOrdersByTracking(orders) {
        if (!orders || orders.length <= 1) return orders || [];
        const merged = new Map();   // key: 大写运单号 -> 合并后的订单
        const result = [];
        for (const o of orders) {
            const t = String(o.trackingNumber || '').trim().toUpperCase();
            if (!t) { result.push(o); continue; }   // 无运单号：保持独立
            if (!merged.has(t)) {
                const base = Object.assign({}, o);
                base.mergedOrderCount = 1;
                merged.set(t, base);
                result.push(base);
                continue;
            }
            const base = merged.get(t);
            // 商品名拼接（去重，中文逗号分隔）
            if (o.productInfo) {
                const parts = (base.productInfo || '').split(/[，,]/).map(s => s.trim()).filter(Boolean);
                if (!parts.includes(o.productInfo)) parts.push(o.productInfo);
                base.productInfo = parts.join('，');
            }
            // 订单号拼接（去重）
            if (o.orderId && (base.orderId || '').indexOf(o.orderId) === -1) {
                base.orderId = base.orderId ? (base.orderId + ',' + o.orderId) : o.orderId;
            }
            // 买家留言 / 卖家备注 拼接（去重）
            if (o.buyerMessage && (base.buyerMessage || '').indexOf(o.buyerMessage) === -1) {
                base.buyerMessage = base.buyerMessage ? (base.buyerMessage + '，' + o.buyerMessage) : o.buyerMessage;
            }
            if (o.sellerMemo && (base.sellerMemo || '').indexOf(o.sellerMemo) === -1) {
                base.sellerMemo = base.sellerMemo ? (base.sellerMemo + '，' + o.sellerMemo) : o.sellerMemo;
            }
            // 件数求和 + 订单数累加
            base.totalItemCount = (Number(base.totalItemCount) || 0) + (Number(o.goodsQuantity) || 1);
            base.mergedOrderCount = (Number(base.mergedOrderCount) || 1) + 1;
            // 退款：任一子订单退款则整体视为退款；退款状态拼接去重
            if (o.hasRefund) base.hasRefund = true;
            if (o.isPrintedRefund) base.isPrintedRefund = true;
            if (o.refundStatus && o.refundStatus !== 'NO_REFUND') {
                if (!base.refundStatus || base.refundStatus === 'NO_REFUND') base.refundStatus = o.refundStatus;
                else if (base.refundStatus.indexOf(o.refundStatus) === -1) base.refundStatus += '·' + o.refundStatus;
            }
            // 静默：只要有一个非静默就提示
            base.silentRecord = base.silentRecord && o.silentRecord;
            // 时间取最新
            if ((Number(o.rowTimeMs) || 0) > (Number(base.rowTimeMs) || 0)) base.rowTimeMs = o.rowTimeMs;
        }
        return result;
    }

    async function collectAllOrders(options) {
        options = options || {};
        const firstRow = document.querySelector('tr[data-testid="beast-core-table-body-tr"]');
        if (!firstRow) return [];

        const container = findTableScrollContainer(firstRow);
        const originalTop = container.scrollTop;
        const collected = new Map();
        const harvest = () => extractOrders(options);
        const absorb = (orders) => {
            orders.forEach(order => {
                const key = orderDedupeKey(order);
                if (key && !collected.has(key)) collected.set(key, order);
            });
        };

        absorb(harvest());
        // DOM 已挂载的行数达到本页应有条数 → 说明没有被虚拟滚动截断，跳过扫描
        const domRows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]').length;
        const expected = getExpectedPageRowCount();
        const alreadyComplete = expected > 0 && domRows >= expected;
        const scrollable = !alreadyComplete && container.scrollHeight > container.clientHeight + 4;

        // 时间窗口用于滚动提前终止；options.timeWindowHours=0 或 <0 表示不限制。
        const windowHours = options.timeWindowHours === undefined
            ? getCollectWindowHours()
            : Number(options.timeWindowHours) || 0;
        const cutoff = windowHours > 0 ? Date.now() - windowHours * 3600 * 1000 : 0;
        const STOP_AFTER_CONSECUTIVE_EXPIRED_HARVESTS = 3;

        if (scrollable) {
            const step = Math.max(200, Math.floor(container.clientHeight * 0.75));
            let steps = 0;
            let consecutiveExpired = 0;
            let earlyStopReason = '';
            while (container.scrollTop + container.clientHeight < container.scrollHeight - 4 &&
                   steps++ < VIRTUAL_SCROLL_MAX_STEPS) {
                const before = container.scrollTop;
                container.scrollTop = Math.min(before + step, container.scrollHeight);
                await delay(VIRTUAL_SCROLL_SETTLE_MS);
                const snapshot = harvest();
                absorb(snapshot);
                if (container.scrollTop <= before) { earlyStopReason = '已滚动到底'; break; }

                // 提前终止：连续多屏都是有明确时间且全部超期，说明已越过时间窗口边界。
                if (cutoff > 0) {
                    const dated = snapshot.filter(o => Number(o && o.rowTimeMs) > 0);
                    const allExpired = dated.length > 0 && dated.every(o => o.rowTimeMs < cutoff);
                    if (allExpired) {
                        consecutiveExpired++;
                        if (consecutiveExpired >= STOP_AFTER_CONSECUTIVE_EXPIRED_HARVESTS) {
                            earlyStopReason = `连续 ${consecutiveExpired} 屏订单均超 ${windowHours} 小时窗口`;
                            break;
                        }
                    } else {
                        consecutiveExpired = 0;
                    }
                }
            }
            // 回到顶部再采一次：顶部行可能在滚动过程中被虚拟列表卸载
            container.scrollTop = 0;
            await delay(VIRTUAL_SCROLL_SETTLE_MS);
            absorb(harvest());
            container.scrollTop = originalTop;
            if (earlyStopReason) {
                debugLog(`[打包监控] 滚动提前终止: ${earlyStopReason}`);
            }
        }

        const orders = Array.from(collected.values());
        debugLog(`[打包监控] 全量采集完成: ${orders.length} 条 (本页应有=${expected > 0 ? expected : '未知'}, DOM挂载=${domRows}, 滚动扫描=${scrollable ? '是' : '否'}, 窗口=${windowHours > 0 ? windowHours + 'h' : '不限'})`);
        if (expected > 0 && orders.length < expected && !scrollable) {
            console.warn(`[PackingProof] 采集条数(${orders.length})少于本页应有条数(${expected})，可能仍有行未渲染`);
        }

        // 时间窗口过滤（默认 48 小时）。退款核验按单号精确查询时显式传 timeWindowHours: 0 关闭。
        const filtered = filterOrdersByTimeWindow(orders, windowHours);
        if (windowHours > 0 && (filtered.skipped > 0 || filtered.unknown > 0)) {
            console.info(`[PackingProof] 时间窗口 ${windowHours} 小时：保留 ${filtered.kept.length} 条`
                + `，过滤 ${filtered.skipped} 条超期订单`
                + (filtered.unknown ? `，${filtered.unknown} 条未解析到时间已保守保留` : ''));
        }
        // 时间窗口过滤后再合并同面单订单：保证同包裹所有子订单的商品名一起播报。
        const mergedOrders = mergeOrdersByTracking(filtered.kept);
        if (mergedOrders.length !== filtered.kept.length) {
            debugLog(`[PackingProof] 同面单合并：${filtered.kept.length} 条 → ${mergedOrders.length} 条`);
        }
        return mergedOrders;
    }

    // ============ 群发到录像设备 ============
    function sendOrderToRecorder(device, orders, timeout) {
        const address = normalizeAddress(device?.url || '', DEFAULT_PORT);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${getBaseUrl(address.host, address.port)}/api/orderinfo`,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data: JSON.stringify(orders),
                timeout,
                onload: res => resolve({
                    nodeId: device.nodeId,
                    name: device.name,
                    type: device.type,
                    address: formatAddress(address),
                    ok: res.status === 200,
                    status: res.status,
                    response: parseJsonResponse(res.responseText)
                }),
                onerror: () => resolve({ nodeId: device.nodeId, name: device.name, type: device.type, address: formatAddress(address), ok: false, error: 'connect' }),
                ontimeout: () => resolve({ nodeId: device.nodeId, name: device.name, type: device.type, address: formatAddress(address), ok: false, error: 'timeout' })
            });
        });
    }

    async function pushToMonitor(orders, options) {
        options = options || {};
        if (!orders || orders.length === 0) return { ok: false, confirmed: false, error: 'empty' };
        // 桌面端 WebServer 限制单次最多 200 条，超出则分批推送（中间批次静默，末尾统一提示）
        if (orders.length > MAX_ORDER_ITEMS_PER_REQUEST) {
            const chunks = [];
            for (let i = 0; i < orders.length; i += MAX_ORDER_ITEMS_PER_REQUEST) {
                chunks.push(orders.slice(i, i + MAX_ORDER_ITEMS_PER_REQUEST));
            }
            let last = { ok: false, confirmed: false, successfulCount: 0, targetCount: 0, results: [] };
            for (const chunk of chunks) {
                last = await pushToMonitor(chunk, Object.assign({}, options, { silent: true }));
            }
            if (!options.silent) {
                showNotification(`已向 ${last.successfulCount}/${last.targetCount} 台设备推送 ${orders.length} 条订单（分 ${chunks.length} 批）`);
            }
            return last;
        }
        const devices = getRecorderDevices();
        if (devices.length === 0) {
            if (!options.silent) showNotification('还没有配置录像设备，请点油猴菜单「设备管理」添加');
            return { ok: false, confirmed: false, error: 'no_recorders', results: [] };
        }
        const deliveryPlan = await buildRecorderDeliveryPlan(devices);
        // v3.5.7 patch：过滤掉已熔断的设备，熔断期内不推送避免雪崩；全部熔断则跳过本次推送
        const filteredPlan = deliveryPlan.filter(item => {
            const addr = formatAddress(normalizeAddress(item.device.url || '', DEFAULT_PORT));
            return !isDeviceCircuitOpen(addr);
        });
        if (filteredPlan.length === 0) {
            console.info(`[PackingProof] ${devices.length} 台录像设备均已熔断（连续失败），跳过本次推送；熔断期满后将自动重试`);
            return { ok: false, confirmed: false, error: 'all_circuits_open', results: [] };
        }
        const settled = await Promise.allSettled(
            filteredPlan.map(item => sendOrderToRecorder(item.device, orders, item.timeout))
        );
        const results = settled.map((entry, index) => {
            const item = filteredPlan[index];
            if (entry.status === 'fulfilled') {
                const r = entry.value;
                // v3.5.7 patch：记录每个 endpoint 的成功/失败用于熔断统计
                recordDeviceSendResult(r.address, r.ok);
                return r;
            }
            const failResult = {
                nodeId: item.device.nodeId,
                name: item.device.name,
                type: item.device.type,
                address: formatAddress(normalizeAddress(item.device.url || '', DEFAULT_PORT)),
                ok: false,
                error: entry.reason?.message || String(entry.reason || 'unknown')
            };
            recordDeviceSendResult(failResult.address, false);
            return failResult;
        });
        const successful = results.filter(result => result.ok);
        const confirmed = !options.isTest || successful.some(result => Number(result.response?.testCount || 0) > 0);
        console.info(`[PackingProof] 订单广播完成: ${successful.length}/${filteredPlan.length} 台`, results);
        // v3.5.7 patch：失败日志降频——同 endpoint 同错误 30 秒只打一条；
        // 服务端 5xx 时额外打印 response body（通常包含堆栈），便于定位 .158 NEO 等返回 500 的真实原因
        results.filter(result => !result.ok).forEach(result => {
            const errorKey = String(result.error || result.status || 'unknown');
            if (shouldLogDeviceFailure(result.address, errorKey)) {
                const detail = (result.status >= 500 && result.response && typeof result.response === 'object')
                    ? ` body=${JSON.stringify(result.response).slice(0, 240)}`
                    : '';
                console.warn(`[PackingProof] ${result.name} (${result.address}) 发送失败: ${result.error || result.status}${detail}`);
            }
        });

        if (!options.silent) {
            if (successful.length === 0) {
                showNotification(options.isTest ? '测试发送失败，请检查接收设备地址' : '订单发送失败，请检查接收设备网络');
            } else if (options.isTest) {
                showNotification(confirmed
                    ? `已有 ${successful.length}/${devices.length} 台设备收到测试订单`
                    : `测试订单已发送至 ${successful.length}/${devices.length} 台设备`);
            } else {
                showNotification(`已向 ${successful.length}/${devices.length} 台设备推送 ${orders.length} 条订单`);
            }
        }

        return {
            ok: successful.length > 0,
            confirmed,
            successfulCount: successful.length,
            targetCount: devices.length,
            results
        };
    }

    function requestMonitor(method, url, data, timeout) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: data ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
                data: data ? JSON.stringify(data) : undefined,
                timeout: timeout || 3000,
                onload: res => resolve({ status: res.status, body: parseJsonResponse(res.responseText) }),
                onerror: () => resolve({ status: 0, body: {} }),
                ontimeout: () => resolve({ status: 0, body: {} })
            });
        });
    }

    function getConnectionClientId() {
        let clientId = String(GM_getValue(CONNECTION_CLIENT_ID_KEY, '') || '').trim();
        if (/^[A-Za-z0-9._:-]{8,128}$/.test(clientId)) return clientId;
        clientId = `userscript-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        GM_setValue(CONNECTION_CLIENT_ID_KEY, clientId);
        return clientId;
    }

    async function sendConnectionHeartbeat() {
        if (!getHostBaseUrl()) return false;
        const response = await requestMonitor('POST', getConnectionHeartbeatUrl(), {
            clientId: getConnectionClientId(),
            clientType: 'userscript',
            displayName: '拼多多打单油猴脚本'
        }, 3000);
        return response.status === 200;
    }

    async function startConnectionHeartbeat() {
        if (await canConnectHost())
            await sendConnectionHeartbeat();
        setInterval(sendConnectionHeartbeat, CONNECTION_HEARTBEAT_INTERVAL_MS);
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getOrderListSignature() {
        return Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]')).map(row => {
            const orderId = extractOrderId(row);
            const trackingNumber = extractTrackingNumber(getExpressTd(row));
            return `${orderId}|${trackingNumber}`;
        }).join('||');
    }

    let lastPrintedRefundFilterClickAt = 0;

    // 拼多多没有“打印后退款”快捷筛选；由监控端下发待查单号时走 queryOrdersByTrackingNumbers。
    // 无待查单号时直接返回当前列表。
    async function queryPrintedRefundSnapshot() {
        // 退款核验不受采集时间窗口限制：几天前打印、今天才退款的包裹必须能查到
        return collectAllOrders({ timeWindowHours: 0 });
    }

    function selectLatestOrdersByTrackingNumber(orders, trackingNumbers) {
        const requested = Array.from(new Set((trackingNumbers || [])
            .map(value => String(value || '').trim().toUpperCase())
            .filter(Boolean)));
        const latest = new Map();
        (orders || []).forEach(order => {
            const key = String(order?.trackingNumber || '').trim().toUpperCase();
            if (requested.includes(key) && !latest.has(key)) latest.set(key, order);
        });

        return requested.map(trackingNumber => latest.get(trackingNumber) || {
            trackingNumber,
            orderId: '',
            buyerMessage: '',
            sellerMemo: '',
            productInfo: '',
            buyerName: '',
            address: '',
            shop: '',
            shipTime: '',
            hasRefund: false,
            isPrintedRefund: false,
            refundStatus: 'NO_REFUND',
            refundProductInfo: ''
        });
    }

    // 按下单/支付时间排序：尝试点击表头中带“时间/下单/支付”的列。拼多多排序 UI 未完全确认，失败仅记录。
    async function ensureNewestOrderFirstSort() {
        const header = document.querySelector('tr[data-testid="beast-core-table-header-tr"]');
        if (!header) return;
        const ths = Array.from(header.querySelectorAll('th'));
        const sortTh = ths.find(th => /时间|下单|支付/.test(th.textContent || ''));
        if (!sortTh) {
            debugLog('[打包监控] 未找到可排序的时间列，跳过排序');
            return;
        }
        sortTh.click();
        await delay(300);
    }

    // 按快递单号查询：使用顶部“订单编号/快递单号”搜索框（beast-core-input-htmlInput）。
    async function queryOrdersByTrackingNumbers(trackingNumbers) {
        const values = Array.from(new Set((trackingNumbers || []).map(value => String(value || '').trim().toUpperCase()).filter(Boolean)));
        if (values.length === 0) return [];

        const input = document.querySelector('input[data-testid="beast-core-input-htmlInput"]');
        if (!input) throw new Error('未找到订单编号/快递单号搜索框');
        input.value = values.join(',');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await delay(150);

        const searchBtn = Array.from(document.querySelectorAll('button, a'))
            .find(b => /查询|搜索|筛选/.test(b.textContent || ''));
        if (!searchBtn) throw new Error('未找到查询按钮');
        searchBtn.click();

        let signature = getOrderListSignature();
        let changed = false;
        let stableSince = Date.now();
        const deadline = Date.now() + PRINTED_REFUND_QUERY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await delay(100);
            const nextSignature = getOrderListSignature();
            if (nextSignature !== signature) {
                signature = nextSignature;
                changed = true;
                stableSince = Date.now();
            }
            if (changed && Date.now() - stableSince >= PRINTED_REFUND_STABLE_MS)
                // 按单号精确查询：关闭时间窗口，否则超过 48 小时的单号会查不到退款状态
                return selectLatestOrdersByTrackingNumber(await collectAllOrders({ timeWindowHours: 0 }), values);
        }
        throw new Error('按快递单号查询超时');
    }

    async function queryRequestedRefundSnapshot(trackingNumbers) {
        const requested = Array.from(new Set((trackingNumbers || []).map(value => String(value || '').trim().toUpperCase()).filter(Boolean)));
        if (requested.length === 0) return queryPrintedRefundSnapshot();
        return queryOrdersByTrackingNumbers(requested);
    }

    let orderLookupPollStarted = false;
    async function pollOrderLookupRequests() {
        let reconnectDelay = ORDER_LOOKUP_RECONNECT_MS;
        try {
            if (!document.querySelector('tr[data-testid="beast-core-table-body-tr"]')) {
                return;
            }
            // 没配置上位机时不要拼出相对路径去请求拼多多自己的域名
            if (!getHostBaseUrl()) return;
            const response = await requestMonitor('GET', getOrderLookupPendingUrl(), null, 25000);
            writeRefundWorkerHeartbeat();
            if (response.status === 200) reconnectDelay = 0;
            const pending = response.status === 200 ? response.body : null;
            if (pending?.pending && pending.requestId) {
                let orders = [];
                let success = false;
                let error = '';
                try {
                    orders = await queryRequestedRefundSnapshot(pending.trackingNumbers || []);
                    success = true;
                } catch (e) {
                    error = e?.message || String(e);
                    console.warn('[打包监控] 获取退款订单快照失败:', error);
                }

                await requestMonitor('POST', getOrderLookupResultUrl(), {
                    requestId: pending.requestId,
                    success: success,
                    orders: orders,
                    error: error
                }, 5000);
                debugLog(`[打包监控] 已回传退款订单快照: success=${success}, ${orders.length} 条`);
            }
        } catch (e) {
            debugLog('[打包监控] 轮询扫码核验请求失败:', e);
        } finally {
            if (reconnectDelay > 0) {
                setTimeout(pollOrderLookupRequests, reconnectDelay);
            } else {
                Promise.resolve().then(pollOrderLookupRequests);
            }
        }
    }

    function startOrderLookupPolling() {
        if (!IS_REFUND_WORKER) return;
        if (orderLookupPollStarted) return;
        orderLookupPollStarted = true;
        pollOrderLookupRequests();
    }

    // ============ 扩展 API 授权（官方 v2.14.3 移植，不影响现有功能）============
    const EXTENSION_PROVIDER_ID = 'gude55.pinduoduo';
    const EXTENSION_DISPLAY_NAME = 'PackingProof 拼多多打单订单联动';
    const EXTENSION_PERMISSIONS = ['scan-tasks.read', 'scan-results.write'];
    const EXTENSION_CAPABILITIES = ['order.lookup', 'refund.lookup'];
    const EXTENSION_CREDENTIAL_KEY = 'packingproof_extension_credential_v1';
    const EXTENSION_INSTANCE_ID_KEY = 'packingproof_extension_instance_id_v1';
    const EXTENSION_ENROLL_RETRY_AT_KEY = 'packingproof_extension_enroll_retry_at_v1';
    const EXTENSION_ENROLL_RETRY_MS = 10 * 60 * 1000;

    function bytesToHex(b) { return Array.from(b, v => v.toString(16).padStart(2, '0')).join(''); }
    function hexToBytes(v) { const n = String(v || '').trim(); if (n.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(n)) throw new Error('invalid_hex'); return new Uint8Array(n.match(/../g).map(x => parseInt(x, 16))); }
    function randomHex(len) { const b = new Uint8Array(len); crypto.getRandomValues(b); return bytesToHex(b); }
    async function sha256Hex(b) { return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', b))); }
    async function hmacSha256Hex(keyHex, value) { const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))); }
    function getScriptVersion() { return String(GM_info?.script?.version || '3.6').trim(); }
    function getExtensionInstanceId() { let v = String(GM_getValue(EXTENSION_INSTANCE_ID_KEY, '') || '').trim(); if (/^[A-Za-z0-9._:-]{8,128}$/.test(v)) return v; v = `pdd-${randomHex(16)}`; GM_setValue(EXTENSION_INSTANCE_ID_KEY, v); return v; }
    function loadExtensionCredential() { const v = GM_getValue(EXTENSION_CREDENTIAL_KEY, null); if (!v || typeof v !== 'object') return null; const c = String(v.credential || '').trim(), id = String(v.extensionInstanceId || '').trim(), h = String(v.host || '').trim(), g = Number(v.credentialGeneration || 0); return /^[a-f0-9]{64}$/i.test(c) && /^[A-Za-z0-9._:-]{8,128}$/.test(id) && Number.isSafeInteger(g) && g > 0 && h ? { credential: c, extensionInstanceId: id, host: h, credentialGeneration: g } : null; }
    function clearExtensionCredential() { GM_setValue(EXTENSION_CREDENTIAL_KEY, null); }
    async function signedExtensionRequest(method, requestTarget, data, timeout, credentialState) {
        const state = credentialState || loadExtensionCredential(); if (!state) return { status: 0, body: {}, error: 'not_authorized' };
        const baseUrl = getHostBaseUrl(); if (!baseUrl || state.host !== baseUrl) return { status: 0, body: {}, error: 'host_changed' };
        const bodyText = data == null ? '' : JSON.stringify(data); const timestamp = Math.floor(Date.now() / 1000), nonce = randomHex(16);
        const contentHash = await sha256Hex(new TextEncoder().encode(bodyText));
        const canonical = ['packingproof-extension-request-v1','1',String(state.credentialGeneration),String(method||'').toUpperCase(),requestTarget,String(timestamp),nonce,contentHash,state.extensionInstanceId].join('\n');
        const signature = await hmacSha256Hex(state.credential, canonical);
        return new Promise(r => GM_xmlhttpRequest({ method, url: `${baseUrl}${requestTarget}`, headers: { ...(data==null?{}:{'Content-Type':'application/json; charset=utf-8'}), 'X-PackingProof-Extension-Version':'1', 'X-PackingProof-Extension-Id':state.extensionInstanceId, 'X-PackingProof-Extension-Credential-Generation':String(state.credentialGeneration), 'X-PackingProof-Extension-Timestamp':String(timestamp), 'X-PackingProof-Extension-Nonce':nonce, 'X-PackingProof-Extension-Content-SHA256':contentHash, 'X-PackingProof-Extension-Signature':signature }, data: data==null?undefined:bodyText, timeout: Number(timeout)||3000, onload: res => r({status:res.status, body:parseJsonResponse(res.responseText)}), onerror:()=>r({status:0,body:{},error:'connect'}), ontimeout:()=>r({status:0,body:{},error:'timeout'}) }));
    }
    async function enrollExtension(baseUrl) {
        if (Date.now() < Number(GM_getValue(EXTENSION_ENROLL_RETRY_AT_KEY, 0) || 0)) return null;
        const resp = await requestMonitor('POST', `${baseUrl}/api/extensions/v1/enroll`, { requestId:`enroll-${randomHex(12)}`, requestSecret:randomHex(32), extensionInstanceId:getExtensionInstanceId(), providerId:EXTENSION_PROVIDER_ID, displayName:EXTENSION_DISPLAY_NAME, version:getScriptVersion(), source:location.origin, requestedPermissions:EXTENSION_PERMISSIONS, requestedCapabilities:EXTENSION_CAPABILITIES }, 120000);
        if (resp.status !== 200 || !resp.body?.credential) { GM_setValue(EXTENSION_ENROLL_RETRY_AT_KEY, Date.now() + EXTENSION_ENROLL_RETRY_MS); return null; }
        const state = { host: baseUrl, extensionInstanceId:String(resp.body.extensionInstanceId||''), credential:String(resp.body.credential||''), credentialGeneration:Number(resp.body.credentialGeneration||0) };
        GM_setValue(EXTENSION_CREDENTIAL_KEY, state); GM_setValue(EXTENSION_ENROLL_RETRY_AT_KEY, 0); return loadExtensionCredential();
    }
    async function ensureExtensionAuthorization() {
        const baseUrl = getHostBaseUrl(); if (!baseUrl || !globalThis.crypto?.subtle) return null;
        const caps = await requestMonitor('GET', `${baseUrl}/api/extensions/v1/capabilities`, null, 2500);
        if (caps.status !== 200 || caps.body?.extensionApiEnabled !== true || caps.body?.features?.signedScanTasks !== true) return null;
        let state = loadExtensionCredential();
        if (state?.host === baseUrl) {
            const hb = await signedExtensionRequest('POST', '/api/extensions/v1/heartbeat', { version:getScriptVersion(), capabilities:EXTENSION_CAPABILITIES, lastSuccessfulActivityAt:null, dataCount:0 }, 3000, state);
            if (hb.status === 200) return state;
            if ([401,403].includes(hb.status)) clearExtensionCredential(); else return null;
        }
        return enrollExtension(baseUrl);
    }
    function toExtensionOrder(order) {
        const hasRefund = order?.hasRefund === true || order?.isPrintedRefund === true;
        return { trackingNumber:String(order?.trackingNumber||'').trim(), orderId:String(order?.orderId||'').trim(), buyerMessage:String(order?.buyerMessage||''), sellerMemo:String(order?.sellerMemo||''), totalItemCount:Number(order?.goodsQuantity||order?.totalItemCount||0), products:[], refundState:hasRefund?'requested':'none', refundReason:String(order?.refundStatus||order?.refundProductInfo||'') };
    }
    async function processExtensionDelivery(delivery, credentialState) {
        const deliveryId = String(delivery?.deliveryId||''), taskId = String(delivery?.taskId||'');
        if (!deliveryId || !taskId) return false;
        const ack = await signedExtensionRequest('POST', `/api/extensions/v1/scan-tasks/${encodeURIComponent(deliveryId)}/ack`, { taskId }, 3000, credentialState);
        if (ack.status !== 200) return false;
        let status = 'unavailable', orders = [];
        try { const found = await collectAllOrders({}); orders = found.map(toExtensionOrder); status = orders.length > 0 ? 'found' : 'not_found'; } catch(e) { console.warn('[PackingProof] 扩展扫码查询失败:', e?.message||e); }
        const result = await signedExtensionRequest('POST', '/api/extensions/v1/scan-results', { deliveryId, taskId, providerId:EXTENSION_PROVIDER_ID, resultId:`${deliveryId}-result-1`, revision:1, status, observedAt:new Date().toISOString(), orders, measurements:[] }, 10000, credentialState);
        if (![200,202].includes(result.status)) return false;
        await signedExtensionRequest('POST', '/api/extensions/v1/heartbeat', { version:getScriptVersion(), capabilities:EXTENSION_CAPABILITIES, lastSuccessfulActivityAt:new Date().toISOString(), dataCount:Math.max(1,orders.length) }, 3000, credentialState);
        return true;
    }
    async function runExtensionTaskLoop(credentialState) {
        let state = credentialState;
        while (state) {
            const resp = await signedExtensionRequest('GET', '/api/extensions/v1/scan-tasks/next?waitSeconds=20', null, 25000, state);
            if (resp.status === 204) continue;
            if (resp.status === 200 && resp.body?.deliveryId) { await processExtensionDelivery(resp.body, state); continue; }
            if ([401,403].includes(resp.status)) clearExtensionCredential();
            return false;
        }
        return false;
    }
    async function startExtensionTaskPolling() {
        const credentialState = await ensureExtensionAuthorization();
        if (!credentialState) return false;
        runExtensionTaskLoop(credentialState).catch(e => console.warn('[PackingProof] 扩展任务轮询已停止:', e?.message||e)).finally(() => startOrderLookupPolling());
        return true;
    }

    function buildTestOrder() {
        const now = new Date();
        const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(v => String(v).padStart(2, '0'))
            .join('');
        return [{
            trackingNumber: `TEST${hhmmss}`,
            orderId: '测试订单',
            buyerMessage: '这是一条测试买家留言',
            sellerMemo: '这是一条测试卖家备注',
            productInfo: '测试商品',
            buyerName: '测试买家',
            address: '测试地址',
            shop: '测试店铺',
            shipTime: '',
            isTest: true
        }];
    }

    let testOrderSending = false;
    async function sendTestOrder() {
        if (testOrderSending) {
            showNotification('测试订单正在发送，请稍候');
            return;
        }

        testOrderSending = true;
        showNotification(`正在向 ${getRecorderDevices().length} 个录像设备发送测试订单`);
        try {
            await pushToMonitor(buildTestOrder(), { isTest: true });
        } finally {
            testOrderSending = false;
        }
    }

    // 识别拼多多官方打单页当前激活的打印状态标签（未打印 / 已打印 / 全部等）。
    function getCurrentPrintTab() {
        try {
            // 1. 优先从 URL 参数读取（拼多多部分页面用 printStatus / status / tab 参数）
            const params = new URL(location.href).searchParams;
            const fromUrl = params.get('printStatus') || params.get('status') || params.get('tab') || '';
            if (fromUrl) {
                const map = {
                    '0': '全部', 'all': '全部', 'quanbu': '全部',
                    '1': '已打印', 'printed': '已打印', 'yidayin': '已打印',
                    '2': '未打印', 'unprinted': '未打印', 'weidayin': '未打印',
                    '3': '待打印', 'pending': '待打印', 'daidayin': '待打印',
                    '4': '已锁定', 'locked': '已锁定', 'yisuoding': '已锁定',
                    '5': '寄件下单', 'jijiangxiadan': '寄件下单'
                };
                const lower = String(fromUrl).toLowerCase();
                if (map[lower]) return map[lower];
                return fromUrl;
            }

            const tabNames = ['未打印', '待打印', '已打印', '全部', '已锁定', '寄件下单'];

            // 2. 用精确选择器定位 active tab（覆盖拼多多 beast-core 组件常见 class）
            const activeSelectors = [
                '.tab-item.active', '.tab-item[aria-selected="true"]',
                '[role="tab"].active', '[role="tab"][aria-selected="true"]',
                '.filter-tab-item.active', '.filter-tab-item[aria-selected="true"]',
                '.order-tab-item.active', '.order-tab-item[aria-selected="true"]',
                '.header-tab-item.active', '.header-tab-item[aria-selected="true"]',
                '.beast-core-tabs-tab.active', '.beast-core-tabs-tab[aria-selected="true"]',
                '[class*="TabsTab"].active', '[class*="TabsTab"][aria-selected="true"]',
                '[class*="tabs-tab"].active', '[class*="tabs-tab"][aria-selected="true"]',
                '[class*="TabBar"][class*="active"]'
            ];
            const activeEls = Array.from(document.querySelectorAll(activeSelectors.join(',')));
            for (const el of activeEls) {
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                const tabName = text.replace(/\s*\d+\s*$/, '').trim();
                if (tabNames.some(t => tabName.includes(t))) return tabName;
            }

            // 3. fallback：扫描页面上所有文本元素，找包含标签文案且看起来是 active 的元素
            const allEls = Array.from(document.querySelectorAll('div, span, button, a, li'));
            for (const el of allEls) {
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                const tabName = text.replace(/\s*\d+\s*$/, '').trim();
                if (!tabNames.some(t => tabName.includes(t))) continue;
                if (el.classList.contains('active') ||
                    el.getAttribute('aria-selected') === 'true' ||
                    el.getAttribute('aria-current') === 'true' ||
                    /active|selected|current/.test(el.className)) {
                    return tabName;
                }
            }

            return '';
        } catch (e) {
            return '';
        }
    }

    // 判断当前页面是否属于脚本应当注入采集的页面范围。
    // 售后查询、系统设置等 /print/* 子页面不在范围内。
    function isSupportedOrderPage() {
        if (IS_REFUND_WORKER) return true;
        const path = location.pathname || '';
        return /^\/print\/order\//.test(path) || /^\/print\/exception-order/.test(path);
    }

    // 普通打单页是否应当自动全量采集/推送。
    // - 退款工作页（exception-order）始终允许。
    // - 只有 /print/order/* 和 /print/exception-order* 会走到这里，其他页面已由 isSupportedOrderPage 过滤。
    // - 已发货订单页（/print/order/delivered 等）没有「已打印」标签，但订单本身已发货，直接允许。
    // - /print/order/list 等普通打单页只有在「已打印」标签下才自动全量采集；
    //   「未打印/待打印/全部」等不自动推送，避免把未打印订单误推给录像设备。
    // - 未识别到标签时默认不自动采集（防止选择器没覆盖到导致误采）。
    // - 用户点击「打印/发货/批量」等操作按钮后的触发不受此限制（那是动作触发）。
    function shouldAutoExtractOnOrderPage() {
        if (IS_REFUND_WORKER) return true;
        const path = location.pathname || '';
        // v3.5.7：明确限定页面范围，售后/设置等页面不允许自动采集。
        if (!/^\/print\/order\//.test(path) && !/^\/print\/exception-order/.test(path)) return false;
        // 已发货/已送达页面没有打印状态 tab，但订单状态本身就是已发货，允许采集
        if (/\/print\/order\/(delivered|shipped|sent)\b/.test(path)) return true;
        const tab = getCurrentPrintTab();
        debugLog('[打包监控] 当前打印状态标签识别为:', tab || '(未识别)', 'pathname:', path);
        return /已打印/.test(tab);
    }

    async function extractAndPush(options) {
        options = options || {};
        // 非用户主动操作（按钮点击）时，只在「已打印」标签下自动全量采集。
        if (options.trigger !== 'action' && !shouldAutoExtractOnOrderPage()) {
            const tab = getCurrentPrintTab();
            console.info(`[PackingProof] 当前位于「${tab || '未知'}」标签（${location.pathname}），跳过自动全量采集`);
            return;
        }
        // 必须用全量采集：虚拟滚动下直接提取只能拿到可视区约 11 行
        const orders = await collectAllOrders(options);
        const domRows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]').length;
        const windowHours = options.timeWindowHours === undefined
            ? getCollectWindowHours()
            : Number(options.timeWindowHours) || 0;
        // 防重复推送：仅推送“新订单”或“内容已变化”的订单；其余已推送过的跳过，
        // 避免页面频繁变动（直播时间、悬浮提示等）导致无限重复扫描+推送。
        const freshOrders = orders.filter(o => {
            const key = o.orderId || o.orderSn || (o.trackingNumber + '|' + (o.goodsQuantity || 1));
            const sig = orderPushSignature(o);
            if (pushedOrderSigs.get(key) === sig) return false;
            pushedOrderSigs.set(key, sig);
            return true;
        });
        // 调试输出：只在有变更订单或无订单时打印，避免页面频繁抖动导致控制台刷屏。
        if (freshOrders.length > 0 || orders.length === 0) {
            console.info(`[PackingProof] 全量采集 ${orders.length} 条（新/变更 ${freshOrders.length} 条）`
                + `(当前DOM仅挂载 ${domRows} 行, 时间窗口=${windowHours > 0 ? windowHours + ' 小时' : '不限'})`,
                JSON.parse(JSON.stringify(orders)));
        } else {
            debugLog('[PackingProof] 全量采集完成，无新增/变更订单');
        }
        if (orders.length === 0) {
            if (!options.silent) {
                showNotification(windowHours > 0
                    ? `当前页面没有 ${windowHours} 小时内的订单`
                    : '当前页面没有找到订单信息');
            }
            return;
        }
        if (freshOrders.length === 0) {
            debugLog('[PackingProof] 无新订单（均与已推送内容一致），跳过推送');
            return;
        }
        // 已处理/已退款订单只录制、不提示：拆成静默通道推送，避免弹窗打扰
        const strip = o => { const c = Object.assign({}, o); delete c.silentRecord; return c; };
        const silentOrders = freshOrders.filter(o => o.silentRecord).map(strip);
        const normalOrders = freshOrders.filter(o => !o.silentRecord).map(strip);
        if (normalOrders.length) await pushToMonitor(normalOrders, options);
        if (silentOrders.length) await pushToMonitor(silentOrders, Object.assign({}, options, { silent: true }));
    }

    // 供调试：把当前页面提取到的订单 JSON 复制到剪贴板
    async function copyCurrentOrdersToClipboard() {
        try {
            const orders = await collectAllOrders({});
            const json = JSON.stringify(orders, null, 2);
            // 优先用油猴 GM_setClipboard，不受 HTTPS/焦点限制；失败再降级到原生剪贴板/prompt
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(json);
                showNotification(`已复制 ${orders.length} 条订单 JSON 到剪贴板`);
                return;
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(json);
                showNotification(`已复制 ${orders.length} 条订单 JSON 到剪贴板`);
            } else {
                prompt('当前页订单 JSON（Ctrl+C 复制）:', json.slice(0, 2000));
            }
        } catch (err) {
            console.warn('[PackingProof] 复制失败:', err);
            const orders = await collectAllOrders({});
            const json = JSON.stringify(orders, null, 2);
            prompt('当前页订单 JSON（Ctrl+C 复制）:', json.slice(0, 2000));
        }
    }

    // 诊断工具：把每一行的单元格结构与列定位结果打到控制台，
    // 用于排查“某些行商品/备注抓不到”这类 DOM 变体问题（把输出复制出来即可定位）。
    function dumpRowStructure() {
        const rows = Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]'));
        console.info(`[PackingProof][诊断] 当前 DOM 挂载 ${rows.length} 行`);
        rows.forEach((row, rowIndex) => {
            const cols = locateColumns(row);
            const tds = Array.from(row.querySelectorAll('td'));
            const named = Object.entries(cols)
                .filter(([, v]) => v >= 0)
                .map(([k, v]) => `${k}=${v}`).join(' ');
            console.groupCollapsed(`[行 ${rowIndex}] 列定位: ${named || '(全部失败)'}`);
            tds.forEach((td, i) => {
                const text = (td.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                const role = Object.keys(cols).find(k => cols[k] === i) || '-';
                console.info(`  td[${i}] <${role}> class="${(td.className || '').slice(0, 70)}" text="${text}"`);
            });
            console.info('  退款标签:', detectRowRefundText(row, cols) || '(无)');
            // 时间窗口诊断：看清这一行会不会被“默认 48 小时”过滤掉
            const shipTd = cols.shipTime >= 0 ? tds[cols.shipTime] : null;
            const rowTimeMs = resolveRowTimestamp(row, shipTd);
            const windowHours = getCollectWindowHours();
            const withinWindow = !windowHours || !rowTimeMs || rowTimeMs >= Date.now() - windowHours * 3600 * 1000;
            console.info(`  行时间: ${rowTimeMs ? new Date(rowTimeMs).toLocaleString() : '(未解析到)'}`
                + ` | 窗口 ${windowHours > 0 ? windowHours + 'h' : '不限'} → ${withinWindow ? '保留' : '过滤'}`);
            console.groupEnd();
        });
        showNotification(`已在控制台打印 ${rows.length} 行结构，按 F12 查看 Console`);
    }

    // ============ 设备管理面板（UI） ============
    let deviceManagerOverlay = null;
    let lanScanAborted = false;

    function uiEl(tag, style, props) {
        const node = document.createElement(tag);
        if (style) Object.assign(node.style, style);
        if (props) Object.assign(node, props);
        return node;
    }

    const UI_BTN = {
        padding: '5px 12px', fontSize: '12px', lineHeight: '20px', cursor: 'pointer',
        border: '1px solid #d9d9d9', borderRadius: '6px', background: '#fff',
        color: '#333', whiteSpace: 'nowrap'
    };
    const UI_BTN_PRIMARY = Object.assign({}, UI_BTN, {
        border: '1px solid #e02e24', background: '#e02e24', color: '#fff'
    });
    const UI_INPUT = {
        padding: '6px 10px', fontSize: '13px', border: '1px solid #d9d9d9',
        borderRadius: '6px', outline: 'none', boxSizing: 'border-box', color: '#333',
        background: '#fff'
    };

    function openDeviceManager() {
        if (deviceManagerOverlay) {
            deviceManagerOverlay.style.display = 'flex';
            deviceManagerOverlay.__refresh();
            return;
        }

        const overlay = uiEl('div', {
            position: 'fixed', inset: '0', zIndex: '2147483000',
            background: 'rgba(0,0,0,.35)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            font: '13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif'
        });
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) closeDeviceManager();
        });

        const panel = uiEl('div', {
            width: '620px', maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto',
            background: '#fff', borderRadius: '12px', padding: '20px 22px',
            boxShadow: '0 12px 40px rgba(0,0,0,.28)', color: '#333', boxSizing: 'border-box'
        });

        // ---- 标题 ----
        const header = uiEl('div', { display: 'flex', alignItems: 'center', marginBottom: '4px' });
        header.appendChild(uiEl('div', { fontSize: '16px', fontWeight: '600', flex: '1' },
            { textContent: 'PackingProof 设备管理' }));
        const closeBtn = uiEl('div', {
            cursor: 'pointer', fontSize: '20px', lineHeight: '20px', color: '#999', padding: '0 4px'
        }, { textContent: '×', title: '关闭' });
        closeBtn.onclick = closeDeviceManager;
        header.appendChild(closeBtn);
        panel.appendChild(header);
        panel.appendChild(uiEl('div', { color: '#888', fontSize: '12px', marginBottom: '14px' },
            { textContent: '订单会同时群发给下面所有录像设备。配置保存在油猴存储里，脚本升级后不会丢失。' }));

        // ---- 设备列表 ----
        panel.appendChild(sectionTitle('录像设备'));
        const listBox = uiEl('div', {
            border: '1px solid #eee', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px'
        });
        panel.appendChild(listBox);

        // ---- 添加设备 ----
        panel.appendChild(sectionTitle('添加设备'));
        const addRow = uiEl('div', { display: 'flex', gap: '8px', marginBottom: '8px' });
        const nameInput = uiEl('input', Object.assign({}, UI_INPUT, { flex: '1 1 120px', minWidth: '0' }),
            { type: 'text', placeholder: '设备名称（选填）' });
        const ipInput = uiEl('input', Object.assign({}, UI_INPUT, { flex: '1 1 150px', minWidth: '0' }),
            { type: 'text', placeholder: '设备 IP，如 192.168.68.199' });
        const portInput = uiEl('input', Object.assign({}, UI_INPUT, { flex: '0 0 80px' }),
            { type: 'text', placeholder: '端口', value: String(DEFAULT_PORT) });
        addRow.appendChild(nameInput);
        addRow.appendChild(ipInput);
        addRow.appendChild(portInput);
        panel.appendChild(addRow);

        const addActions = uiEl('div', { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' });
        const addBtn = uiEl('button', UI_BTN_PRIMARY, { textContent: '检测并添加', type: 'button' });
        const scanBtn = uiEl('button', UI_BTN, { textContent: '扫描局域网', type: 'button' });
        const addTip = uiEl('div', { fontSize: '12px', color: '#888', flex: '1' });
        addActions.appendChild(addBtn);
        addActions.appendChild(scanBtn);
        addActions.appendChild(addTip);
        panel.appendChild(addActions);

        const scanBox = uiEl('div', { marginBottom: '16px' });
        panel.appendChild(scanBox);

        // ---- 上位机 ----
        panel.appendChild(sectionTitle('上位机（电脑端，选填）'));
        panel.appendChild(uiEl('div', { color: '#888', fontSize: '12px', marginBottom: '8px' },
            { textContent: '用于查询设备在线状态与退款联动；只用手机录像时可以留空。' }));
        const hostRow = uiEl('div', { display: 'flex', gap: '8px', marginBottom: '16px' });
        const hostInput = uiEl('input', Object.assign({}, UI_INPUT, { flex: '1', minWidth: '0' }),
            { type: 'text', placeholder: `如 192.168.68.138:${DEFAULT_HOST_PORT}` });
        const hostTestBtn = uiEl('button', UI_BTN, { textContent: '测试', type: 'button' });
        const hostSaveBtn = uiEl('button', UI_BTN_PRIMARY, { textContent: '保存', type: 'button' });
        hostRow.appendChild(hostInput);
        hostRow.appendChild(hostTestBtn);
        hostRow.appendChild(hostSaveBtn);
        panel.appendChild(hostRow);

        // ---- 底部 ----
        const footer = uiEl('div', {
            display: 'flex', gap: '8px', alignItems: 'center',
            borderTop: '1px solid #eee', paddingTop: '12px'
        });
        const resetBtn = uiEl('button', UI_BTN, { textContent: '恢复内置默认配置', type: 'button' });
        const testAllBtn = uiEl('button', UI_BTN, { textContent: '发送测试订单', type: 'button' });
        const footerTip = uiEl('div', { fontSize: '12px', color: '#888', flex: '1', textAlign: 'right' });
        footer.appendChild(resetBtn);
        footer.appendChild(testAllBtn);
        footer.appendChild(footerTip);
        panel.appendChild(footer);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        deviceManagerOverlay = overlay;

        function sectionTitle(text) {
            return uiEl('div', { fontSize: '13px', fontWeight: '600', margin: '0 0 8px' }, { textContent: text });
        }

        function statusDot(color, title) {
            return uiEl('span', {
                display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                background: color, marginRight: '8px', flex: '0 0 8px'
            }, { title: title || '' });
        }

        function renderList() {
            listBox.textContent = '';
            const devices = getRecorderDevices();
            if (devices.length === 0) {
                listBox.appendChild(uiEl('div', { padding: '16px', color: '#999', textAlign: 'center' },
                    { textContent: '还没有录像设备，请在下方添加' }));
            }
            devices.forEach((device, index) => {
                const endpoint = recorderEndpointOf(device);
                const row = uiEl('div', {
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                    borderTop: index === 0 ? 'none' : '1px solid #f0f0f0'
                });
                const dot = statusDot('#ccc', '未检测');
                row.appendChild(dot);
                const info = uiEl('div', { flex: '1', minWidth: '0' });
                info.appendChild(uiEl('div', { fontSize: '13px', fontWeight: '500' },
                    { textContent: device.name }));
                info.appendChild(uiEl('div', { fontSize: '12px', color: '#888' }, {
                    textContent: `${endpoint} · ${device.type === 'desktop' ? '电脑端' : device.type === 'mobile' ? '手机端' : '未知类型'}`
                }));
                row.appendChild(info);

                const renameBtn = uiEl('button', UI_BTN, { textContent: '改名', type: 'button' });
                renameBtn.onclick = () => {
                    const next = prompt('设备名称：', device.name);
                    if (next === null) return;
                    renameRecorderDevice(endpoint, next);
                    renderList();
                };
                const testBtn = uiEl('button', UI_BTN, { textContent: '测试', type: 'button' });
                testBtn.onclick = async () => {
                    testBtn.disabled = true;
                    testBtn.textContent = '检测中';
                    dot.style.background = '#faad14';
                    const [host, port] = endpoint.split(':');
                    const probe = await probeDeviceEndpoint(host, port);
                    dot.style.background = probe.ok ? '#52c41a' : '#ff4d4f';
                    dot.title = probe.ok ? `在线（${probe.detail}）` : probe.detail;
                    testBtn.disabled = false;
                    testBtn.textContent = '测试';
                };
                const delBtn = uiEl('button', Object.assign({}, UI_BTN, { color: '#e02e24' }),
                    { textContent: '删除', type: 'button' });
                delBtn.onclick = () => {
                    if (!confirm(`确定删除设备「${device.name}」(${endpoint}) 吗？`)) return;
                    removeRecorderDevice(endpoint);
                    renderList();
                    refreshFooter();
                };
                row.appendChild(renameBtn);
                row.appendChild(testBtn);
                row.appendChild(delBtn);
                listBox.appendChild(row);

                // 打开面板时自动检测一次
                probeDeviceEndpoint(endpoint.split(':')[0], endpoint.split(':')[1]).then(probe => {
                    dot.style.background = probe.ok ? '#52c41a' : '#ff4d4f';
                    dot.title = probe.ok ? `在线（${probe.detail}）` : probe.detail;
                });
            });
        }

        function refreshFooter() {
            footerTip.textContent = isUsingCustomRecorders()
                ? `当前使用自定义配置 · ${getRecorderDevices().length} 台设备`
                : `当前使用脚本内置配置 · ${getRecorderDevices().length} 台设备`;
            const hostAddress = getHostAddress();
            hostInput.value = hostAddress.host ? `${hostAddress.host}:${hostAddress.port}` : '';
        }

        addBtn.onclick = async () => {
            const raw = ipInput.value.trim().replace(/^https?:\/\//i, '');
            const host = raw.split(':')[0].trim();
            const port = Number(raw.split(':')[1] || portInput.value || DEFAULT_PORT);
            if (!host) { addTip.textContent = '请填写设备 IP'; return; }
            addBtn.disabled = true;
            addTip.style.color = '#888';
            addTip.textContent = '正在检测设备…';
            const probe = await probeDeviceEndpoint(host, port);
            if (!probe.ok && probe.kind === 'invalid') {
                addTip.style.color = '#e02e24';
                addTip.textContent = probe.detail;
                addBtn.disabled = false;
                return;
            }
            if (!probe.ok && !confirm(`${host}:${port} 当前连不上（${probe.detail}）。\n仍然要添加吗？`)) {
                addTip.textContent = '';
                addBtn.disabled = false;
                return;
            }
            const result = addRecorderDevice({
                host, port,
                kind: probe.kind === 'desktop' ? 'desktop' : 'mobile',
                name: nameInput.value.trim() || probe.nodeName || '',
                nodeId: probe.nodeId || ''
            });
            addTip.style.color = result.ok ? '#52c41a' : '#e02e24';
            addTip.textContent = result.message;
            if (result.ok) {
                nameInput.value = '';
                ipInput.value = '';
                renderList();
                refreshFooter();
            }
            addBtn.disabled = false;
        };

        scanBtn.onclick = async () => {
            if (scanBtn.dataset.scanning === '1') {
                lanScanAborted = true;
                return;
            }
            const guess = getDefaultHost() || '192.168.1.1';
            const defaultPrefix = guess.split('.').slice(0, 3).join('.') + '.';
            const prefix = prompt('扫描哪个网段？（会逐个探测 x.1 ~ x.254）', defaultPrefix);
            if (prefix === null) return;
            const cleanPrefix = String(prefix).trim().replace(/\.*$/, '') + '.';
            if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.$/.test(cleanPrefix)) {
                addTip.style.color = '#e02e24';
                addTip.textContent = '网段格式不对，应形如 192.168.68.';
                return;
            }
            const scanPort = Number(portInput.value) || DEFAULT_PORT;
            lanScanAborted = false;
            scanBtn.dataset.scanning = '1';
            scanBtn.textContent = '停止扫描';
            scanBox.textContent = '';
            const progress = uiEl('div', { fontSize: '12px', color: '#888', marginBottom: '6px' },
                { textContent: '准备扫描…' });
            const resultBox = uiEl('div', {});
            scanBox.appendChild(progress);
            scanBox.appendChild(resultBox);

            const shown = new Set();
            const found = await scanLanForRecorders(cleanPrefix, scanPort, (done, total, items) => {
                progress.textContent = `扫描中 ${done}/${total}，已发现 ${items.length} 台`;
                items.forEach(item => {
                    const endpoint = `${item.host}:${item.port}`;
                    if (shown.has(endpoint)) return;
                    shown.add(endpoint);
                    const row = uiEl('div', {
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '6px 10px', border: '1px solid #eee', borderRadius: '6px', marginBottom: '6px'
                    });
                    row.appendChild(statusDot('#52c41a', '在线'));
                    row.appendChild(uiEl('div', { flex: '1' }, { textContent: `${endpoint} · 手机录像端` }));
                    const already = getRecorderDevices().some(device => recorderEndpointOf(device) === endpoint);
                    const btn = uiEl('button', already ? UI_BTN : UI_BTN_PRIMARY,
                        { textContent: already ? '已添加' : '添加', type: 'button', disabled: already });
                    btn.onclick = () => {
                        const result = addRecorderDevice({ host: item.host, port: item.port, kind: 'mobile' });
                        btn.disabled = true;
                        btn.textContent = result.ok ? '已添加' : '失败';
                        Object.assign(btn.style, UI_BTN);
                        renderList();
                        refreshFooter();
                    };
                    row.appendChild(btn);
                    resultBox.appendChild(row);
                });
            }, () => lanScanAborted);

            progress.textContent = lanScanAborted
                ? `已停止，共发现 ${found.length} 台设备`
                : (found.length ? `扫描完成，共发现 ${found.length} 台设备` : '扫描完成，没有发现设备（请确认手机 App 已开启接收服务）');
            scanBtn.dataset.scanning = '0';
            scanBtn.textContent = '扫描局域网';
        };

        hostTestBtn.onclick = async () => {
            const raw = hostInput.value.trim().replace(/^https?:\/\//i, '');
            const host = raw.split(':')[0];
            const port = Number(raw.split(':')[1] || DEFAULT_HOST_PORT);
            hostTestBtn.disabled = true;
            hostTestBtn.textContent = '检测中';
            const probe = await probeDeviceEndpoint(host, port);
            showNotification(probe.ok ? `上位机连通正常（${probe.detail}）` : `上位机连不上：${probe.detail}`);
            hostTestBtn.disabled = false;
            hostTestBtn.textContent = '测试';
        };

        hostSaveBtn.onclick = () => {
            const raw = hostInput.value.trim().replace(/^https?:\/\//i, '');
            if (!raw) {
                saveConfiguredHost({ NodeId: '', NodeName: '', Address: '' });
                showNotification('已清空上位机地址');
                refreshFooter();
                return;
            }
            const host = raw.split(':')[0];
            const port = Number(raw.split(':')[1] || DEFAULT_HOST_PORT);
            if (!isAllowedMonitorHost(host)) {
                showNotification('上位机地址无效：只允许局域网内网 IP');
                return;
            }
            const current = getConfiguredHost() || {};
            saveConfiguredHost({
                NodeId: current.NodeId || current.nodeId || '',
                NodeName: current.NodeName || current.nodeName || '',
                Address: `http://${host}:${port}`
            });
            showNotification(`上位机已保存：${host}:${port}`);
            refreshFooter();
        };

        resetBtn.onclick = () => {
            if (!confirm('确定恢复到脚本内置的默认设备配置吗？你自己添加的设备会被清除。')) return;
            resetConfiguredRecorders();
            renderList();
            refreshFooter();
            showNotification('已恢复内置默认配置');
        };

        testAllBtn.onclick = async () => {
            testAllBtn.disabled = true;
            testAllBtn.textContent = '发送中…';
            await sendTestOrder();
            testAllBtn.disabled = false;
            testAllBtn.textContent = '发送测试订单';
        };

        overlay.__refresh = () => { renderList(); refreshFooter(); };
        overlay.__refresh();
    }

    function closeDeviceManager() {
        lanScanAborted = true;
        if (deviceManagerOverlay) deviceManagerOverlay.style.display = 'none';
    }

    // ============ 页面通知 ============
    function showNotification(msg) {
        const el = document.createElement('div');
        el.textContent = msg;
        Object.assign(el.style, {
            position: 'fixed', top: '20px', right: '20px', zIndex: '99999',
            padding: '12px 20px', borderRadius: '8px',
            background: 'rgba(0,0,0,.8)', color: '#fff', fontSize: '14px',
            fontFamily: 'Microsoft YaHei, sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,.3)',
            transition: 'opacity .3s'
        });
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
    }

    // ============ 自动推送：监听页面变化 + 操作按钮点击 ============
    let pushTimer = null;
    function schedulePush(options) {
        options = options || {};
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            extractAndPush(options);
        }, 2000); // 页面加载/翻页后 2 秒自动推送
    }

    // 监听底部/顶部操作按钮点击（打印、发货、批量打印、生成面单等）。
    function bindActionButtons() {
        const candidates = [
            document.querySelector('[class*="actionBar"]'),
            document.querySelector('[class*="toolbar"]'),
            document.querySelector('[class*="ActionBar"]'),
            document.querySelector('[class*="filterBar"]'),
            document.body
        ];
        const container = candidates.find(Boolean);
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('button, a, [role="button"], input[type="button"]');
            if (btn && /打印|发货|批量|生成|面单/.test(btn.textContent || '')) {
                debugLog('[打包监控] 检测到操作按钮点击:', btn.textContent?.trim());
                schedulePush({ trigger: 'action' });
            }
        });
        debugLog('[打包监控] 操作按钮监听已绑定');
    }

    // 监听订单列表区域的 DOM 变化（订单行新增、翻页 innerHTML 替换等）。
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1) {
                        if (node.matches?.('tr[data-testid="beast-core-table-body-tr"]') ||
                            node.querySelector?.('tr[data-testid="beast-core-table-body-tr"]') ||
                            node.tagName === 'TBODY' ||
                            node.tagName === 'TABLE' ||
                            node.matches?.('[class*="table"]')) {
                            debugLog('[打包监控] 检测到订单DOM变化，准备推送');
                            schedulePush({ trigger: 'dom' });
                            return;
                        }
                    }
                }
            }
            if (m.removedNodes.length > 0 && m.addedNodes.length > 0) {
                debugLog('[打包监控] 检测到DOM子节点替换，准备推送');
                schedulePush({ trigger: 'dom' });
                return;
            }
        }
    });

    startConnectionHeartbeat();

    if (IS_REFUND_WORKER) {
        setTimeout(async () => {
            if (!await startRefundWorkerHeartbeat()) return;
            // 工作页开在 exception-order，同样需要监听列表变化并自动提取推送异常订单。
            const target = document.querySelector('table') ||
                           document.querySelector('tr[data-testid="beast-core-table-body-tr"]')?.closest('table')?.parentElement ||
                           document.body;
            observer.observe(target, { childList: true, subtree: true });
            debugLog('[打包监控] 退款工作页 DOM 监听已启动, 目标:', target.tagName, target.className || '(body)');
            bindActionButtons();
            extractAndPush();

            const startWhenHostAvailable = async () => {
                if (await canConnectHost()) {
                    // 优先走扩展 API（enroll + 签名扫码任务），失败回退到旧版 order-lookup 轮询
                    if (!await startExtensionTaskPolling()) startOrderLookupPolling();
                    return;
                }
                setTimeout(startWhenHostAvailable, REFUND_WORKER_RECHECK_INTERVAL_MS);
            };
            await startWhenHostAvailable();
        }, 3000);
    } else {
        // 普通页面只负责订单推送，不再领取退款请求或切换筛选。
        setTimeout(async () => {
            // v3.5.7：非退款工作页且不在订单采集范围内时，直接不启动 observer，避免售后/设置等页面被误扫。
            if (!isSupportedOrderPage()) {
                console.info('[PackingProof] 当前页面不在订单采集范围内，已跳过自动采集:', location.pathname);
                return;
            }
            await saveRefundWorkerTabIdentity(false);
            const target = document.querySelector('table') ||
                           document.querySelector('tr[data-testid="beast-core-table-body-tr"]')?.closest('table')?.parentElement ||
                           document.body;
            observer.observe(target, { childList: true, subtree: true });
            debugLog('[打包监控] DOM 监听已启动, 目标:', target.tagName, target.className || '(body)');
            bindActionButtons();
            const monitorReachable = await canConnectHost();
            extractAndPush();
            maintainRefundWorker(monitorReachable);
            setInterval(() => maintainRefundWorker(), REFUND_WORKER_RECHECK_INTERVAL_MS);
        }, 3000);
    }

    debugLog('[打包监控] 油猴脚本已加载', CHANGELOG);
})();
