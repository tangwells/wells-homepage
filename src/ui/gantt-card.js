'use strict';

const { pad2, formatDateYMD, parseYMD, addDaysYMD, diffDaysYMD } = require('../utils/date');
const { el, preserveScroll } = require('../utils/dom');
const { buildOrthogonalDepPath } = require('../parsers/project');
const { openFileAtLine, runQuickAddChoice } = require('../services/vault-adapter');

function createGanttCardSection({
  app,
  obsidian,
  store,
  modals,
  getSettings,
  getScrollEl,
  updateSettings,
  ganttSlot,
}) {
  let cardBuilt = false;
  let ganttMount = null;
  let searchInput = null;
  let zoomButtons = new Map();
  let statusPillsWrap = null;
  let statusPillButtons = new Map();

  let timelineRightEl = null;
  let todayOffsetPx = 0;
  let activeGanttDragCleanup = null;
  let activeGanttPopover = null;
  let ganttRenderSeq = 0;

  function cleanupInteractions() {
    if (activeGanttDragCleanup) {
      try { activeGanttDragCleanup(); } catch (_e) {}
      activeGanttDragCleanup = null;
    }
    if (activeGanttPopover) {
      try { activeGanttPopover.remove(); } catch (_e) {}
      activeGanttPopover = null;
    }
  }

  function syncToolbarControls() {
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    for (const [zk, btn] of zoomButtons.entries()) {
      btn.classList.toggle('is-active', settings.ganttZoom === zk);
    }

    const nonCancelled = (state.projects || []).filter((p) => p.status !== 'cancel');
    const isOverdueProj = (p) => p.status !== 'done' && Boolean(p.projEnd) && p.projEnd < today;
    const statusCounts = {
      all: nonCancelled.length,
      doing: nonCancelled.filter((p) => p.status === 'doing').length,
      overdue: nonCancelled.filter(isOverdueProj).length,
      done: nonCancelled.filter((p) => p.status === 'done').length,
    };

    const labels = {
      all: '全部',
      doing: '进行中',
      overdue: '逾期',
      done: '已完成',
    };

    for (const [sk, btn] of statusPillButtons.entries()) {
      btn.textContent = `${labels[sk]} ${statusCounts[sk]}`;
      btn.classList.toggle('is-active', settings.ganttStatusFilter === sk);
    }

    if (searchInput && searchInput.value !== state.ganttSearch) {
      searchInput.value = state.ganttSearch;
    }
  }

  function renderGanttGrid() {
    if (!cardBuilt || !ganttMount) return;
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    if (timelineRightEl && typeof timelineRightEl.scrollLeft === 'number' && state.ganttScrollLeft !== null) {
      state.ganttScrollLeft = timelineRightEl.scrollLeft;
    }
    cleanupInteractions();

    const nonCancelled = (state.projects || []).filter((p) => p.status !== 'cancel');
    const isOverdueProj = (p) => p.status !== 'done' && Boolean(p.projEnd) && p.projEnd < today;
    const q = state.ganttSearch.trim().toLowerCase();
    const list = nonCancelled.filter((p) => {
      if (settings.ganttStatusFilter === 'doing' && p.status !== 'doing') return false;
      if (settings.ganttStatusFilter === 'done' && p.status !== 'done') return false;
      if (settings.ganttStatusFilter === 'overdue' && !isOverdueProj(p)) return false;
      if (q) {
        const hay = `${p.name} ${p.area} ${p.tasks.map((t) => t.title).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    preserveScroll(getScrollEl(), () => {
      ganttMount.replaceChildren();
      if (list.length === 0) {
        timelineRightEl = null;
        ganttMount.appendChild(el('div', 'ch-empty', '没有符合条件的 04_Project 项目'));
        return;
      }

      const taskByTaskId = new Map();
      for (const p of state.projects || []) {
        for (const pt of p.ganttTasks || []) {
          if (pt.taskId && !taskByTaskId.has(pt.taskId)) {
            taskByTaskId.set(pt.taskId, pt);
          }
        }
      }

      let minDate = addDaysYMD(today, -14);
      let maxDate = addDaysYMD(today, 30);
      for (const p of list) {
        if (p.projStart && p.projStart < minDate) minDate = p.projStart;
        if (p.projEnd && p.projEnd > maxDate) maxDate = p.projEnd;
        for (const t of p.ganttTasks) {
          if (t.barStart && t.barStart < minDate) minDate = t.barStart;
          if (t.barEnd && t.barEnd > maxDate) maxDate = t.barEnd;
        }
      }
      minDate = addDaysYMD(minDate, -7);
      maxDate = addDaysYMD(maxDate, 14);
      const totalDays = Math.max(30, diffDaysYMD(minDate, maxDate) + 1);
      const pxPerDay = settings.ganttZoom === 'day' ? 28 : settings.ganttZoom === 'week' ? 12 : 4.2;
      const canvasWidth = Math.max(640, Math.round(totalDays * pxPerDay));
      todayOffsetPx = Math.round(diffDaysYMD(minDate, today) * pxPerDay);

      const split = el('div', 'ch-gantt-split');
      const leftPane = el('div', 'ch-gantt-left');
      leftPane.appendChild(el('div', 'ch-gantt-left-head', `项目 (${list.length}) / 添加任务`));

      const rightPane = el('div', 'ch-gantt-right');
      timelineRightEl = rightPane;
      rightPane.addEventListener('scroll', () => {
        state.ganttScrollLeft = rightPane.scrollLeft;
      });

      const canvas = el('div', 'ch-gantt-canvas');
      canvas.style.width = `${canvasWidth}px`;

      const timeHead = el('div', 'ch-gantt-time-head');
      let cursor = minDate;
      while (cursor <= maxDate) {
        const dt = parseYMD(cursor);
        const leftPx = Math.round(diffDaysYMD(minDate, cursor) * pxPerDay);
        let label = '';
        let stepDays = 1;
        if (settings.ganttZoom === 'day') {
          label = `${dt.getMonth() + 1}/${dt.getDate()}`;
          stepDays = 1;
        } else if (settings.ganttZoom === 'week') {
          label = `${dt.getMonth() + 1}/${dt.getDate()}`;
          stepDays = 7;
        } else {
          label = `${dt.getFullYear()}.${pad2(dt.getMonth() + 1)}`;
          const nextMonth = new Date(dt.getFullYear(), dt.getMonth() + 1, 1);
          stepDays = Math.max(1, diffDaysYMD(cursor, formatDateYMD(nextMonth)));
        }
        const tick = el('div', 'ch-gantt-tick', label);
        tick.style.left = `${leftPx}px`;
        timeHead.appendChild(tick);

        const gLine = el('div', 'ch-gantt-grid-line');
        gLine.style.left = `${leftPx}px`;
        canvas.appendChild(gLine);

        cursor = addDaysYMD(cursor, stepDays);
      }
      canvas.appendChild(timeHead);

      const todayLine = el('div', 'ch-gantt-today-line');
      todayLine.style.left = `${todayOffsetPx}px`;
      todayLine.appendChild(el('div', 'ch-gantt-today-badge', '今'));
      canvas.appendChild(todayLine);

      ganttRenderSeq++;
      const markerPrefix = `ch-dep-carrot-home-${ganttRenderSeq}`;
      const svgNS = 'http://www.w3.org/2000/svg';
      const visibleTaskGeom = new Map();
      let suppressBarClickUntil = 0;
      let yCursor = 42;

      function closeDepPopover() {
        if (activeGanttPopover) {
          try { activeGanttPopover.remove(); } catch (_e) {}
          activeGanttPopover = null;
        }
      }

      canvas.addEventListener('click', () => closeDepPopover());

      const depSvg = document.createElementNS(svgNS, 'svg');
      depSvg.setAttribute('class', 'ch-gantt-dep-svg');

      const defsEl = document.createElementNS(svgNS, 'defs');
      const markerSpecs = [
        ['arrow', 'var(--ch-info)'],
        ['arrow-done', 'var(--ch-text-faint)'],
        ['arrow-hover', 'var(--ch-accent-strong)'],
        ['arrow-preview', 'var(--ch-accent-strong)'],
      ];
      for (const [mKey, fillColor] of markerSpecs) {
        const marker = document.createElementNS(svgNS, 'marker');
        marker.setAttribute('id', `${markerPrefix}-${mKey}`);
        marker.setAttribute('markerWidth', '7');
        marker.setAttribute('markerHeight', '7');
        marker.setAttribute('refX', '6');
        marker.setAttribute('refY', '3.5');
        marker.setAttribute('orient', 'auto');
        const mPath = document.createElementNS(svgNS, 'path');
        mPath.setAttribute('d', 'M 0 0.8 L 6 3.5 L 0 6.2 z');
        mPath.setAttribute('fill', fillColor);
        marker.appendChild(mPath);
        defsEl.appendChild(marker);
      }
      depSvg.appendChild(defsEl);

      const edgesGroup = document.createElementNS(svgNS, 'g');
      depSvg.appendChild(edgesGroup);

      const previewPath = document.createElementNS(svgNS, 'path');
      previewPath.setAttribute('class', 'ch-gantt-dep-preview');
      previewPath.setAttribute('marker-end', `url(#${markerPrefix}-arrow-preview)`);
      previewPath.style.display = 'none';
      depSvg.appendChild(previewPath);

      function startDependencyDrag(sourceTask, sourceSide, handleEl, startEvent) {
        if (!startEvent || (typeof startEvent.button === 'number' && startEvent.button !== 0)) return;
        startEvent.preventDefault?.();
        startEvent.stopPropagation?.();
        closeDepPopover();

        const srcGeom = visibleTaskGeom.get(sourceTask.id);
        if (!srcGeom) return;
        if (activeGanttDragCleanup) {
          try { activeGanttDragCleanup(); } catch (_e) {}
          activeGanttDragCleanup = null;
        }

        const sx = sourceSide === 'end' ? srcGeom.x2 : srcGeom.x1;
        const sy = srcGeom.y;
        canvas.classList.add('is-linking');
        handleEl.classList.add('is-active');
        previewPath.style.display = 'block';
        previewPath.setAttribute('d', buildOrthogonalDepPath(sx, sy, sx, sy));

        let currentTargetEl = null;
        let currentTargetId = '';

        const clearTargetHighlight = () => {
          if (currentTargetEl) {
            currentTargetEl.classList.remove('is-drop-target');
            currentTargetEl = null;
          }
          currentTargetId = '';
        };

        const updateHoverTarget = (clientX, clientY, fallbackTarget) => {
          const rawHit =
            (typeof document.elementFromPoint === 'function' ? document.elementFromPoint(clientX, clientY) : null) ||
            fallbackTarget;
          const hitBar =
            rawHit && typeof rawHit.closest === 'function' ? rawHit.closest('[data-gantt-task-id]') : null;
          const hitId = hitBar && typeof hitBar.getAttribute === 'function' ? hitBar.getAttribute('data-gantt-task-id') : '';
          if (!hitBar || !hitId || hitId === sourceTask.id) {
            clearTargetHighlight();
            return;
          }
          if (currentTargetEl !== hitBar) {
            clearTargetHighlight();
            currentTargetEl = hitBar;
            currentTargetId = hitId;
            currentTargetEl.classList.add('is-drop-target');
          }
        };

        const hasWin = typeof window !== 'undefined' && typeof window.addEventListener === 'function';

        const cleanup = () => {
          canvas.classList.remove('is-linking');
          handleEl.classList.remove('is-active');
          previewPath.style.display = 'none';
          clearTargetHighlight();
          if (hasWin && typeof window.removeEventListener === 'function') {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('keydown', onKeyDown);
          }
          activeGanttDragCleanup = null;
        };

        const onMouseMove = (ev) => {
          const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
          const curX = ev.clientX - rect.left;
          const curY = ev.clientY - rect.top;
          const pathStr =
            sourceSide === 'end'
              ? buildOrthogonalDepPath(sx, sy, curX, curY)
              : buildOrthogonalDepPath(curX, curY, sx, sy);
          previewPath.setAttribute('d', pathStr);
          updateHoverTarget(ev.clientX, ev.clientY, ev.target);
        };

        const onKeyDown = (ev) => {
          if (ev.key === 'Escape') cleanup();
        };

        const onMouseUp = (ev) => {
          updateHoverTarget(ev.clientX, ev.clientY, ev.target);
          const resolvedTargetId = currentTargetId;
          cleanup();
          suppressBarClickUntil = Date.now() + 200;
          if (!resolvedTargetId || resolvedTargetId === sourceTask.id) return;
          const targetGeom = visibleTaskGeom.get(resolvedTargetId);
          if (!targetGeom) return;
          const pred = sourceSide === 'end' ? sourceTask : targetGeom.task;
          const succ = sourceSide === 'end' ? targetGeom.task : sourceTask;
          state.ganttScrollLeft = rightPane.scrollLeft;
          void store.actions?.handleAddGanttDependency(pred, succ);
        };

        activeGanttDragCleanup = cleanup;
        if (hasWin) {
          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
          window.addEventListener('keydown', onKeyDown);
        }
      }

      function attachHandles(targetEl, gt) {
        const startH = el('span', 'ch-gantt-handle is-start');
        startH.title = '从此处拖向前置任务结束点（或接收前置连线）';
        startH.addEventListener('click', (e) => e.stopPropagation());
        startH.addEventListener('mousedown', (e) => startDependencyDrag(gt, 'start', startH, e));

        const endH = el('span', 'ch-gantt-handle is-end');
        endH.title = '拖向后置任务以建立依赖 (After this)';
        endH.addEventListener('click', (e) => e.stopPropagation());
        endH.addEventListener('mousedown', (e) => startDependencyDrag(gt, 'end', endH, e));

        targetEl.appendChild(startH);
        targetEl.appendChild(endH);
      }

      for (const proj of list) {
        const expanded = state.ganttExpanded.has(proj.filePath);
        const leftRow = el('div', 'ch-gantt-row-left');

        const expBtn = el('button', 'ch-tiny-icon-btn', expanded ? '▾' : '▸');
        expBtn.title = expanded ? '收起子任务' : '展开子任务';
        expBtn.addEventListener('click', () => {
          if (expanded) state.ganttExpanded.delete(proj.filePath);
          else state.ganttExpanded.add(proj.filePath);
          renderGanttGrid();
        });
        leftRow.appendChild(expBtn);

        const meta = el('div', 'ch-gantt-proj-meta');
        const pName = el('div', 'ch-gantt-proj-name', proj.name);
        pName.title = proj.filePath;
        pName.addEventListener('click', () => openFileAtLine(app, proj.filePath));
        meta.appendChild(pName);

        const subText = proj.unscheduled
          ? '未排期'
          : `${proj.doneCount}/${proj.totalCount} · ${proj.progressPct}%`;
        const sub = el('div', 'ch-gantt-proj-sub', subText);
        meta.appendChild(sub);
        leftRow.appendChild(meta);

        const addTaskBtn = el('button', 'ch-mini-pill-btn', '+ 任务');
        addTaskBtn.addEventListener('click', () =>
          modals.openNewTaskModal({ projectPath: proj.filePath, scheduled: today })
        );
        leftRow.appendChild(addTaskBtn);
        leftPane.appendChild(leftRow);

        const lane = el('div', 'ch-gantt-lane');
        if (!proj.unscheduled && proj.projStart) {
          const endD = proj.projEnd || today;
          const safeEnd = endD < proj.projStart ? proj.projStart : endD;
          const x1 = Math.round(diffDaysYMD(minDate, proj.projStart) * pxPerDay);
          const w = Math.max(18, Math.round((diffDaysYMD(proj.projStart, safeEnd) + 1) * pxPerDay));
          const barCls = proj.status === 'done' ? 'status-done' : isOverdueProj(proj) ? 'status-overdue' : 'status-doing';
          const bar = el('div', `ch-gantt-bar ${barCls}`);
          bar.style.left = `${x1}px`;
          bar.style.width = `${w}px`;
          const fill = el('div', 'ch-gantt-bar-fill');
          fill.style.width = `${proj.progressPct}%`;
          bar.appendChild(fill);
          bar.appendChild(el('span', 'ch-gantt-bar-label', `${proj.name} (${proj.progressPct}%)`));
          bar.title = `${proj.name}: ${proj.projStart} → ${safeEnd}`;
          bar.addEventListener('click', () => openFileAtLine(app, proj.filePath));
          lane.appendChild(bar);
        }
        canvas.appendChild(lane);
        yCursor += 44;

        if (expanded) {
          if (proj.ganttTasks.length === 0) {
            const emptyL = el('div', 'ch-gantt-row-left is-task');
            emptyL.appendChild(el('span', 'ch-count-muted', '暂无任务，点右上「+ 任务」添加'));
            leftPane.appendChild(emptyL);
            canvas.appendChild(el('div', 'ch-gantt-lane is-task'));
            yCursor += 34;
          } else {
            for (const gt of proj.ganttTasks) {
              const blockers = (gt.dependsOn || [])
                .map((id) => taskByTaskId.get(id))
                .filter((pt) => pt && pt.status !== 'done');
              const blockerHint = blockers.length > 0 ? `前置未完成：${blockers.map((b) => b.title).join('、')}` : '';

              const tLeft = el('div', 'ch-gantt-row-left is-task');
              const tName = el('span', 'ch-list-row-text', `${gt.status === 'done' ? '✓ ' : gt.status === 'doing' ? '▶ ' : ''}${gt.title}`);
              tName.title = blockerHint ? `${gt.title}\n${blockerHint}` : gt.title;
              tName.style.cursor = 'pointer';
              tName.style.flex = '1';
              tName.style.minWidth = '0';
              tName.addEventListener('click', () => openFileAtLine(app, gt.filePath, gt.lineNumber));
              tLeft.appendChild(tName);
              if (blockers.length > 0) {
                const depBadge = el('span', 'ch-gantt-dep-badge', '🔒');
                depBadge.title = blockerHint;
                tLeft.appendChild(depBadge);
              }
              leftPane.appendChild(tLeft);

              const rowTop = yCursor;
              yCursor += 34;
              const tLane = el('div', 'ch-gantt-lane is-task');
              if (gt.barStart && gt.barEnd) {
                const tx1 = Math.round(diffDaysYMD(minDate, gt.barStart) * pxPerDay);
                if (gt.milestone) {
                  const ms = el('div', 'ch-gantt-milestone');
                  ms.style.left = `${tx1}px`;
                  ms.setAttribute('data-gantt-task-id', gt.id);
                  ms.title = `${gt.title} (${gt.barStart})${blockerHint ? `\n${blockerHint}` : ''}`;
                  ms.addEventListener('click', () => {
                    if (Date.now() < suppressBarClickUntil) return;
                    openFileAtLine(app, gt.filePath, gt.lineNumber);
                  });
                  attachHandles(ms, gt);
                  tLane.appendChild(ms);
                  visibleTaskGeom.set(gt.id, { task: gt, x1: tx1 - 9, x2: tx1 + 9, y: rowTop + 16.5, barEl: ms });
                } else {
                  const tw = Math.max(14, Math.round((diffDaysYMD(gt.barStart, gt.barEnd) + 1) * pxPerDay));
                  const tOver = gt.status !== 'done' && gt.barEnd < today;
                  const tCls = gt.status === 'done' ? 'status-done' : tOver ? 'status-overdue' : gt.status === 'doing' ? 'status-doing' : 'status-todo';
                  const tBar = el('div', `ch-gantt-bar ${tCls}${blockers.length > 0 ? ' is-blocked' : ''}`);
                  tBar.style.left = `${tx1}px`;
                  tBar.style.width = `${tw}px`;
                  tBar.setAttribute('data-gantt-task-id', gt.id);
                  tBar.appendChild(el('span', 'ch-gantt-bar-label', gt.title));
                  tBar.title = `${gt.title}: ${gt.barStart} → ${gt.barEnd}${blockerHint ? `\n${blockerHint}` : ''}`;
                  tBar.addEventListener('click', () => {
                    if (Date.now() < suppressBarClickUntil) return;
                    openFileAtLine(app, gt.filePath, gt.lineNumber);
                  });
                  attachHandles(tBar, gt);
                  tLane.appendChild(tBar);
                  visibleTaskGeom.set(gt.id, { task: gt, x1: tx1, x2: tx1 + tw, y: rowTop + 16.5, barEl: tBar });
                }
              }
              canvas.appendChild(tLane);
            }
          }
        }
      }

      depSvg.setAttribute('width', String(canvasWidth));
      depSvg.setAttribute('height', String(yCursor));
      depSvg.setAttribute('viewBox', `0 0 ${canvasWidth} ${yCursor}`);

      function openDepPopover(predGeom, succGeom, clickEvent) {
        closeDepPopover();
        const pop = el('div', 'ch-gantt-dep-popover');
        pop.addEventListener('click', (ev) => ev.stopPropagation());

        let popX = (predGeom.x2 + succGeom.x1) / 2;
        let popY = (predGeom.y + succGeom.y) / 2 - 16;
        if (clickEvent && typeof clickEvent.clientX === 'number' && typeof canvas.getBoundingClientRect === 'function') {
          const rect = canvas.getBoundingClientRect();
          popX = clickEvent.clientX - rect.left + 8;
          popY = clickEvent.clientY - rect.top - 16;
        }
        pop.style.left = `${Math.max(8, Math.min(Math.max(8, canvasWidth - 260), Math.round(popX)))}px`;
        pop.style.top = `${Math.max(44, Math.min(Math.max(44, yCursor - 36), Math.round(popY)))}px`;

        const lbl = el('span', 'ch-gantt-dep-popover-label', `${predGeom.task.title} → ${succGeom.task.title}`);
        lbl.title = `${predGeom.task.title} → ${succGeom.task.title}`;
        pop.appendChild(lbl);

        const unlinkBtn = el('button', 'ch-gantt-dep-unlink-btn', '断开依赖');
        unlinkBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeDepPopover();
          state.ganttScrollLeft = rightPane.scrollLeft;
          void store.actions?.handleRemoveGanttDependency(predGeom.task, succGeom.task);
        });
        pop.appendChild(unlinkBtn);

        const closeBtn = el('button', 'ch-gantt-dep-close-btn', '×');
        closeBtn.title = '关闭';
        closeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeDepPopover();
        });
        pop.appendChild(closeBtn);

        canvas.appendChild(pop);
        activeGanttPopover = pop;
      }

      for (const succGeom of visibleTaskGeom.values()) {
        for (const predId of succGeom.task.dependsOn || []) {
          const predTask = taskByTaskId.get(predId);
          const predGeom = predTask ? visibleTaskGeom.get(predTask.id) : null;
          if (!predGeom || predGeom.task.id === succGeom.task.id) continue;

          const isDone = predGeom.task.status === 'done';
          const d = buildOrthogonalDepPath(predGeom.x2, predGeom.y, succGeom.x1 - 2, succGeom.y);
          const edgeG = document.createElementNS(svgNS, 'g');
          edgeG.setAttribute('class', 'ch-gantt-dep-edge');

          const line = document.createElementNS(svgNS, 'path');
          line.setAttribute('class', `ch-gantt-dep-line${isDone ? ' is-done' : ''}`);
          line.setAttribute('d', d);
          const baseMarker = `url(#${markerPrefix}-${isDone ? 'arrow-done' : 'arrow'})`;
          const hoverMarker = `url(#${markerPrefix}-arrow-hover)`;
          line.setAttribute('marker-end', baseMarker);

          const hit = document.createElementNS(svgNS, 'path');
          hit.setAttribute('class', 'ch-gantt-dep-hit');
          hit.setAttribute('d', d);
          const titleNode = document.createElementNS(svgNS, 'title');
          titleNode.textContent = `${predGeom.task.title} → ${succGeom.task.title}（点击管理依赖）`;
          hit.appendChild(titleNode);

          edgeG.addEventListener('mouseenter', () => line.setAttribute('marker-end', hoverMarker));
          edgeG.addEventListener('mouseleave', () => line.setAttribute('marker-end', baseMarker));
          hit.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openDepPopover(predGeom, succGeom, ev);
          });

          edgeG.appendChild(line);
          edgeG.appendChild(hit);
          edgesGroup.appendChild(edgeG);
        }
      }

      canvas.appendChild(depSvg);
      rightPane.appendChild(canvas);
      split.appendChild(leftPane);
      split.appendChild(rightPane);
      ganttMount.appendChild(split);

      const applyScrollLeft = () => {
        if (timelineRightEl) {
          const targetScroll =
            typeof state.ganttScrollLeft === 'number'
              ? state.ganttScrollLeft
              : Math.max(0, todayOffsetPx - (timelineRightEl.clientWidth || 640) * 0.45);
          timelineRightEl.scrollLeft = targetScroll;
          state.ganttScrollLeft = targetScroll;
        }
      };
      applyScrollLeft();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(applyScrollLeft);
      }
    });
  }

  function buildCardShell() {
    const settings = getSettings();
    const state = store.state;
    ganttSlot.replaceChildren();
    zoomButtons = new Map();
    statusPillButtons = new Map();

    const card = el('div', 'ch-card');
    const head = el('div', 'ch-card-head');
    const titleWrap = el('div', 'ch-card-title-wrap');
    titleWrap.appendChild(el('span', 'ch-card-accent-bar'));
    titleWrap.appendChild(el('h3', 'ch-card-title', '项目甘特图'));
    head.appendChild(titleWrap);

    const controls = el('div', 'ch-util-right');
    controls.style.flexWrap = 'wrap';

    const zoomOrder = ['day', 'week', 'month'];
    const zMinus = el('button', 'ch-mini-pill-btn', '−');
    zMinus.title = '缩小时间跨度';
    zMinus.addEventListener('click', () => {
      const idx = zoomOrder.indexOf(getSettings().ganttZoom);
      const next = zoomOrder[Math.min(zoomOrder.length - 1, idx + 1)];
      updateSettings({ ganttZoom: next }, { skipModuleRefresh: true });
      syncToolbarControls();
      renderGanttGrid();
    });
    const zPlus = el('button', 'ch-mini-pill-btn', '+');
    zPlus.title = '放大时间粒度';
    zPlus.addEventListener('click', () => {
      const idx = zoomOrder.indexOf(getSettings().ganttZoom);
      const next = zoomOrder[Math.max(0, idx - 1)];
      updateSettings({ ganttZoom: next }, { skipModuleRefresh: true });
      syncToolbarControls();
      renderGanttGrid();
    });
    controls.appendChild(zMinus);
    controls.appendChild(zPlus);

    const zoomSeg = el('div', 'ch-seg-tabs');
    for (const [zk, zl] of [['day', '日'], ['week', '周'], ['month', '月']]) {
      const b = el('button', `ch-seg-tab ${settings.ganttZoom === zk ? 'is-active' : ''}`, zl);
      b.addEventListener('click', () => {
        updateSettings({ ganttZoom: zk }, { skipModuleRefresh: true });
        syncToolbarControls();
        renderGanttGrid();
      });
      zoomButtons.set(zk, b);
      zoomSeg.appendChild(b);
    }
    controls.appendChild(zoomSeg);

    const todayScrollBtn = el('button', 'ch-mini-pill-btn', '今天');
    todayScrollBtn.addEventListener('click', () => {
      if (timelineRightEl) {
        const targetX = Math.max(0, todayOffsetPx - (timelineRightEl.clientWidth || 640) * 0.45);
        state.ganttScrollLeft = targetX;
        if (typeof timelineRightEl.scrollTo === 'function') {
          timelineRightEl.scrollTo({ left: targetX, behavior: 'smooth' });
        } else {
          timelineRightEl.scrollLeft = targetX;
        }
      }
    });
    controls.appendChild(todayScrollBtn);

    const newProjBtn = el('button', 'ch-mini-pill-btn is-active', '+ 新项目');
    newProjBtn.addEventListener('click', () => runQuickAddChoice(app, obsidian, '项目'));
    controls.appendChild(newProjBtn);
    head.appendChild(controls);
    card.appendChild(head);

    const filterBar = el('div', 'ch-toolbar-row');
    searchInput = el('input', 'ch-input');
    searchInput.placeholder = '搜索项目或关联任务…';
    searchInput.value = state.ganttSearch;
    searchInput.style.minWidth = '180px';
    searchInput.addEventListener('input', () => {
      state.ganttSearch = searchInput.value;
      renderGanttGrid();
    });
    filterBar.appendChild(searchInput);

    statusPillsWrap = el('div', 'ch-pills-row');
    for (const [sk, sl] of [['all', '全部'], ['doing', '进行中'], ['overdue', '逾期'], ['done', '已完成']]) {
      const p = el('button', `ch-pill ${settings.ganttStatusFilter === sk ? 'is-active' : ''}`, `${sl} 0`);
      p.addEventListener('click', () => {
        updateSettings({ ganttStatusFilter: sk }, { skipModuleRefresh: true });
        syncToolbarControls();
        renderGanttGrid();
      });
      statusPillButtons.set(sk, p);
      statusPillsWrap.appendChild(p);
    }
    filterBar.appendChild(statusPillsWrap);
    card.appendChild(filterBar);

    ganttMount = el('div', '');
    card.appendChild(ganttMount);
    ganttSlot.appendChild(card);
    cardBuilt = true;
  }

  function update() {
    const settings = getSettings();
    if (!settings.showGantt) {
      cleanupInteractions();
      ganttSlot.replaceChildren();
      ganttSlot.style.display = 'none';
      cardBuilt = false;
      ganttMount = null;
      timelineRightEl = null;
      return;
    }
    ganttSlot.style.display = '';
    if (!cardBuilt) {
      buildCardShell();
    }
    syncToolbarControls();
    renderGanttGrid();
  }

  return {
    update,
    renderGanttGrid,
    cleanup: cleanupInteractions,
  };
}

module.exports = {
  createGanttCardSection,
};
