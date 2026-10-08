// sort-drag.js
// 排序面板拖拽控制器（Pointer Events 实现，鼠标 / 触屏 / 触控笔统一处理）
//
// 相比原生 HTML5 Drag & Drop 的改进：
//   1. 统一指针事件：鼠标按下即可拖；触屏点住“拖拽把手”立即拖（无需长按 300ms），
//      长按其它区域仍可作为兜底入口。
//   2. 落点只在“位置真的变化”时才写 DOM，避免高频 dragover 造成的重排抖动。
//   3. 命中测试只读 rect，并且不依赖 requestAnimationFrame（后台标签页 rAF 会被冻结），
//      指针事件直接同步更新，手感与可见性无关。
//   4. 靠近列表上下边缘时自动滚动（定时器驱动），可以把分组拖到可视区域之外。
//   5. Esc 取消拖拽并还原原始位置。

export function createSortDragController(options = {}) {
    const config = {
        groupSelector: '.qr-sort-group',
        listSelector: '.qr-sort-list',
        handleSelector: '.qr-sort-drag-handle',
        draggingClass: 'dragging',
        cloneClass: 'qr-sort-drag-clone',
        bodyDraggingClass: 'qr-sort-dragging',
        moveThreshold: 4,       // 鼠标：超过该位移才真正开始拖拽
        touchThreshold: 3,      // 触屏把手：超过该位移即开始
        longPressDelay: 350,    // 触屏非把手区域：长按多久进入拖拽
        edgeSize: 28,           // 边缘自动滚动触发区高度
        scrollInterval: 16,     // 自动滚动步进间隔（毫秒）
        maxScrollSpeed: 16,     // 每次步进最大滚动像素
        onDrop: () => {},
        ...options
    };

    let drag = null;            // 当前拖拽会话
    let candidate = null;       // 已按下但尚未达到拖拽阈值
    let cloneEl = null;
    let scrollTimer = null;

    const isGroup = el => !!el && el.classList && el.classList.contains(config.groupSelector.slice(1));

    /** 命中测试：返回指针下的分组列表容器 */
    function findListAt(x, y) {
        const el = document.elementFromPoint(x, y);
        const list = el && el.closest ? el.closest(config.listSelector) : null;
        return list || (drag ? drag.list : null);
    }

    /** 依据当前指针位置更新落点（只在位置变化时改 DOM） */
    function applyPoint() {
        if (!drag || !drag.active) return;
        const { x, y } = drag.point;

        if (cloneEl) {
            cloneEl.style.transform =
                `translate3d(${x - drag.offsetX - drag.startLeft}px, ${y - drag.offsetY - drag.startTop}px, 0)`;
        }

        const targetList = findListAt(x, y);
        if (!targetList) return;

        const siblings = Array.from(targetList.children)
            .filter(el => isGroup(el) && el !== drag.group);

        let refNode = null;
        for (const el of siblings) {
            const rect = el.getBoundingClientRect();
            if (y < rect.top + rect.height / 2) {
                refNode = el;
                break;
            }
        }

        // 关键：只有目标位置真的变化时才动 DOM，避免抖动与无谓重排
        if (drag.group.parentElement !== targetList || drag.group.nextElementSibling !== refNode) {
            targetList.insertBefore(drag.group, refNode);
            drag.list = targetList;
        }
    }

    /** 边缘自动滚动（定时器步进，滚动后重新计算落点） */
    function autoScrollStep() {
        if (!drag || !drag.active) return;
        const list = drag.list;
        if (!list) return;

        const rect = list.getBoundingClientRect();
        const { y } = drag.point;
        const max = list.scrollHeight - list.clientHeight;
        if (max <= 0) return;

        let dir = 0;
        if (y < rect.top + config.edgeSize) dir = -1;
        else if (y > rect.bottom - config.edgeSize) dir = 1;
        if (dir === 0) return;

        const before = list.scrollTop;
        list.scrollTop = Math.max(0, Math.min(max, before + dir * config.maxScrollSpeed));
        if (list.scrollTop !== before) applyPoint();
    }

    function startAutoScroll() {
        if (scrollTimer !== null) return;
        scrollTimer = setInterval(autoScrollStep, config.scrollInterval);
    }

    function stopAutoScroll() {
        if (scrollTimer !== null) {
            clearInterval(scrollTimer);
            scrollTimer = null;
        }
    }

    /** 真正开始拖拽：建立克隆体、占位样式与全局监听 */
    function beginDrag(event, headerEl, groupEl) {
        clearCandidate();
        if (drag) return;

        const rect = groupEl.getBoundingClientRect();
        drag = {
            active: true,
            group: groupEl,
            header: headerEl,
            list: groupEl.parentElement,
            originList: groupEl.parentElement,
            originNext: groupEl.nextElementSibling,
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startLeft: rect.left,
            startTop: rect.top,
            point: { x: event.clientX, y: event.clientY }
        };

        groupEl.classList.add(config.draggingClass);
        document.body.classList.add(config.bodyDraggingClass);

        cloneEl = groupEl.cloneNode(true);
        cloneEl.classList.remove(config.draggingClass);
        cloneEl.classList.add(config.cloneClass);
        cloneEl.style.width = `${rect.width}px`;
        cloneEl.style.height = `${rect.height}px`;
        cloneEl.style.left = `${rect.left}px`;
        cloneEl.style.top = `${rect.top}px`;
        cloneEl.style.transform = 'translate3d(0, 0, 0)';
        document.body.appendChild(cloneEl);

        if (navigator.vibrate) navigator.vibrate(10);

        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerCancel, true);
        window.addEventListener('keydown', onKeyDown, true);
        startAutoScroll();
    }

    /** 结束拖拽；cancelled 为真时还原到拖拽前的位置 */
    function endDrag(cancelled) {
        if (!drag || !drag.active) {
            clearCandidate();
            return;
        }

        const session = drag;
        drag = null;

        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerCancel, true);
        window.removeEventListener('keydown', onKeyDown, true);
        stopAutoScroll();

        if (cancelled) {
            const anchor = session.originNext && session.originNext.parentElement === session.originList
                ? session.originNext
                : null;
            session.originList.insertBefore(session.group, anchor);
        }

        session.group.classList.remove(config.draggingClass);
        document.body.classList.remove(config.bodyDraggingClass);

        if (cloneEl) {
            const dying = cloneEl;
            cloneEl = null;
            dying.style.transition = 'opacity 0.12s ease';
            dying.style.opacity = '0';
            setTimeout(() => dying.remove(), 150);
        }

        if (!cancelled) config.onDrop();
    }

    function clearCandidate() {
        if (candidate) {
            if (candidate.longPressTimer) clearTimeout(candidate.longPressTimer);
            candidate = null;
        }
        window.removeEventListener('pointermove', onCandidateMove, true);
        window.removeEventListener('pointerup', onCandidateUp, true);
        window.removeEventListener('pointercancel', onCandidateUp, true);
    }

    function onCandidateMove(event) {
        if (!candidate || event.pointerId !== candidate.pointerId) return;
        const dx = event.clientX - candidate.startX;
        const dy = event.clientY - candidate.startY;
        const dist = Math.hypot(dx, dy);

        if (dist <= candidate.threshold) return;

        if (candidate.longPressTimer) clearTimeout(candidate.longPressTimer);
        // 触屏非把手区域：移动即视为滚动列表，放弃拖拽
        if (candidate.needLongPress) {
            clearCandidate();
            return;
        }

        const { headerEl, groupEl } = candidate;
        clearCandidate();
        beginDrag(event, headerEl, groupEl);
        applyPoint();
    }

    function onCandidateUp(event) {
        if (!candidate || event.pointerId !== candidate.pointerId) return;
        clearCandidate();
    }

    function onPointerMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.point.x = event.clientX;
        drag.point.y = event.clientY;
        // 触屏时阻止页面滚动/选中
        if (event.cancelable && event.pointerType !== 'mouse') event.preventDefault();
        applyPoint();
    }

    function onPointerUp(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        endDrag(false);
    }

    function onPointerCancel(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        endDrag(true);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') endDrag(true);
    }

    /**
     * 绑定一个分组（头部为拖拽区，内部按钮不触发拖拽）
     */
    function bind(headerEl, groupEl) {
        headerEl.addEventListener('pointerdown', (event) => {
            if (drag || candidate) return;
            if (event.button !== undefined && event.button !== 0) return;
            // 避开操作按钮 / 链接 / 输入控件
            if (event.target.closest && event.target.closest('button, a, input, textarea, select')) return;

            const onHandle = !!(event.target.closest && event.target.closest(config.handleSelector));
            const isTouch = event.pointerType && event.pointerType !== 'mouse';
            // 触屏：非把手区域需要长按才进入拖拽，保证列表仍可正常滑动
            const needLongPress = isTouch && !onHandle;

            candidate = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                threshold: isTouch ? config.touchThreshold : config.moveThreshold,
                needLongPress,
                headerEl,
                groupEl
            };

            window.addEventListener('pointermove', onCandidateMove, true);
            window.addEventListener('pointerup', onCandidateUp, true);
            window.addEventListener('pointercancel', onCandidateUp, true);

            if (needLongPress) {
                candidate.longPressTimer = setTimeout(() => {
                    if (!candidate) return;
                    const startEvent = {
                        pointerId: candidate.pointerId,
                        clientX: candidate.startX,
                        clientY: candidate.startY
                    };
                    const { headerEl: h, groupEl: g } = candidate;
                    clearCandidate();
                    beginDrag(startEvent, h, g);
                }, config.longPressDelay);
            }
        });
    }

    return {
        bind,
        isDragging: () => !!drag,
        destroy: () => endDrag(true)
    };
}
