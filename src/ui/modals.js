'use strict';

const { DEFAULT_SETTINGS } = require('../constants');
const { el } = require('../utils/dom');
const { openFileAtLine, ensureFolderExists } = require('../services/vault-adapter');
const { listVaultBookmarkTargets } = require('../services/bookmarks-adapter');

function createModalManager(ctx) {
  let activeModalCleanup = null;

  function cleanup() {
    if (activeModalCleanup) {
      try { activeModalCleanup(); } catch (_e) {}
      activeModalCleanup = null;
    }
  }

  function showModal(titleText, buildBody) {
    cleanup();
    const backdrop = el('div', 'ch-modal-backdrop');
    const modal = el('div', 'ch-modal');
    const titleRow = el('div', 'ch-modal-title');
    titleRow.appendChild(el('span', '', titleText));
    const closeBtn = el('button', 'ch-icon-btn', '✕');
    titleRow.appendChild(closeBtn);
    modal.appendChild(titleRow);

    const body = el('div', '');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '10px';
    modal.appendChild(body);
    backdrop.appendChild(modal);

    function close() {
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onKey);
      }
      backdrop.remove();
      if (activeModalCleanup === close) activeModalCleanup = null;
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
    }
    activeModalCleanup = close;

    buildBody(body, close);
  }

  function openFlashCaptureModal() {
    showModal('贴一张到今日日注', (body, close) => {
      let entryKind = 'idea';

      const kindRow = el('div', 'ch-seg-tabs');
      kindRow.style.alignSelf = 'flex-start';
      const ideaTab = el('button', 'ch-seg-tab is-active', '闪念 [I]');
      const impTab = el('button', 'ch-seg-tab', '要事 [i] #要事');
      kindRow.appendChild(ideaTab);
      kindRow.appendChild(impTab);
      body.appendChild(kindRow);

      const hint = el('div', 'ch-form-label', '按日注单行格式写入当前时段：- [I] **HH:mm** 内容（换行自动转为 <br>）');
      hint.style.fontWeight = '400';
      const ta = document.createElement('textarea');
      ta.className = 'ch-textarea';
      ta.placeholder = '记下此刻的想法…（Cmd/Ctrl + Enter 保存）';
      body.appendChild(hint);
      body.appendChild(ta);

      const syncKindUI = () => {
        ideaTab.classList.toggle('is-active', entryKind === 'idea');
        impTab.classList.toggle('is-active', entryKind === 'important');
        if (entryKind === 'important') {
          hint.textContent = '按要事格式写入当前时段：- [i] **HH:mm** #要事 内容（完成后点卡片右上角 ✓ 即可下架）';
          ta.placeholder = '记下需要重点关注的要事…（Cmd/Ctrl + Enter 保存）';
        } else {
          hint.textContent = '按日注单行格式写入当前时段：- [I] **HH:mm** 内容（换行自动转为 <br>）';
          ta.placeholder = '记下此刻的想法…（Cmd/Ctrl + Enter 保存）';
        }
      };
      ideaTab.addEventListener('click', () => { entryKind = 'idea'; syncKindUI(); ta.focus(); });
      impTab.addEventListener('click', () => { entryKind = 'important'; syncKindUI(); ta.focus(); });

      const footer = el('div', 'ch-modal-footer');
      const cancelBtn = el('button', 'ch-btn', '取消');
      const saveBtn = el('button', 'ch-btn is-primary', '写入今日日注');
      cancelBtn.addEventListener('click', close);
      const submit = async () => {
        if (!ta.value.trim()) return;
        saveBtn.disabled = true;
        await ctx.actions.saveFlashIdea(ta.value, entryKind);
        close();
      };
      saveBtn.addEventListener('click', submit);
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);
      body.appendChild(footer);
      setTimeout(() => ta.focus(), 20);
    });
  }

  function openNewTaskModal(preset) {
    const p = preset || {};
    const activeProjects = (ctx.store.state.projects || []).filter((pr) => pr.status === 'doing');
    showModal('新建任务', (body, close) => {
      const fTitle = el('div', 'ch-form-field');
      fTitle.appendChild(el('span', 'ch-form-label', '任务内容'));
      const titleInput = el('input', 'ch-input');
      titleInput.placeholder = '输入要做的任务…';
      titleInput.style.height = '34px';
      fTitle.appendChild(titleInput);
      body.appendChild(fTitle);

      const row1 = el('div', 'ch-form-row-2');
      const fProj = el('div', 'ch-form-field');
      fProj.appendChild(el('span', 'ch-form-label', '写入位置 / 项目'));
      const projSel = document.createElement('select');
      projSel.className = 'ch-select';
      projSel.style.height = '32px';
      const optDaily = document.createElement('option');
      optDaily.value = '';
      optDaily.textContent = '今日日注（当前时段）';
      projSel.appendChild(optDaily);
      for (const pr of activeProjects) {
        const opt = document.createElement('option');
        opt.value = pr.filePath;
        opt.textContent = `项目：${pr.name}`;
        projSel.appendChild(opt);
      }
      if (p.projectPath) projSel.value = p.projectPath;
      fProj.appendChild(projSel);

      const fStatus = el('div', 'ch-form-field');
      fStatus.appendChild(el('span', 'ch-form-label', '初始状态'));
      const statusSel = document.createElement('select');
      statusSel.className = 'ch-select';
      statusSel.style.height = '32px';
      statusSel.innerHTML = '<option value="todo">待办 [ ]</option><option value="doing">进行中 [/]</option>';
      if (p.status === 'doing') statusSel.value = 'doing';
      fStatus.appendChild(statusSel);
      row1.appendChild(fProj);
      row1.appendChild(fStatus);
      body.appendChild(row1);

      const row2 = el('div', 'ch-form-row-2');
      const fSched = el('div', 'ch-form-field');
      fSched.appendChild(el('span', 'ch-form-label', '计划日期 ⏳'));
      const schedInput = el('input', 'ch-input');
      schedInput.type = 'date';
      schedInput.style.height = '32px';
      schedInput.value = p.scheduled || '';
      fSched.appendChild(schedInput);

      const fDue = el('div', 'ch-form-field');
      fDue.appendChild(el('span', 'ch-form-label', '截止日期 📅'));
      const dueInput = el('input', 'ch-input');
      dueInput.type = 'date';
      dueInput.style.height = '32px';
      dueInput.value = p.due || '';
      fDue.appendChild(dueInput);
      row2.appendChild(fSched);
      row2.appendChild(fDue);
      body.appendChild(row2);

      const fPrio = el('div', 'ch-form-field');
      fPrio.appendChild(el('span', 'ch-form-label', '优先级'));
      const prioSel = document.createElement('select');
      prioSel.className = 'ch-select';
      prioSel.style.height = '32px';
      prioSel.innerHTML = '<option value="normal">普通</option><option value="high">高 ⏫</option><option value="medium">中 🔼</option><option value="low">低 🔽</option>';
      fPrio.appendChild(prioSel);
      body.appendChild(fPrio);

      const footer = el('div', 'ch-modal-footer');
      const cancelBtn = el('button', 'ch-btn', '取消');
      const saveBtn = el('button', 'ch-btn is-primary', '创建任务');
      cancelBtn.addEventListener('click', close);
      const submit = async () => {
        if (!titleInput.value.trim()) return;
        saveBtn.disabled = true;
        const hitProj = activeProjects.find((x) => x.filePath === projSel.value);
        await ctx.actions.createNewTask({
          title: titleInput.value,
          projectPath: projSel.value,
          projectName: hitProj ? hitProj.name : '',
          status: statusSel.value,
          scheduled: schedInput.value,
          due: dueInput.value,
          priority: prioSel.value,
        });
        close();
      };
      saveBtn.addEventListener('click', submit);
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);
      body.appendChild(footer);
      setTimeout(() => titleInput.focus(), 20);
    });
  }

  function openNewExecutionTaskModal(preset) {
    const p = preset || {};
    showModal('新建今日执行任务', (body, close) => {
      const hint = el('div', 'ch-form-label', '写入今日日注 ## 今日执行 下（Agent Deck 语法，自动按需建块）');
      hint.style.fontWeight = '400';
      body.appendChild(hint);

      const fTitle = el('div', 'ch-form-field');
      fTitle.appendChild(el('span', 'ch-form-label', '任务内容'));
      const titleInput = el('input', 'ch-input');
      titleInput.placeholder = '输入要做的任务…';
      titleInput.style.height = '34px';
      fTitle.appendChild(titleInput);
      body.appendChild(fTitle);

      const row1 = el('div', 'ch-form-row-2');
      const fKw = el('div', 'ch-form-field');
      fKw.appendChild(el('span', 'ch-form-label', '初始状态'));
      const kwSel = document.createElement('select');
      kwSel.className = 'ch-select';
      kwSel.style.height = '32px';
      kwSel.innerHTML = '<option value="TODO">TODO (还要做)</option><option value="DOING">DOING (正在做)</option><option value="PAUSED">PAUSED (已暂停)</option><option value="TODOFORAI">TODOFORAI (待派发 AI)</option>';
      if (p.keyword) kwSel.value = p.keyword;
      fKw.appendChild(kwSel);

      const fPrio = el('div', 'ch-form-field');
      fPrio.appendChild(el('span', 'ch-form-label', '优先级'));
      const prioSel = document.createElement('select');
      prioSel.className = 'ch-select';
      prioSel.style.height = '32px';
      prioSel.innerHTML = '<option value="">无</option><option value="A">[#A] 高</option><option value="B">[#B] 中</option><option value="C">[#C] 低</option>';
      fPrio.appendChild(prioSel);
      row1.appendChild(fKw);
      row1.appendChild(fPrio);
      body.appendChild(row1);

      const fDur = el('div', 'ch-form-field');
      fDur.appendChild(el('span', 'ch-form-label', '预计时长（可选）'));
      const durInput = el('input', 'ch-input');
      durInput.placeholder = '例如 30m、45m、1.5h';
      durInput.style.height = '32px';
      const durPills = el('div', 'ch-pills-row');
      for (const presetDur of ['15m', '30m', '45m', '1h', '清除']) {
        const b = el('button', 'ch-mini-pill-btn', presetDur);
        b.addEventListener('click', () => {
          durInput.value = presetDur === '清除' ? '' : presetDur;
        });
        durPills.appendChild(b);
      }
      fDur.appendChild(durInput);
      fDur.appendChild(durPills);
      body.appendChild(fDur);

      const footer = el('div', 'ch-modal-footer');
      const cancelBtn = el('button', 'ch-btn', '取消');
      const saveBtn = el('button', 'ch-btn is-primary', '写入今日执行');
      cancelBtn.addEventListener('click', close);
      const submit = async () => {
        if (!titleInput.value.trim()) return;
        saveBtn.disabled = true;
        await ctx.actions.createNewExecutionTask({
          title: titleInput.value,
          keyword: kwSel.value,
          priority: prioSel.value,
          duration: durInput.value,
        });
        close();
      };
      saveBtn.addEventListener('click', submit);
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);
      body.appendChild(footer);
      setTimeout(() => titleInput.focus(), 20);
    });
  }

  function openNewNoteModal() {
    const app = ctx.app;
    showModal('新建笔记', (body, close) => {
      const fTitle = el('div', 'ch-form-field');
      fTitle.appendChild(el('span', 'ch-form-label', '笔记名称'));
      const nameInput = el('input', 'ch-input');
      nameInput.placeholder = '输入笔记文件名（不含 .md）';
      nameInput.style.height = '34px';
      fTitle.appendChild(nameInput);
      body.appendChild(fTitle);

      const fDir = el('div', 'ch-form-field');
      fDir.appendChild(el('span', 'ch-form-label', '存放目录（留空则放库根目录）'));
      const dirSel = document.createElement('select');
      dirSel.className = 'ch-select';
      dirSel.style.height = '32px';
      for (const d of ['', '07_Resource', '05_Study', '03_Area']) {
        const o = document.createElement('option');
        o.value = d;
        o.textContent = d || '库根目录';
        dirSel.appendChild(o);
      }
      fDir.appendChild(dirSel);
      body.appendChild(fDir);

      const footer = el('div', 'ch-modal-footer');
      const cancelBtn = el('button', 'ch-btn', '取消');
      const okBtn = el('button', 'ch-btn is-primary', '创建并打开');
      cancelBtn.addEventListener('click', close);
      const submit = async () => {
        const title = nameInput.value.trim().replace(/[\\/:*?"<>|]/g, '-');
        if (!title) return;
        const target = dirSel.value ? `${dirSel.value}/${title}.md` : `${title}.md`;
        if (!app.vault.getAbstractFileByPath(target)) {
          await ensureFolderExists(app, target);
          await app.vault.create(target, `# ${title}\n`);
        }
        close();
        await openFileAtLine(app, target);
      };
      okBtn.addEventListener('click', submit);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);
      body.appendChild(footer);
      setTimeout(() => nameInput.focus(), 20);
    });
  }

  function openAddBookmarkModal() {
    const app = ctx.app;
    const targets = listVaultBookmarkTargets(app);
    const groups = ctx.store?.state?.bookmarkGroups || [];

    showModal('添加书签', (body, close) => {
      let filterType = 'all';

      const typeTabs = el('div', 'ch-seg-tabs');
      const tabBtns = [];
      for (const [kind, label] of [['all', '全部'], ['file', '文件'], ['folder', '文件夹']]) {
        const b = el('button', `ch-seg-tab${kind === 'all' ? ' is-active' : ''}`, label);
        b.addEventListener('click', () => {
          filterType = kind;
          for (const item of tabBtns) {
            item.btn.classList.toggle('is-active', item.kind === kind);
          }
          refill(filterInput.value);
        });
        tabBtns.push({ kind, btn: b });
        typeTabs.appendChild(b);
      }
      body.appendChild(typeTabs);

      const fTarget = el('div', 'ch-form-field');
      fTarget.appendChild(el('span', 'ch-form-label', '目标文件或文件夹（输入关键词筛选）'));
      const filterInput = el('input', 'ch-input');
      filterInput.placeholder = '输入路径或名称筛选…';
      const sel = document.createElement('select');
      sel.className = 'ch-select';
      sel.size = 6;
      sel.style.height = '150px';
      sel.style.padding = '4px';

      const fTitle = el('div', 'ch-form-field');
      fTitle.appendChild(el('span', 'ch-form-label', '自定义标题（可选）'));
      const titleInput = el('input', 'ch-input');
      titleInput.placeholder = '留空沿用 Obsidian 默认标题';

      const targetByValue = new Map();
      function syncTitlePlaceholder() {
        const hit = targetByValue.get(sel.value);
        titleInput.placeholder = hit ? `${hit.name}（留空沿用默认标题）` : '留空沿用 Obsidian 默认标题';
      }

      const errEl = el('div', 'ch-bm-modal-error', '');
      errEl.style.display = 'none';
      function clearErr() {
        errEl.textContent = '';
        errEl.style.display = 'none';
      }

      function refill(kw) {
        clearErr();
        sel.replaceChildren();
        targetByValue.clear();
        const q = String(kw || '').trim().toLowerCase();
        const hits = targets
          .filter((t) => (filterType === 'all' || t.type === filterType) && (!q || t.path.toLowerCase().includes(q)))
          .slice(0, 100);
        for (const t of hits) {
          const val = `${t.type}::${t.path}`;
          targetByValue.set(val, t);
          const o = document.createElement('option');
          o.value = val;
          o.textContent = t.type === 'folder' ? `[文件夹] ${t.path}` : t.path;
          sel.appendChild(o);
        }
        sel.value = hits[0] ? `${hits[0].type}::${hits[0].path}` : '';
        syncTitlePlaceholder();
      }

      filterInput.addEventListener('input', () => refill(filterInput.value));
      sel.addEventListener('change', () => {
        clearErr();
        syncTitlePlaceholder();
      });
      refill('');

      fTarget.appendChild(filterInput);
      fTarget.appendChild(sel);
      body.appendChild(fTarget);

      let groupSel = null;
      if (groups.length > 0) {
        const fGroup = el('div', 'ch-form-field');
        fGroup.appendChild(el('span', 'ch-form-label', '所属分组'));
        groupSel = document.createElement('select');
        groupSel.className = 'ch-select';
        groupSel.style.height = '32px';
        const rootOpt = document.createElement('option');
        rootOpt.value = '';
        rootOpt.textContent = '根目录';
        groupSel.appendChild(rootOpt);
        groups.forEach((g, idx) => {
          const opt = document.createElement('option');
          opt.value = String(idx);
          opt.textContent = g.label;
          groupSel.appendChild(opt);
        });
        groupSel.addEventListener('change', clearErr);
        fGroup.appendChild(groupSel);
        body.appendChild(fGroup);
      }

      fTitle.appendChild(titleInput);
      body.appendChild(fTitle);
      body.appendChild(errEl);

      const footer = el('div', 'ch-modal-footer');
      const cancelBtn = el('button', 'ch-btn', '取消');
      const addBtn = el('button', 'ch-btn is-primary', '添加到书签');
      cancelBtn.addEventListener('click', close);

      const submit = () => {
        if (!sel.value) {
          errEl.textContent = '请先选择要添加的文件或文件夹';
          errEl.style.display = '';
          return;
        }
        const sepIdx = sel.value.indexOf('::');
        const type = sepIdx >= 0 ? sel.value.slice(0, sepIdx) : 'file';
        const targetPath = sepIdx >= 0 ? sel.value.slice(sepIdx + 2) : sel.value;
        const parentGroupRaw =
          groupSel && groupSel.value !== '' ? (groups[Number(groupSel.value)]?.raw || null) : null;
        const res = ctx.actions.addBookmark({
          type,
          path: targetPath,
          title: titleInput.value,
          parentGroupRaw,
        });
        if (!res || !res.ok) {
          errEl.textContent = (res && res.message) || '添加书签失败';
          errEl.style.display = '';
          return;
        }
        close();
      };

      addBtn.addEventListener('click', submit);
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(addBtn);
      body.appendChild(footer);
      setTimeout(() => filterInput.focus(), 20);
    });
  }

  function openConfirmDeleteBookmarkGroupModal(groupNode) {
    if (!groupNode) return;
    showModal('删除书签分组', (body, close) => {
      let msg;
      if (groupNode.leafCount > 0 && groupNode.groupCount > 0) {
        msg = `确认删除分组「${groupNode.title}」及其下 ${groupNode.groupCount} 个子分组和 ${groupNode.leafCount} 条书签？`;
      } else if (groupNode.leafCount > 0) {
        msg = `确认删除分组「${groupNode.title}」及其下 ${groupNode.leafCount} 条书签？`;
      } else {
        msg = `确认删除分组「${groupNode.title}」及其下 ${groupNode.groupCount} 个子分组？`;
      }
      body.appendChild(el('div', '', msg));
      const hint = el('div', 'ch-form-label', '删除后将同步从 Obsidian 书签中移除，且不可撤销。');
      hint.style.fontWeight = '400';
      body.appendChild(hint);

      const footer = el('div', 'ch-modal-footer');
      const cancelBtn = el('button', 'ch-btn', '取消');
      const confirmBtn = el('button', 'ch-btn is-danger', '确认删除');
      cancelBtn.addEventListener('click', close);
      confirmBtn.addEventListener('click', () => {
        ctx.actions.removeBookmark(groupNode);
        close();
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      body.appendChild(footer);
    });
  }

  function openSettingsModal() {
    const app = ctx.app;
    const settings = ctx.getSettings();
    const imgFiles = (app.vault.getFiles ? app.vault.getFiles() : []).filter((f) =>
      /\.(png|jpe?g|webp|gif|svg)$/i.test(f.path)
    );
    showModal('Carrot Home 工作台设置', (body, close) => {
      function addToggle(label, key) {
        const row = el('div', 'ch-settings-row');
        row.appendChild(el('span', '', label));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(ctx.getSettings()[key]);
        cb.addEventListener('change', () => {
          ctx.updateSettings({ [key]: cb.checked });
        });
        row.appendChild(cb);
        body.appendChild(row);
      }

      const fTitle = el('div', 'ch-form-field');
      fTitle.appendChild(el('span', 'ch-form-label', '主页大标题'));
      const tInput = el('input', 'ch-input');
      tInput.value = settings.title;
      tInput.addEventListener('change', () => {
        ctx.updateSettings({ title: tInput.value.trim() || DEFAULT_SETTINGS.title });
      });
      fTitle.appendChild(tInput);
      body.appendChild(fTitle);

      const bgRow = el('div', 'ch-form-row-2');
      const fBgKind = el('div', 'ch-form-field');
      fBgKind.appendChild(el('span', 'ch-form-label', '背景模式'));
      const bgKindSel = document.createElement('select');
      bgKindSel.className = 'ch-select';
      bgKindSel.innerHTML = '<option value="default">柔和氛围渐变</option><option value="image">自定义图片</option><option value="color">纯色</option>';
      bgKindSel.value = settings.backgroundKind;
      bgKindSel.addEventListener('change', () => {
        ctx.updateSettings({ backgroundKind: bgKindSel.value });
      });
      fBgKind.appendChild(bgKindSel);

      const fBgVal = el('div', 'ch-form-field');
      fBgVal.appendChild(el('span', 'ch-form-label', '图片路径 / URL / 颜色'));
      const bgValInput = el('input', 'ch-input');
      bgValInput.value = settings.backgroundValue;
      bgValInput.placeholder = '01_附件/image/xxx.png 或 #hex';
      bgValInput.addEventListener('change', () => {
        ctx.updateSettings({ backgroundValue: bgValInput.value.trim() });
      });
      fBgVal.appendChild(bgValInput);
      bgRow.appendChild(fBgKind);
      bgRow.appendChild(fBgVal);
      body.appendChild(bgRow);

      if (imgFiles.length > 0) {
        const fPick = el('div', 'ch-form-field');
        fPick.appendChild(el('span', 'ch-form-label', '快速选用库内图片'));
        const pickSel = document.createElement('select');
        pickSel.className = 'ch-select';
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '（不修改）';
        pickSel.appendChild(emptyOpt);
        for (const im of imgFiles.slice(0, 60)) {
          const o = document.createElement('option');
          o.value = im.path;
          o.textContent = im.path;
          pickSel.appendChild(o);
        }
        pickSel.addEventListener('change', () => {
          if (!pickSel.value) return;
          bgKindSel.value = 'image';
          bgValInput.value = pickSel.value;
          ctx.updateSettings({ backgroundKind: 'image', backgroundValue: pickSel.value });
        });
        fPick.appendChild(pickSel);
        body.appendChild(fPick);
      }

      const sliderRow = el('div', 'ch-form-row-2');
      const fCardOp = el('div', 'ch-form-field');
      const cardOpLabel = el('span', 'ch-form-label', `卡片透明度 (${settings.cardOpacity})`);
      fCardOp.appendChild(cardOpLabel);
      const cardOp = document.createElement('input');
      cardOp.type = 'range';
      cardOp.min = '0.3';
      cardOp.max = '1';
      cardOp.step = '0.02';
      cardOp.value = String(settings.cardOpacity);
      cardOp.addEventListener('input', () => {
        const val = Number(cardOp.value);
        cardOpLabel.textContent = `卡片透明度 (${val})`;
        ctx.updateSettings({ cardOpacity: val });
      });
      fCardOp.appendChild(cardOp);

      const fCardBlur = el('div', 'ch-form-field');
      const cardBlurLabel = el('span', 'ch-form-label', `卡片磨砂 (${settings.cardBlur}px)`);
      fCardBlur.appendChild(cardBlurLabel);
      const cardBlur = document.createElement('input');
      cardBlur.type = 'range';
      cardBlur.min = '0';
      cardBlur.max = '24';
      cardBlur.step = '1';
      cardBlur.value = String(settings.cardBlur);
      cardBlur.addEventListener('input', () => {
        const val = Number(cardBlur.value);
        cardBlurLabel.textContent = `卡片磨砂 (${val}px)`;
        ctx.updateSettings({ cardBlur: val });
      });
      fCardBlur.appendChild(cardBlur);
      sliderRow.appendChild(fCardOp);
      sliderRow.appendChild(fCardBlur);
      body.appendChild(sliderRow);

      addToggle('显示大标题', 'showTitle');
      addToggle('显示顶部「随手晾晾」', 'showStickyNotes');
      addToggle('显示右上「螺旋日程」螺旋图', 'showFocusDial');
      addToggle('显示时钟卡片', 'showClock');
      addToggle('显示日历卡片', 'showCalendar');
      addToggle('显示书签卡片', 'showBookmarks');
      addToggle('显示最近笔记卡片', 'showRecent');
      addToggle('显示日注卡片', 'showJournal');
      addToggle('显示任务工作区卡片', 'showTasks');
      addToggle('显示项目甘特图', 'showGantt');

      const footer = el('div', 'ch-modal-footer');
      const doneBtn = el('button', 'ch-btn is-primary', '完成');
      doneBtn.addEventListener('click', close);
      footer.appendChild(doneBtn);
      body.appendChild(footer);
    });
  }

  return {
    showModal,
    openFlashCaptureModal,
    openNewTaskModal,
    openNewExecutionTaskModal,
    openNewNoteModal,
    openAddBookmarkModal,
    openConfirmDeleteBookmarkGroupModal,
    openSettingsModal,
    cleanup,
  };
}

module.exports = {
  createModalManager,
};
