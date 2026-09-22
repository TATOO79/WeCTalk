/* ============ WeTalk · 主逻辑（文档库 + 编辑器） ============ */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* 是否运行在安卓 App（WebView 注入 UA 标记）内 */
  const IS_APP = /WeTalkApp/.test(navigator.userAgent);
  document.documentElement.classList.toggle('is-app', IS_APP);
  // 供原生层查询当前是否处于编辑页（系统返回键拦截用）
  window.__wtInEditor = () => !$('#view-editor').classList.contains('hidden');
  const fmtDate = ts => {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* ============ 数据层 ============ */
  const DB_KEY = 'wetalk_db_v1';
  let db;
  function load() {
    try { db = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { db = null; }
    if (!db) db = { folders: [], docs: [], theme: 'day' };
    // 迁移：为旧文档补齐全局行号
    (db.docs || []).forEach(d => {
      if (typeof d.rowSeq !== 'number') {
        d.rowSeq = d.lines.length;
        d.lines.forEach((l, i) => { l.row = i + 1; });
      }
      // 旧文档若已有标题，视为用户标题，保持现状不变
      if (typeof d.titleManual !== 'boolean') d.titleManual = !!(d.title && d.title.trim());
    });
    // 迁移：人物信息库（上限 10）与按键方案
    if (!Array.isArray(db.people)) db.people = [];
    if (!db.keymap || typeof db.keymap !== 'object') db.keymap = {};
  }
  function save() {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    scheduleSupaPush();  // 登录后：本地每次保存自动安排上传（函数声明，下方云模块定义）
  }

  const defaultSettings = () => ({
    left:  { name: '', avatar: '' },
    right: { name: '', avatar: '' }
  });

  /* ============ 主题 ============ */
  function applyTheme() {
    document.documentElement.dataset.theme = db.theme;
  }
  function toggleTheme() {
    db.theme = db.theme === 'day' ? 'night' : 'day';
    applyTheme(); save();
    requestAnimationFrame(fitTitle);
  }

  /* ============ Toast ============ */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    // 默认单行；只有整句超出屏幕宽度（少见的长错误）才允许换行，仍居中
    t.style.whiteSpace = (t.scrollWidth > window.innerWidth - 32) ? 'normal' : 'nowrap';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
  /* 暴露给原生层：App 内所有提示统一走这个纯文字胶囊（无应用图标、不加粗） */
  window.WTToast = toast;

  /* ============ 弹窗管理 ============ */
  function openModal(id) {
    $('#modal-mask').classList.remove('hidden');
    $(id).classList.remove('hidden');
  }
  function closeModals() {
    $('#modal-mask').classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  }
  $('#modal-mask').addEventListener('click', () => {
    // 强制登录门显示时，点遮罩不能关闭
    if (!$('#modal-auth').classList.contains('hidden')) return;
    closeModals();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#modal-auth').classList.contains('hidden')) closeModals();
  });
  // 输入弹窗（新建文件夹/重命名）回车视同确认
  $('#prompt-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#prompt-ok').click(); }
  });
  // 通用取消：重命名/新建文件夹 与 删除确认
  $('#prompt-cancel').addEventListener('click', closeModals);
  $('#confirm-cancel').addEventListener('click', closeModals);

  /* ============ 主界面：文档库 ============ */
  let currentFolder = null; // null = 根目录
  let searchQuery = '';     // 文件名搜索关键字
  /* 列表排序：按创建时间升降序，默认降序（新→旧），全局记忆；各级页面与搜索结果共用 */
  const SORT_KEY = 'wetalk_sort_desc_v1';
  let sortDesc = true;
  try { sortDesc = localStorage.getItem(SORT_KEY) !== '0'; } catch (e) {}
  const sortByTime = arr => {
    const a = [...arr].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    return sortDesc ? a.reverse() : a;
  };
  function refreshSortBtn() {
    const btn = $('#btn-sort');
    btn.classList.toggle('desc', sortDesc);
    btn.classList.toggle('asc', !sortDesc);
    btn.title = sortDesc ? '当前按时间降序（新→旧），点击切换升序' : '当前按时间升序（旧→新），点击切换降序';
  }
  $('#btn-sort').addEventListener('click', () => {
    sortDesc = !sortDesc;
    try { localStorage.setItem(SORT_KEY, sortDesc ? '1' : '0'); } catch (e) {}
    refreshSortBtn();
    renderLibrary();
  });

  const ICONS = {
    doc: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    // 文件夹：实心填充，与线框文稿图标形成明确层级区分
    folder: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    // 桌面（根目录）
    home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/></svg>',
    chevron: '<svg class="tree-chevron" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>'
  };

  function childrenOf(folderId) {
    return {
      folders: db.folders.filter(f => f.parentId === folderId),
      docs: db.docs.filter(d => d.folderId === folderId)
    };
  }
  function folderPath(folderId) {
    const path = [];
    let cur = folderId;
    while (cur !== null) {
      const f = db.folders.find(x => x.id === cur);
      if (!f) break;
      path.unshift(f); cur = f.parentId;
    }
    return path;
  }
  function isDescFolder(id, target) {
    let cur = target;
    while (cur !== null) {
      if (cur === id) return true;
      const f = db.folders.find(x => x.id === cur);
      cur = f ? f.parentId : null;
    }
    return false;
  }

  function renderLibrary() {
    // 面包屑
    const bc = $('#breadcrumb');
    bc.innerHTML = '';
    const searching = searchQuery.trim().length > 0;
    if (searching) {
      const c = document.createElement('span');
      c.className = 'crumb current';
      c.textContent = `搜索：${searchQuery.trim()}`;
      bc.appendChild(c);
    } else {
      const root = document.createElement('span');
      root.className = 'crumb' + (currentFolder === null ? ' current' : '');
      root.textContent = '桌面';
      root.onclick = () => { currentFolder = null; renderLibrary(); };
      bc.appendChild(root);
      folderPath(currentFolder).forEach((f, i, arr) => {
        const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/';
        bc.appendChild(sep);
        const c = document.createElement('span');
        c.className = 'crumb' + (i === arr.length - 1 ? ' current' : '');
        c.textContent = f.name;
        c.onclick = () => { currentFolder = f.id; renderLibrary(); };
        bc.appendChild(c);
      });
    }

    // 列表
    const list = $('#doc-list');
    list.innerHTML = '';
    let folders, docs;
    if (searching) {
      const q = searchQuery.trim().toLowerCase();
      folders = db.folders.filter(f => f.name.toLowerCase().includes(q));
      docs = db.docs.filter(d => resolveTitle(d).toLowerCase().includes(q));
    } else {
      ({ folders, docs } = childrenOf(currentFolder));
    }
    // 文件夹、文稿两组分别按创建时间统一排序（各级页面与搜索结果一致）
    folders = sortByTime(folders);
    docs = sortByTime(docs);
    if (!folders.length && !docs.length) {
      list.innerHTML = `<div class="empty-tip">${ICONS.doc}<br>${searching ? '没有找到匹配的文件' : '这里空空如也，点击右下角 + 新建'}</div>`;
    }
    folders.forEach(f => list.appendChild(buildRow({
      type: 'folder', id: f.id, name: f.name, createdAt: f.createdAt,
      // 搜索结果中点击文件夹 → 跳到它所在位置并展开
      gotoFolder: searching ? f.id : null
    })));
    docs.forEach(d => list.appendChild(buildRow({ type: 'doc', id: d.id, name: resolveTitle(d), createdAt: d.createdAt })));

    // 底部汇总
    const totalFolders = db.folders.length, totalDocs = db.docs.length;
    $('#lib-footer').innerHTML = `共 <b>${totalDocs}</b> 篇文稿 &nbsp;·&nbsp; <b>${totalFolders}</b> 个文件夹`;

    renderNavTree();
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.className = 'doc-row' + (item.type === 'folder' ? ' folder' : '');
    row.style.animationDelay = Math.min(document.querySelectorAll('.doc-row').length * 30, 240) + 'ms';
    row.innerHTML = `
      <div class="row-icon">${item.type === 'folder' ? ICONS.folder : ICONS.doc}</div>
      <div class="row-info">
        <div class="row-name"></div>
        <div class="row-date">创建于 ${fmtDate(item.createdAt)}</div>
      </div>
      <button class="icon-btn row-menu">${ICONS.dots}</button>`;
    row.querySelector('.row-name').textContent = item.name;
    row.onclick = e => {
      if (e.target.closest('.row-menu')) return;
      if (item.type === 'folder') {
        // 搜索结果中：退出搜索态并进入目标文件夹
        if (item.gotoFolder) {
          searchQuery = ''; $('#search-input').value = '';
          navExpanded.add(item.gotoFolder);
          currentFolder = item.gotoFolder;
        } else {
          currentFolder = item.id;
        }
        renderLibrary();
      }
      else openEditor(item.id);
    };
    row.querySelector('.row-menu').onclick = e => {
      e.stopPropagation();
      showContextMenu(e, item);
    };
    return row;
  }

  /* 三点菜单 */
  function showContextMenu(e, item) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const acts = [
      { label: '重命名', icon: '<svg viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>', fn: () => renameItem(item) },
      { label: '移动', icon: '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>', fn: () => moveItem(item) },
      { label: '删除', icon: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>', fn: () => deleteItem(item), danger: true }
    ];
    acts.forEach(a => {
      const b = document.createElement('button');
      if (a.danger) b.className = 'danger';
      b.innerHTML = a.icon + a.label;
      b.onclick = () => { menu.remove(); a.fn(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  }

  function renameItem(item) {
    $('#prompt-title').textContent = item.type === 'folder' ? '重命名文件夹' : '重命名文稿';
    const input = $('#prompt-input');
    const setErr = msg => { $('#prompt-error').textContent = msg || ''; };
    input.value = item.name;
    setErr('');
    openModal('#modal-prompt');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    input.oninput = () => setErr('');     // 一旦修改，清掉重名提示，重新由保存判定
    $('#prompt-ok').onclick = () => {
      const v = input.value.trim();
      if (!v) return toast('名称不能为空');
      const folderId = item.type === 'folder'
        ? db.folders.find(f => f.id === item.id).parentId
        : db.docs.find(x => x.id === item.id).folderId;
      if (siblingNameExists(item.type, v, folderId, item.id)) {
        setErr('名称重复');                // 同级同类不允许重名，阻止保存
        return;
      }
      if (item.type === 'folder') db.folders.find(f => f.id === item.id).name = v;
      else {
        const d = db.docs.find(x => x.id === item.id);
        d.title = v;
        d.titleManual = true;             // 主动重命名 = 用户标题，不再被自动命名覆盖
        if (editing && editing.id === item.id) { editing.titleManual = true; $('#ed-title').value = v; fitTitle(); }
      }
      setErr('');
      save(); closeModals(); renderLibrary();
      toast('已重命名');
    };
  }

  /* 通用文件夹层级选择树（移动 / 保存位置共用）：
     桌面为第一级（可选），其下文件夹递归为第二级、第三级……
     默认展开桌面（第二级直接可见），更深层级点箭头展开；容器限高、滚动不穿透。 */
  function renderFolderPicker(container, opts) {
    const selected0 = opts.selected === undefined ? null : opts.selected;
    const excludeFolderId = opts.excludeFolderId || null;
    let chosen = selected0;
    const expanded = new Set([null]);   // 桌面默认展开
    const visibleKids = parentId => db.folders.filter(f => f.parentId === parentId)
      .filter(f => !(excludeFolderId && (f.id === excludeFolderId || isDescFolder(excludeFolderId, f.id))));

    function makeRow(fid, name, depth, isRoot) {
      const el = document.createElement('div');
      el.className = 'tree-item' + (isRoot ? ' is-root' : '');
      el.dataset.fid = String(fid);
      el.style.paddingLeft = (10 + depth * 18) + 'px';
      const canExpand = visibleKids(fid).length > 0;
      el.innerHTML = (isRoot ? ICONS.home : ICONS.folder)
        + '<span class="tw-name"></span>'
        + (canExpand ? ICONS.chevron : '<span class="tree-chevron" style="visibility:hidden"></span>');
      el.querySelector('.tw-name').textContent = name;
      el.classList.toggle('expanded', expanded.has(fid));
      const chev = el.querySelector('.tree-chevron');
      chev.style.visibility = canExpand ? 'visible' : 'hidden';
      chev.addEventListener('click', e => {
        e.stopPropagation();
        if (expanded.has(fid)) expanded.delete(fid); else expanded.add(fid);
        draw();
      });
      el.addEventListener('click', e => {
        if (e.target.closest('.tree-chevron')) return;
        chosen = fid;
        container.querySelectorAll('.tree-item').forEach(t =>
          t.classList.toggle('selected', t.dataset.fid === String(chosen)));
      });
      return el;
    }
    function draw() {
      container.innerHTML = '';
      container.appendChild(makeRow(null, '桌面', 0, true));
      const addKids = (parentId, depth) => {
        visibleKids(parentId).forEach(f => {
          container.appendChild(makeRow(f.id, f.name, depth, false));
          if (expanded.has(f.id)) addKids(f.id, depth + 1);
        });
      };
      addKids(null, 1);
      container.querySelectorAll('.tree-item').forEach(t =>
        t.classList.toggle('selected', t.dataset.fid === String(chosen)));
    }
    draw();
    return { get value() { return chosen; } };
  }

  let moveTarget = null, movePicker = null;
  function moveItem(item) {
    moveTarget = item;
    const cur = item.type === 'folder'
      ? db.folders.find(f => f.id === item.id).parentId
      : db.docs.find(d => d.id === item.id).folderId;
    movePicker = renderFolderPicker($('#move-tree'), {
      selected: cur,
      excludeFolderId: item.type === 'folder' ? item.id : null
    });
    openModal('#modal-move');
    $('#btn-move-ok').onclick = () => {
      const target = movePicker.value;
      if (item.type === 'folder') db.folders.find(f => f.id === item.id).parentId = target;
      else db.docs.find(d => d.id === item.id).folderId = target;
      save(); closeModals(); renderLibrary();
      toast('已移动到' + (target === null ? '桌面' : '目标文件夹'));
    };
  }

  function deleteItem(item) {
    $('#confirm-title').textContent = item.type === 'folder' ? '删除文件夹' : '删除文稿';
    $('#confirm-text').textContent = item.type === 'folder'
      ? `将删除文件夹「${item.name}」及其全部内容，此操作不可恢复。`
      : `将删除文稿「${item.name}」，此操作不可恢复。`;
    openModal('#modal-confirm');
    $('#confirm-ok').onclick = () => {
      if (item.type === 'folder') {
        const ids = [item.id];
        while (ids.length) {
          const cur = ids.pop();
          db.folders.filter(f => f.parentId === cur).forEach(f => ids.push(f.id));
          db.docs = db.docs.filter(d => d.folderId !== cur);
          db.folders = db.folders.filter(f => f.id !== cur);
        }
      } else {
        db.docs = db.docs.filter(d => d.id !== item.id);
      }
      save(); closeModals(); renderLibrary();
      toast('已删除');
    };
  }

  /* 新建 */
  $('#fab').onclick = e => { e.stopPropagation(); document.querySelector('.fab-wrap').classList.toggle('open'); };
  document.addEventListener('click', e => {
    if (!e.target.closest('.fab-wrap')) document.querySelector('.fab-wrap').classList.remove('open');
  });
  document.querySelectorAll('.fab-menu button').forEach(b => {
    b.onclick = () => {
      document.querySelector('.fab-wrap').classList.remove('open');
      if (b.dataset.new === 'doc') createDoc();
      else createFolder();
    };
  });

  function createFolder() {
    $('#prompt-title').textContent = '新建文件夹';
    const input = $('#prompt-input');
    const setErr = msg => { $('#prompt-error').textContent = msg || ''; };
    input.value = uniqueFolderName('新建文件夹', currentFolder);
    setErr('');
    openModal('#modal-prompt');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    input.oninput = () => setErr('');
    $('#prompt-ok').onclick = () => {
      const v = input.value.trim() || '新建文件夹';
      if (siblingNameExists('folder', v, currentFolder, null)) {
        setErr('名称重复');
        return;
      }
      setErr('');
      db.folders.push({ id: uid(), name: v, parentId: currentFolder, createdAt: Date.now() });
      save(); closeModals(); renderLibrary();
      toast('文件夹已创建');
    };
  }

  /* 新建文稿：先选择保存位置（桌面/文件夹），确认后才创建并进入编辑；
     「不保存」= 放弃创建，直接关弹窗 */
  let createPicker = null;
  function createDoc() {
    createPicker = renderFolderPicker($('#save-tree'), { selected: currentFolder });
    openModal('#modal-savepos');
  }
  $('#btn-savepos-ok').onclick = () => {
    const folderId = createPicker ? createPicker.value : null;
    const doc = {
      id: uid(),
      folderId,
      title: '',
      createdAt: Date.now(),
      settings: defaultSettings(),
      lines: [],
      rowSeq: 0,
      titleManual: false,
      savedOnce: true       // 位置已选定，后续一律自动保存
    };
    db.docs.push(doc);
    save();
    closeModals();
    openEditor(doc.id);
  };
  $('#btn-savepos-discard').onclick = closeModals;

  /* 右侧快速导航：单击文件夹展开/折叠（含内层文件夹与文稿）；双击文稿进入编辑 */
  const navExpanded = new Set();
  function renderNavTree() {
    const nav = $('#nav-tree');
    nav.innerHTML = '';
    // 当前位置的父级链默认展开，保证所在文件夹可见
    let anc = currentFolder;
    while (anc) {
      const f = db.folders.find(x => x.id === anc);
      anc = f ? f.parentId : null;
      if (anc) navExpanded.add(anc);
    }
    const root = document.createElement('div');
    root.className = 'nav-item is-folder' + (currentFolder === null ? ' active' : '');
    root.innerHTML = ICONS.home + '<span>桌面</span>';
    root.onclick = () => { currentFolder = null; searchQuery = ''; $('#search-input').value = ''; renderLibrary(); };
    nav.appendChild(root);

    const addNodes = (parentId, depth) => {
      // 先内层文件夹
      db.folders.filter(f => f.parentId === parentId).forEach(f => {
        const open = navExpanded.has(f.id);
        const el = document.createElement('div');
        el.className = 'nav-item is-folder' + (currentFolder === f.id ? ' active' : '');
        el.style.paddingLeft = (10 + depth * 17) + 'px';
        el.innerHTML = ICONS.folder + '<span></span>';
        el.querySelector('span').textContent = f.name;
        el.title = '单击展开 / 折叠';
        el.onclick = () => {
          if (navExpanded.has(f.id)) navExpanded.delete(f.id);
          else navExpanded.add(f.id);
          renderNavTree();
        };
        nav.appendChild(el);
        if (open) addNodes(f.id, depth + 1);
      });
      // 再文稿
      db.docs.filter(d => d.folderId === parentId).forEach(d => {
        const el = document.createElement('div');
        el.className = 'nav-item is-doc';
        el.style.paddingLeft = (10 + depth * 17) + 'px';
        el.innerHTML = ICONS.doc + '<span></span>';
        el.querySelector('span').textContent = resolveTitle(d);
        el.title = '双击打开';
        el.ondblclick = () => openEditor(d.id);
        nav.appendChild(el);
      });
    };
    addNodes(null, 1);
  }

  const sideNav = $('#side-nav');
  const sideMask = $('#side-mask');
  function closeSideNav() {
    sideNav.classList.remove('open');
    $('#btn-sidebar').classList.remove('active');
    sideMask.classList.remove('show');
  }
  $('#btn-sidebar').onclick = () => {
    const open = sideNav.classList.toggle('open');
    $('#btn-sidebar').classList.toggle('active', open);
    sideMask.classList.toggle('show', open);
  };
  sideMask.onclick = closeSideNav;

  /* 顶部搜索框：按文件名实时过滤 */
  $('#search-input').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderLibrary();
  });

  /* ============ 编辑界面 ============ */
  let editing = null;          // 当前编辑的文档
  let editSide = 'R';          // 当前输入侧（默认右侧）
  let backWarned = false;      // 本次编辑内系统返回提示是否已弹过（每次进入编辑重置，补全模式共用）
  let insertMode = null;       // 补全模式：{ slotRow, added, startG }
  let editingBubble = null;    // 正在进行文字编辑的气泡（正常状态为 null）
  let swallowAreaClick = false; // 气泡编辑退出当拍：只保存退出，不触发补全/其他气泡编辑
  /* 电脑端常驻角色选择（App 端不用：App 点圆圈即发送）。默认右侧，
     只有鼠标点圆圈或 Shift+←→ 才切换；回车发到当前选中角色 */
  let webSide = 'R';
  function setWebSide(side) {
    webSide = side;
    editSide = side;            // 失焦草稿等仍复用 editSide
    updateSideTag();
  }

  function autoTitle(doc) {
    const L = doc.settings.left.name.trim();
    const R = doc.settings.right.name.trim();
    if (L && R) return `${L}和${R}的对话`;
    if (L || R) return `${L || R}和未命名的对话`;
    return '未命名对话';
  }
  /* 最终落库标题：用户手动命名则用用户标题，否则按人物名实时生成。
     自动命名在同一文件夹内去重：基础名被占用时，从 1 开始追加最小可用整数，
     如「阿明和阿红的对话」「阿明和阿红的对话1」「阿明和阿红的对话2」。
     同组文稿按创建顺序分配，保证任何时候解析结果都稳定、不互相重复。 */
  function resolveTitle(doc) {
    if (doc.titleManual && doc.title && doc.title.trim()) return doc.title.trim();
    const base = autoTitle(doc);
    const used = new Set();
    db.docs.forEach(d => {
      if (d.folderId !== doc.folderId || d.id === doc.id) return;
      if (d.titleManual && d.title && d.title.trim()) used.add(d.title.trim().toLowerCase());
    });
    const group = db.docs
      .filter(d => d.folderId === doc.folderId && d.id !== doc.id
        && !(d.titleManual && d.title && d.title.trim())
        && autoTitle(d) === base)
      .concat([doc])
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let result = base;
    group.forEach(d => {
      let name = base;
      if (used.has(name.toLowerCase())) {
        let n = 1;
        while (used.has((base + n).toLowerCase())) n++;
        name = base + n;
      }
      used.add(name.toLowerCase());
      if (d.id === doc.id) result = name;
    });
    return result;
  }

  /* 同级同类名称查重（文件夹比文件夹、文稿比文稿；忽略大小写与首尾空格） */
  function siblingNameExists(kind, name, folderId, excludeId) {
    const v = (name || '').trim().toLowerCase();
    if (!v) return false;
    if (kind === 'folder') {
      return db.folders.some(f => f.id !== excludeId && f.parentId === folderId
        && f.name.trim().toLowerCase() === v);
    }
    return db.docs.some(d => d.id !== excludeId && d.folderId === folderId
      && resolveTitle(d).trim().toLowerCase() === v);
  }

  /* 文件夹默认名去重：同级已占用则追加从 1 开始的最小整数 */
  function uniqueFolderName(base, parentId) {
    const used = new Set(db.folders
      .filter(f => f.parentId === parentId).map(f => f.name.trim().toLowerCase()));
    if (!used.has(base.toLowerCase())) return base;
    let n = 1;
    while (used.has((base + n).toLowerCase())) n++;
    return base + n;
  }
  /* 标题栏直接显示当前有效标题（自动命名也会真实显示，而不只是占位文字） */
  function refreshTitleField() {
    if (!editing) return;
    $('#ed-title').value = resolveTitle(editing);
    fitTitle();
  }

  function openEditor(docId) {
    editing = db.docs.find(d => d.id === docId);
    editSide = 'R';
    backWarned = false;                        // 每次进入编辑：返回提示重新计数
    insertMode = null;                         // 补全模式随文档重新进入而重置
    editingBubble = null;                      // 气泡编辑态复位
    swallowAreaClick = false;
    webSide = 'R';                             // 电脑端每次进入默认选中右角色
    $('#insert-done').classList.add('hidden');
    $('#fmt-bar').classList.add('hidden');     // 字体格式栏默认收起
    $('#btn-font').classList.remove('active');
    closeSideNav();
    // 标题栏直接显示有效标题：手动命名显示用户标题，否则显示按人物名生成的自动标题
    $('#ed-title').value = resolveTitle(editing);
    $('#input-box').innerHTML = '';
    updateSideTag();
    updateNameBar();
    renderChat();
    showView('editor');
    requestAnimationFrame(fitTitle);
  }

  function showView(v) {
    $('#view-library').classList.toggle('hidden', v !== 'library');
    $('#view-editor').classList.toggle('hidden', v !== 'editor');
    if (v === 'library') { if (editing) currentFolder = editing.folderId; renderLibrary(); }
  }

  /* 侧标签：保存人物名后显示名字第一个字符（数字/字母同理），未设置时显示"左/右" */
  function sideLabel(side) {
    const key = side === 'L' ? 'left' : 'right';
    const n = (editing.settings[key].name || '').trim();
    return n ? Array.from(n)[0] : (side === 'L' ? '左' : '右');
  }
  function updateSideTag() {
    /* 左右圆圈常显，各自显示对应侧的人物首字（未命名显示 左/右） */
    $('#side-tag-l').textContent = sideLabel('L');
    $('#side-tag-r').textContent = sideLabel('R');
    /* 选中侧（UI 标识）：电脑端跟随常驻 webSide；App 跟随最近发送侧 editSide。
       圆圈放大加框 + 该半侧栏内渐变，双端一致 */
    const side = IS_APP ? editSide : webSide;
    $('#side-tag-l').classList.toggle('is-selected', side === 'L');
    $('#side-tag-r').classList.toggle('is-selected', side === 'R');
    $('#input-area').classList.toggle('sel-l', side === 'L');
    $('#input-area').classList.toggle('sel-r', side === 'R');
  }
  /* 名称行：左右栏各自居中显示人物名；未设置时该侧留空（行高始终占位） */
  function updateNameBar() {
    if (!editing) return;
    $('#name-bar-l').textContent = (editing.settings.left.name || '').trim();
    $('#name-bar-r').textContent = (editing.settings.right.name || '').trim();
  }

  function buildBubble(line) {
    const el = document.createElement('div');
    el.className = 'chat-line';
    el.contentEditable = 'true';          // 已发送内容可选中后加粗/下划线
    el.dataset.side = line.side;
    el.dataset.row = line.row;
    el.style.gridRow = line.row;          // 关键：占据全局行号对应的共享网格行
    if (line.empty) el.dataset.empty = '1';   // 主动发送的空行：保留占位，失焦不删除
    el.innerHTML = line.html || '<br>';
    return el;
  }

  function renderChat() {
    const area = $('#chat-area');
    editingBubble = null;                 // 气泡 DOM 将整体重建，编辑态复位
    swallowAreaClick = false;
    area.classList.toggle('has-lines', editing.lines.length > 0);
    area.querySelectorAll('.chat-line, .chat-empty, .insert-slot').forEach(n => n.remove());
    if (!editing.lines.length) {
      const tip = document.createElement('div');
      tip.className = 'chat-empty';
      tip.textContent = IS_APP
        ? '在下方输入框开始记录对话\n· 点左圈发到左栏，点右圈发到右栏\n· 回车在框内换行'
        : '在下方输入框开始记录对话\n· 点圆圈或 Shift+←→ 选择角色，回车发送\n· Ctrl+回车框内换行 · ←/→+回车直发该侧但不切换角色';
      area.appendChild(tip);
    } else {
      [...editing.lines].sort((a, b) => a.row - b.row)
        .forEach(line => area.appendChild(buildBubble(line)));
      // 补全模式：在空出的行位渲染横跨左右的白色圆框槽位
      if (insertMode) {
        const slot = document.createElement('div');
        slot.className = 'insert-slot';
        slot.style.gridRow = insertMode.slotRow;
        area.appendChild(slot);
      }
    }
    area.scrollTop = area.scrollHeight;
  }

  /* 追加单条气泡（不整体重绘，避免破坏用户在其他气泡上的选区） */
  function appendBubble(line) {
    const area = $('#chat-area');
    area.classList.add('has-lines');
    area.querySelector('.chat-empty')?.remove();
    area.appendChild(buildBubble(line));
    area.scrollTop = area.scrollHeight;
  }

  /* ============================================================
     按键「可替换符号」体系
     · 5 个功能各自可挂 1~2 个方案；默认方案与原始逻辑完全一致
     · 方案 = 1~2 次按键序列（每次 = 修饰键集合 + 主键）
     · 用户自定义保存后一键替换到对应符号；未自定义时恒为默认值
     输入行为：
     · App：回车只在框内换行，发送靠点左右圆圈（键盘自定义主要服务网页端）
     · 网页：见默认方案；Ctrl+回车 = 框内换行（保留硬编码）
     ============================================================ */
  const KEY_FUNCS = [
    { id: 'switchL',     name: '切换为左角色' },
    { id: 'switchR',     name: '切换为右角色' },
    { id: 'sendL',       name: '发送为左角色' },
    { id: 'sendR',       name: '发送为右角色' },
    { id: 'sendCurrent', name: '发送当前内容' }
  ];
  const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];
  const Kp = (mods, key) => ({ mods: mods || [], key });
  const DEFAULT_KEYMAP = {
    switchL:     [{ keys: [Kp(['shift'], 'ArrowLeft')] }],
    switchR:     [{ keys: [Kp(['shift'], 'ArrowRight')] }],
    sendL:       [{ keys: [Kp([], 'ArrowLeft'), Kp([], 'Enter')] }],
    sendR:       [{ keys: [Kp([], 'ArrowRight'), Kp([], 'Enter')] }],
    sendCurrent: [{ keys: [Kp([], 'Enter')] }]
  };

  function normKeyEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('meta');
    return { mods, key: e.key };
  }
  function keyEqual(a, b) {
    if (a.key !== b.key || a.mods.length !== b.mods.length) return false;
    return MOD_ORDER.every(m => a.mods.includes(m) === b.mods.includes(m));
  }
  /* 方案归一化/校验（防止云端/本地脏数据） */
  function normScheme(sc) {
    if (!sc || !Array.isArray(sc.keys)) return null;
    const keys = sc.keys.slice(0, 2).map(k => {
      if (!k || typeof k.key !== 'string') return null;
      const mods = (Array.isArray(k.mods) ? k.mods : []).filter(m => MOD_ORDER.includes(m));
      return { mods: MOD_ORDER.filter(m => mods.includes(m)), key: k.key };
    });
    if (!keys.length || keys.some(k => !k)) return null;
    return { keys };
  }
  /* 某功能的生效方案：有自定义用自定义（整体替换默认），否则用默认 */
  function funcSchemes(fid) {
    const saved = db.keymap[fid];
    if (Array.isArray(saved)) {
      const list = saved.slice(0, 2).map(normScheme).filter(Boolean);
      if (list.length) return list;
    }
    return DEFAULT_KEYMAP[fid].map(normScheme);
  }
  function funcIsCustom(fid) {
    const saved = db.keymap[fid];
    return Array.isArray(saved)
      && saved.slice(0, 2).map(normScheme).filter(Boolean).length > 0;
  }

  /* 友好显示名 */
  const KEY_PRETTY = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    ' ': 'Space', Enter: '回车', Escape: 'Esc', Tab: 'Tab',
    Backspace: '⌫', Delete: 'Del', ScreenTap: '单击'
  };
  function keyPressLabel(k) {
    const parts = k.mods.map(m => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' }[m]));
    parts.push(KEY_PRETTY[k.key] || (k.key.length === 1 ? k.key.toUpperCase() : k.key));
    return parts.join('+');
  }
  function schemeLabel(sc) {
    return sc.keys.map(keyPressLabel).join(' → ');
  }

  /* ---------- 序列识别器：多键方案按顺序匹配（等价原「按住方向键+回车」） ---------- */
  const inputBox = $('#input-box');
  let keyPending = null;   // {fid, scheme, step, timer}
  function clearKeyPending() {
    if (keyPending) { clearTimeout(keyPending.timer); keyPending = null; }
  }
  function matchKey(k) {
    if (keyPending) {
      const p = keyPending;
      if (keyEqual(k, p.scheme.keys[p.step])) {
        clearTimeout(p.timer);
        if (p.step + 1 >= p.scheme.keys.length) {
          const fid = p.fid;
          keyPending = null;
          return { fire: fid };
        }
        p.step += 1;
        p.timer = setTimeout(clearKeyPending, 1200);
        return { pending: true };
      }
      clearKeyPending();   // 不匹配：作废前缀，继续走全新匹配
    }
    let fireNow = null, prefix = null;
    KEY_FUNCS.forEach(f => {
      funcSchemes(f.id).forEach(scheme => {
        if (keyEqual(k, scheme.keys[0])) {
          if (scheme.keys.length === 1) { if (!fireNow) fireNow = f.id; }
          else if (!prefix) prefix = { fid: f.id, scheme, step: 1 };
        }
      });
    });
    if (fireNow) return { fire: fireNow };
    if (prefix) {
      keyPending = { fid: prefix.fid, scheme: prefix.scheme, step: 1,
        timer: setTimeout(clearKeyPending, 1200) };
      return { pending: true };
    }
    return {};
  }
  function runKeyAction(fid) {
    if (fid === 'switchL') setWebSide('L');
    else if (fid === 'switchR') setWebSide('R');
    else if (fid === 'sendL') commitInput(true, 'L');
    else if (fid === 'sendR') commitInput(true, 'R');
    else if (fid === 'sendCurrent') commitInput(true, webSide);
  }

  inputBox.addEventListener('keydown', e => {
    if (IS_APP) return;   // App 不拦截任何按键，回车走 contenteditable 默认换行
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {  // 框内换行（保留硬编码）
      e.preventDefault();
      document.execCommand('insertLineBreak');
      return;
    }
    if (e.repeat) return;
    const r = matchKey(normKeyEvent(e));
    if (r.fire) {
      e.preventDefault();
      runKeyAction(r.fire);
    }
  });
  // 失焦时作废序列前缀，并把草稿存为一条（不重绘，防止破坏选区）
  inputBox.addEventListener('blur', () => { clearKeyPending(); commitInput(false); });

  /* 左右圆圈：
     · App：点哪个圈就把当前输入发送到哪侧（什么都没输入不发送，输入空格可发送空格），
       确实发出后圆圈黑色高亮反馈；
     · 网页：点圆圈只切换常驻角色（不发送），发送统一走回车。
     mousedown 阻止默认，避免输入框先失焦把草稿存到另一侧。 */
  function bindSideDot(sel, side) {
    const dot = $(sel);
    dot.addEventListener('mousedown', e => e.preventDefault());
    dot.addEventListener('click', () => {
      if (!IS_APP) { setWebSide(side); inputBox.focus(); return; }
      editSide = side;
      updateSideTag();   // 选中渐变随点击侧移动
      if (!commitInput(true, side)) { inputBox.focus(); return; }
      dot.classList.add('flash');
      clearTimeout(dot._flashTimer);
      dot._flashTimer = setTimeout(() => dot.classList.remove('flash'), 1500);
      inputBox.focus();
    });
  }
  bindSideDot('#side-tag-l', 'L');
  bindSideDot('#side-tag-r', 'R');

  /* 行号归一化：按当前顺序压缩为 1..n（删除气泡 / 结束补全后调用） */
  function normalizeRows() {
    editing.lines.sort((a, b) => a.row - b.row);
    editing.lines.forEach((l, i) => { l.row = i + 1; });
    editing.rowSeq = editing.lines.length;
  }

  /* forceSide：点圆圈发送时指定侧。
     空判定按文本字符数：零字符（含残留 <br>、空标签）一律不发送；
     用户主动输入的空格（普通空格 / &nbsp;）属于有效内容，正常发送。
     返回是否真的发出了一条。 */
  function commitInput(rerender, forceSide) {
    const html = inputBox.innerHTML.trim();
    const isEmpty = inputBox.textContent.replace(/\uFEFF/g, '').length === 0;
    if (isEmpty) { inputBox.innerHTML = ''; return false; }
    const line = { side: forceSide || editSide, html };
    inputBox.innerHTML = '';
    if (insertMode) {
      // 补全模式：落在当前槽位，槽位下方各行整体顺延一行，槽位下移
      line.row = insertMode.slotRow;
      editing.lines.push(line);
      // 槽位以下各行顺延一行，新槽位落到下一行
      editing.lines.forEach(l => { if (l.row > insertMode.slotRow) l.row += 1; });
      editing.rowSeq += 1;
      insertMode.slotRow += 1;
      insertMode.added += 1;
      renderChat();
      scheduleSave();
    } else {
      line.row = ++editing.rowSeq; // 全局递增行号
      editing.lines.push(line);
      if (rerender) renderChat(); else appendBubble(line);
      scheduleSave();
    }
    return true;
  }

  /* ============ 补全模式：点两气泡间缝隙插入漏掉的对话 ============ */
  function enterInsertMode(gapIndex) {
    if (!editing.lines.length) return;
    // 进入前先把输入框里的半成品按普通方式发出
    commitInput(false);
    if (!editing.lines.length) return;
    insertMode = { slotRow: gapIndex + 1, added: 0, startG: gapIndex };
    // 槽位下方的既有行整体下移一行，腾出槽位行
    editing.lines.forEach(l => { if (l.row > gapIndex) l.row += 1; });
    editing.rowSeq += 1;
    renderChat();
    $('#insert-done').classList.remove('hidden');
  }
  function finishInsertMode() {
    if (!insertMode) return;
    if (insertMode.added === 0) {
      // 一条没发：取消补全，把进入时腾出的空行还回去
      const g = insertMode.startG;
      editing.lines.forEach(l => { if (l.row > g) l.row -= 1; });
      editing.rowSeq = Math.max(0, editing.rowSeq - 1);
    } else {
      normalizeRows();
    }
    insertMode = null;
    $('#insert-done').classList.add('hidden');
    renderChat();
    save();
  }
  $('#insert-done').addEventListener('click', finishInsertMode);

  /* ============ 对话区点击状态机 ============
     正常状态：点气泡文字 → 进入该气泡编辑；点气泡外的行间空白 → 进入补全模式。
     气泡编辑中：在对话可见区内点当前气泡之外的任何位置（行间空白、其他气泡），
       本次点击【仅】保存并退出当前气泡编辑——不触发补全，也不编辑另一个气泡，
       防止误触。再下一次点击才按正常状态判定。
     补全位置按纵向中点判定：第一行之前（名称行/上栏与第一行之间）可补，
       最后一条气泡下半部分及其下方不补。 */
  let suppressInsertClickUntil = 0;
  const chatAreaEl = $('#chat-area');

  /* 保存并退出当前气泡编辑（文字删空的普通气泡删除补位；主动发送的空行保留） */
  function saveAndExitBubble() {
    const bubble = editingBubble;
    if (!bubble) return;
    editingBubble = null;
    if (bubble.textContent.trim() === '' && !bubble.dataset.empty) {
      const row = Number(bubble.dataset.row);
      editing.lines = editing.lines.filter(l => l.row !== row);
      normalizeRows();
      insertMode = null;
      $('#insert-done').classList.add('hidden');
      renderChat();
      save();
      suppressInsertClickUntil = Date.now() + 600;  // 重绘当拍不识别补全
    } else {
      syncBubble(bubble);
    }
    try { bubble.blur(); } catch (e) {}
  }

  /* 气泡编辑中，pointerdown 落在当前气泡之外：拦截默认焦点转移，只做保存退出，
     并吞掉紧随的同拍 click */
  chatAreaEl.addEventListener('pointerdown', e => {
    if (!editingBubble) return;
    if (editingBubble.contains(e.target)) return;   // 当前气泡内部：正常放置光标
    e.preventDefault();
    saveAndExitBubble();
    swallowAreaClick = true;
  }, true);

  /* 跟踪当前正在编辑的气泡 */
  chatAreaEl.addEventListener('focusin', e => {
    const b = e.target.closest && e.target.closest('.chat-line');
    if (b) editingBubble = b;
  });
  chatAreaEl.addEventListener('focusout', e => {
    const b = e.target.closest && e.target.closest('.chat-line');
    if (b && b === editingBubble) saveAndExitBubble();
  });

  chatAreaEl.addEventListener('click', e => {
    if (swallowAreaClick) { swallowAreaClick = false; return; }  // 退出气泡编辑当拍
    if (Date.now() < suppressInsertClickUntil) return;
    if (e.target.closest('.chat-line') || e.target.closest('.insert-slot')) return;
    if (insertMode) return;                       // 补全中：空白点击不影响模式
    if (!editing.lines.length) return;
    const y = e.clientY;
    const areaTop = chatAreaEl.getBoundingClientRect().top;
    if (y < areaTop) return;                      // 双保险：名称行/上栏区域不触发
    const bubbles = [...chatAreaEl.querySelectorAll('.chat-line')]
      .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row));
    let g = -1;
    for (let i = 0; i < bubbles.length; i++) {
      const r = bubbles[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { g = i; break; }
    }
    if (g < 0) return;                            // 最后一条气泡下方：不补全
    enterInsertMode(g);
  });

  /* 加粗 / 下划线：优先作用于用户在【已发送气泡】中选中的文字，
     没有选区时才对输入框内后续输入生效 */
  function formatContext() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 3 ? n.parentElement : n);
    if (!el || !el.closest) return null;
    const bubble = el.closest('.chat-line');
    if (bubble) return { el: bubble, inBubble: true, collapsed: sel.isCollapsed };
    if (el.closest('#input-box')) return { el: inputBox, inBubble: false, collapsed: sel.isCollapsed };
    return null;
  }
  function syncBubble(el) {
    const row = Number(el.dataset.row);
    const line = editing.lines.find(l => l.row === row);
    if (line) {
      line.html = el.innerHTML;
      /* 空行占位气泡一旦输入了真实文字，取消空标记 */
      if (el.textContent.trim()) { line.empty = false; delete el.dataset.empty; }
      scheduleSave();
    }
  }
  function applyFormat(cmd) {
    const ctx = formatContext();
    const target = (ctx && !ctx.collapsed) ? ctx.el : inputBox;
    target.focus();
    document.execCommand(cmd);
    syncFmtState();
    if (target.classList.contains('chat-line')) syncBubble(target);
  }
  // mousedown 阻止默认行为：点击按钮时不夺走选区
  [['#fmt-bold', 'bold'], ['#fmt-underline', 'underline']].forEach(([sel, cmd]) => {
    const btn = $(sel);
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => applyFormat(cmd));
  });
  // 顶栏「字体编辑」图标：展开/收起下方横向加粗、下划线栏
  $('#btn-font').addEventListener('click', () => {
    const open = $('#fmt-bar').classList.toggle('hidden') === false;
    $('#btn-font').classList.toggle('active', open);
  });
  // 气泡内直接编辑（含 Ctrl+B / Ctrl+U）同步回数据
  $('#chat-area').addEventListener('input', e => {
    const bubble = e.target.closest && e.target.closest('.chat-line');
    if (bubble) syncBubble(bubble);
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'u')) {
      const ctx = formatContext();
      if (ctx && ctx.inBubble) { e.preventDefault(); applyFormat(e.key === 'b' ? 'bold' : 'underline'); }
    }
  });
  function syncFmtState() {
    try {
      $('#fmt-bold').classList.toggle('active', document.queryCommandState('bold'));
      $('#fmt-underline').classList.toggle('active', document.queryCommandState('underline'));
    } catch (e) {}
  }
  document.addEventListener('keyup', syncFmtState);
  document.addEventListener('mouseup', syncFmtState);

  /* App 内：输入引导、统一返回体系、左右滑切栏、双指缩放气泡字号 */
  /* 双指缩放因子：仅作用于对话区气泡字号，不影响上下栏 / 左栏 / 导出；
     全局记忆、跨文档迁移；有上下限，到达极限后手势无效且不弹窗 */
  const ZOOM_KEY = 'wetalk_chat_zoom_v1';
  const ZOOM_MIN = 0.85, ZOOM_MAX = 1.6;
  let chatZoom = 1;
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (isFinite(z)) chatZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  } catch (e) {}
  function applyChatZoom(z) {
    chatZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    $('#chat-area').style.setProperty('--chat-zoom', chatZoom);
    try { localStorage.setItem(ZOOM_KEY, String(chatZoom)); } catch (e) {}
  }

  if (IS_APP) {
    const hint = '点击左右两边圆圈发送';
    $('#input-box').setAttribute('data-ph', hint);
    applyChatZoom(chatZoom);

    /* 统一返回（系统返回键 / 屏幕边缘左滑手势都会走到这里）：
       · 有弹窗：先关弹窗
       · 抽屉打开：先关抽屉；搜索中：先退出搜索
       · 编辑页：不退出（补全模式同样不退出补全），每次进入编辑只提示一次。
         用前端 toast（纯文字），避免 Android 12+ 原生 Toast 带应用图标
       · 文件夹内：回到上一级
       · 桌面：双击退出，冷却 2 秒（业界常用值）；超时再按重新提示 */
    const EXIT_COOLDOWN = 2000;
    let lastExitToastAt = 0;
    window.__wtHandleBack = function () {
      const mask = $('#modal-mask');
      if (!mask.classList.contains('hidden')) {
        if (!$('#modal-auth').classList.contains('hidden')) return true; // 登录门不可用返回键关闭
        mask.click(); return true;
      }
      if (sideNav.classList.contains('open')) { closeSideNav(); return true; }

      if (!$('#view-editor').classList.contains('hidden')) {
        if (!backWarned) {
          backWarned = true;
          toast('请点击左上角箭头保存并退出');
        }
        return true;
      }

      if (searchQuery.trim()) {
        searchQuery = ''; $('#search-input').value = ''; renderLibrary();
        return true;
      }
      if (currentFolder !== null) {
        const f = db.folders.find(x => x.id === currentFolder);
        currentFolder = f ? f.parentId : null;
        renderLibrary();
        return true;
      }
      const now = Date.now();
      if (now - lastExitToastAt < EXIT_COOLDOWN) return false;  // 冷却期内：退出 App
      lastExitToastAt = now;
      toast('再次左滑退出');
      return true;
    };

    /* 触摸手势：仅保留双指捏合缩放气泡字号（纵向滚动、左滑退出均不受影响）。
       左右栏切换改为点输入框两侧圆圈，不再识别横滑。 */
    const chatArea = $('#chat-area');
    let pinching = false, pinchDist0 = 0, pinchZoom0 = 1;
    const touchDist = t => {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    };
    chatArea.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinching = true;
        pinchDist0 = touchDist(e.touches);
        pinchZoom0 = chatZoom;
      }
    }, { passive: true });
    chatArea.addEventListener('touchmove', e => {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault();               // 拦住双指滚动 / 系统缩放
      const d = touchDist(e.touches);
      if (pinchDist0 > 0) applyChatZoom(pinchZoom0 * d / pinchDist0);
    }, { passive: false });
    const endPinch = e => {
      if (e.touches && e.touches.length >= 2) return;
      pinching = false;
    };
    chatArea.addEventListener('touchend', endPinch, { passive: true });
    chatArea.addEventListener('touchcancel', () => { pinching = false; }, { passive: true });
  }

  /* 标题协同：
     · 输入非空 = 用户手动命名，标题/桌面文件名/导出名统一跟随
     · 清空 = 交回自动命名（按人物名实时生成）；失焦时把自动标题填回输入框
     · 聚焦在自动标题上时全选文字，用户直接键入即可整体替换 */
  const titleInput = $('#ed-title');
  titleInput.addEventListener('input', () => {
    const v = titleInput.value;
    if (v.trim().length > 0) {
      editing.titleManual = true;
      editing.title = v;
    } else {
      editing.titleManual = false;
      editing.title = autoTitle(editing);
    }
    fitTitle();
    scheduleSave();
  });
  titleInput.addEventListener('focus', () => {
    if (!editing.titleManual) titleInput.select();
  });
  titleInput.addEventListener('blur', () => {
    if (!editing.titleManual) refreshTitleField();
  });

  /* 标题宽度自适应：
     标题始终相对屏幕居中（绝对定位）。内容完整显示时按实际文字宽度；
     超出左右功能组之间的可用宽度时，收缩为「开头文字 + …」：
     默认保留 5 个字，屏幕过窄继续减少，最短只显示 …。
     用离屏 DOM 测量（canvas 在部分安卓 WebView 上测不到粗体中文字宽）。 */
  const titleMeasurer = document.createElement('span');
  titleMeasurer.style.cssText =
    'position:absolute;top:-9999px;left:0;white-space:nowrap;visibility:hidden;';
  document.body.appendChild(titleMeasurer);
  function textWidth(text, cs) {
    titleMeasurer.style.font = cs.font;
    titleMeasurer.style.fontWeight = cs.fontWeight;
    titleMeasurer.style.letterSpacing = cs.letterSpacing;
    titleMeasurer.textContent = text;
    return titleMeasurer.getBoundingClientRect().width;
  }
  function fitTitle() {
    const input = $('#ed-title');
    const left = document.querySelector('.ed-header .ed-left');
    const right = document.querySelector('.ed-header .ed-right');
    if (!left || !right) return;
    const lr = left.getBoundingClientRect();
    const rr = right.getBoundingClientRect();
    // 标题锚定屏幕中心，可用宽度由「较窄的一侧」决定（左右功能组不对称时也不会重叠）
    const cx = window.innerWidth / 2;
    const gap = 2 * Math.min(cx - lr.right, rr.left - cx) - 16;
    const cs = getComputedStyle(input);
    const pad = parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0);
    const text = input.value || input.placeholder || '';
    const chars = Array.from(text);
    let w;
    if (textWidth(text, cs) + pad <= gap) {
      w = textWidth(text, cs) + pad + 4;                    // 放得下：完整居中
    } else {
      const ell = textWidth('…', cs);
      // 取开头 n 个非空字符（保留它们之间的空格），默认 5 个
      const prefixFor = n => {
        let out = '', count = 0;
        for (const ch of chars) {
          out += ch;
          if (ch.trim() !== '') count++;
          if (count === n) break;
        }
        return out;
      };
      let n = Math.min(5, chars.filter(ch => ch.trim() !== '').length);
      while (n > 0 && textWidth(prefixFor(n), cs) + ell > gap - pad) n--;
      w = (n === 0 ? ell : textWidth(prefixFor(n), cs) + ell) + pad + 4;
    }
    input.style.width = Math.max(22, w) + 'px';
  }
  window.addEventListener('resize', fitTitle);
  document.addEventListener('theme:changed', fitTitle);

  /* 保存：新建时已选好位置，编辑期所有改动默认自动保存（轻量防抖落库） */
  let saveTimer = null;
  function scheduleSave() {
    if (!editing) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
  }
  function persistNow() {
    if (!editing) return;
    clearTimeout(saveTimer);
    editing.title = resolveTitle(editing);   // 落库标题实时解析
    save();
  }

  /* 回到文档库时刷新列表（保证新建/改名/改位置即时可见） */
  function backToLibrary() {
    renderLibrary();
    showView('library');
  }

  /* 左上角箭头：兜底提交输入框内容并落库，然后返回文档库 */
  $('#btn-exit').onclick = () => {
    if (insertMode) finishInsertMode();
    commitInput();
    persistNow();
    backToLibrary();
  };

  /* ============ 设置弹窗 ============ */
  let tmpSettings = null;

  $('#btn-settings').onclick = () => {
    tmpSettings = JSON.parse(JSON.stringify(editing.settings));
    renderSettings();
    openModal('#modal-settings');
  };

  function paintAvatar(k) {
    const side = k === 'left' ? 'L' : 'R';
    const s = tmpSettings[k];
    const prev = $(`#avatar-${side}`);
    prev.innerHTML = '';
    if (s.avatar) {
      if (s.avatar.startsWith('data:')) {
        const img = document.createElement('img'); img.src = s.avatar;
        prev.appendChild(img);
      } else {
        prev.style.background = s.avatar;
        prev.textContent = '';
      }
    } else { prev.style.background = 'transparent'; prev.textContent = '头像'; }
  }

  function renderSettings() {
    ['left', 'right'].forEach(k => {
      paintAvatar(k);
      const side = k === 'left' ? 'L' : 'R';
      const s = tmpSettings[k];
      $(`#name-${side}`).value = s.name;
      $(`#color-row-${side}`).classList.add('hidden');
    });
  }

  document.querySelectorAll('.mini-btn').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.dataset.act, side = b.dataset.side, key = side === 'L' ? 'left' : 'right';
      if (act === 'gallery') {
        $(`#file-${side}`).value = ''; $(`#file-${side}`).click();
      } else if (act === 'color') {
        $(`#color-row-${side}`).classList.remove('hidden');
      } else if (act === 'color-ok') {
        const c = $(`#color-${side}`).value;
        tmpSettings[key].avatar = c;
        $(`#hex-${side}`).value = c.toUpperCase();
        paintAvatar(key);
      }
    });
  });

  ['L', 'R'].forEach(side => {
    const key = side === 'L' ? 'left' : 'right';
    $(`#file-${side}`).addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        // 压缩到 128px 以节省存储
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          const size = 128;
          c.width = size; c.height = size;
          const ctx = c.getContext('2d');
          const min = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
          tmpSettings[key].avatar = c.toDataURL('image/jpeg', 0.85);
          renderSettings();
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
    /* 色环选色后立即生效（无需再点「确定」），避免直接点保存时纯色头像丢失；
       部分安卓 WebView 原生选色器只触发 change，两种事件都监听 */
    const onColorPick = e => {
      tmpSettings[key].avatar = e.target.value;
      $(`#hex-${side}`).value = e.target.value.toUpperCase();
      paintAvatar(key);
    };
    $(`#color-${side}`).addEventListener('input', onColorPick);
    $(`#color-${side}`).addEventListener('change', onColorPick);
    /* 色号输入合法时同样立即生效并同步色环 */
    $(`#hex-${side}`).addEventListener('input', e => {
      const v = e.target.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        $(`#color-${side}`).value = v;
        tmpSettings[key].avatar = v;
        paintAvatar(key);
      }
    });
  });

  $('#btn-settings-save').onclick = () => {
    tmpSettings.left.name = $('#name-L').value;
    tmpSettings.right.name = $('#name-R').value;
    editing.settings = tmpSettings;
    // 仅在用户未手动命名时，用新人物名刷新自动标题（标题栏/桌面文件名/导出名同源）
    if (!editing.titleManual) editing.title = autoTitle(editing);
    updateSideTag();   // 人名首字立即反映到侧标签
    updateNameBar();   // 名称行同步显示
    refreshTitleField();
    persistNow();
    closeModals();
    toast('人物设置已生效');
  };

  /* ============================================================
     按键自定义弹窗 + 全屏捕获层
     ============================================================ */

  /* 自定义弹窗列表渲染：每功能行 = 名称 + 1~2 方框 + 编辑钮 */
  function renderKeymap() {
    const list = $('#keymap-list');
    list.innerHTML = '';
    KEY_FUNCS.forEach(f => {
      const custom = funcIsCustom(f.id);
      const schemes = funcSchemes(f.id);

      const row = document.createElement('div');
      row.className = 'km-row';

      const name = document.createElement('div');
      name.className = 'km-name';
      name.textContent = f.name;
      row.appendChild(name);

      const slots = document.createElement('div');
      slots.className = 'km-slots';
      schemes.forEach((sc, i) => {
        const slot = document.createElement('div');
        slot.className = 'km-slot';
        slot.textContent = schemeLabel(sc);
        slot.title = '点击重新识别此方案';
        slot.onclick = () => openCapture(f.id, i);
        if (custom) {
          const x = document.createElement('span');
          x.className = 'km-clear';
          x.textContent = '×';
          x.title = '删除此方案';
          x.onclick = ev => {
            ev.stopPropagation();
            db.keymap[f.id].splice(i, 1);
            save(); renderKeymap();
          };
          slot.appendChild(x);
        }
        slots.appendChild(slot);
      });
      // 自定义且仅 1 个方案：虚线「＋方案」框（每种最多两种）
      if (custom && schemes.length < 2) {
        const add = document.createElement('div');
        add.className = 'km-slot km-slot-empty';
        add.textContent = '＋ 方案';
        add.onclick = () => openCapture(f.id, schemes.length);
        slots.appendChild(add);
      }
      row.appendChild(slots);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'km-edit';
      edit.title = '编辑方案';
      edit.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      edit.onclick = () => {
        // 有空格位填空格位，两格皆满则替换第一格
        const n = funcIsCustom(f.id) ? funcSchemes(f.id).length : 0;
        openCapture(f.id, n >= 2 ? 0 : n);
      };
      row.appendChild(edit);

      list.appendChild(row);
    });
  }

  /* ---------- 全屏捕获层：整个屏幕为识别区，仅保存/退出可离开 ---------- */
  let capCtx = null;   // {fid, slot, buffer:[]}
  function openCapture(fid, slot) {
    capCtx = { fid, slot, buffer: [] };
    const fn = KEY_FUNCS.find(f => f.id === fid);
    $('#cap-title').textContent = '设置 · ' + (fn ? fn.name : '');
    renderCapDisplay();
    $('#modal-capture').classList.remove('hidden');
  }
  function closeCapture() {
    $('#modal-capture').classList.add('hidden');
    capCtx = null;
  }
  function renderCapDisplay() {
    const d = $('#cap-display');
    d.innerHTML = '';
    if (!capCtx.buffer.length) {
      const e0 = document.createElement('span');
      e0.className = 'cap-empty';
      e0.textContent = '等待你的操作…';
      d.appendChild(e0);
      return;
    }
    capCtx.buffer.forEach((unit, i) => {
      if (i) {
        const plus = document.createElement('span');
        plus.className = 'cap-plus';
        plus.textContent = '+';
        d.appendChild(plus);
      }
      const k = document.createElement('span');
      k.className = 'cap-kbd';
      k.textContent = keyPressLabel(unit);
      d.appendChild(k);
    });
  }
  function captureRecord(unit) {
    if (!capCtx || capCtx.buffer.length >= 2) return;  // 最多两次操作
    capCtx.buffer.push(unit);
    renderCapDisplay();
  }
  function capKeyDown(e) {
    if (!capCtx) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    // 单按修饰键不算一次操作
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    captureRecord(normKeyEvent(e));
  }
  function capPointerDown(e) {
    if (!capCtx) return;
    // 顶部保存/退出栏不参与识别
    if (e.target.closest('.cap-top')) return;
    e.preventDefault();
    captureRecord({ mods: [], key: 'ScreenTap' });
  }
  document.addEventListener('keydown', capKeyDown, true);
  $('#modal-capture').addEventListener('pointerdown', capPointerDown, true);
  $('#cap-save').addEventListener('click', e => {
    e.stopPropagation();
    if (!capCtx) return;
    if (!capCtx.buffer.length) { toast('请先进行按键或点击操作'); return; }
    const { fid, slot, buffer } = capCtx;
    const scheme = normScheme({
      keys: buffer.map(u => ({ mods: u.mods, key: u.key }))
    });
    if (!scheme) { toast('识别内容无效，请重试'); return; }
    if (!Array.isArray(db.keymap[fid])) db.keymap[fid] = [];
    db.keymap[fid][slot] = scheme;
    db.keymap[fid] = db.keymap[fid].slice(0, 2).filter(Boolean);
    closeCapture();
    save();
    if (!$('#modal-keymap').classList.contains('hidden')) renderKeymap();
    toast('方案已保存并立即生效');
  });
  $('#cap-exit').addEventListener('click', e => {
    e.stopPropagation();
    closeCapture();   // 不保存直接退出
  });

  /* 入口：账号面板「按键自定义」（会员功能，打开前先门控） */
  $('#up-keymap').addEventListener('click', () => {
    if (!requireVip()) return;
    renderKeymap();
    openModal('#modal-keymap');
  });
  $('#keymap-close').addEventListener('click', closeModals);

  /* ============================================================
     人物信息库：设置弹窗左右头像「导入方案」+ 人物库弹窗 + 单人编辑
     ============================================================ */
  const PEOPLE_MAX = 10;

  /* 「导入」钮位于标题行右侧（静态结构 #import-L / #import-R） */
  ['L', 'R'].forEach(side => {
    $(`#import-${side}`).addEventListener('click', () => openProfiles(side));
  });

  /* ---------- 人物库弹窗：逐行预览（头像 + 名称） ---------- */
  let profileTargetSide = 'L';
  function openProfiles(side) {
    profileTargetSide = side;
    renderProfiles();
    openModal('#modal-profiles');
  }
  function renderProfiles() {
    const list = $('#pf-list');
    list.innerHTML = '';
    if (!db.people.length) {
      const e0 = document.createElement('div');
      e0.className = 'pf-empty';
      e0.textContent = '暂无保存人物，点右上角 ＋ 新建';
      list.appendChild(e0);
      return;
    }
    db.people.forEach(p => {
      const row = document.createElement('div');
      row.className = 'pf-row';

      const av = document.createElement('div');
      av.className = 'pf-avatar';
      if (p.avatar && p.avatar.startsWith('data:')) {
        const im = document.createElement('img');
        im.src = p.avatar;
        av.appendChild(im);
      } else {
        av.style.background = p.avatar || '#9aa1b0';
        av.textContent = (p.name || '?').slice(0, 1);
      }
      row.appendChild(av);

      const nm = document.createElement('div');
      nm.className = 'pf-name';
      nm.textContent = p.name || '未命名';
      row.appendChild(nm);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pf-del';
      del.textContent = '×';
      del.title = '删除';
      del.onclick = e => {
        e.stopPropagation();
        db.people = db.people.filter(x => x.id !== p.id);
        save();
        renderProfiles();
      };
      row.appendChild(del);

      row.onclick = () => importPerson(p);
      list.appendChild(row);
    });
  }
  /* 点某行：导入到打开来源那一侧 */
  function importPerson(p) {
    const key = profileTargetSide === 'L' ? 'left' : 'right';
    tmpSettings[key] = { name: p.name, avatar: p.avatar || '' };
    closeModals();
    renderSettings();
    openModal('#modal-settings');
    toast('已导入到' + (profileTargetSide === 'L' ? '左' : '右') + '侧');
  }

  /* ＋：第 4 条起需会员；总数上限 10 */
  $('#pf-add').addEventListener('click', () => {
    if (db.people.length >= PEOPLE_MAX) { toast('最多保存 10 个人物信息'); return; }
    if (db.people.length >= 3 && !requireVip()) return;
    openPersonModal(null);
  });
  $('#pf-x').addEventListener('click', closeModals);

  /* ---------- 单个人物信息编辑弹窗（与人物设置栏同 UI，一次只设一人） ---------- */
  let personTmp = null;
  function openPersonModal(p) {
    personTmp = p
      ? JSON.parse(JSON.stringify(p))
      : { id: uid(), name: '', avatar: '' };
    $('#pm-title').textContent = p ? '编辑人物信息' : '新建人物信息';
    $('#name-P').value = personTmp.name;
    $('#color-row-P').classList.add('hidden');
    paintPersonAvatar();
    openModal('#modal-person');
  }
  function paintPersonAvatar() {
    const el = $('#avatar-P');
    el.innerHTML = '';
    el.style.background = 'transparent';
    const a = personTmp.avatar;
    if (a && a.startsWith('data:')) {
      const im = document.createElement('img');
      im.src = a;
      el.appendChild(im);
    } else if (a) {
      el.style.background = a;
    } else {
      el.textContent = '头像';
    }
  }
  document.querySelectorAll('#modal-person .mini-btn').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.dataset.pact;
      if (act === 'gallery') {
        $('#file-P').value = '';
        $('#file-P').click();
      } else if (act === 'color') {
        $('#color-row-P').classList.remove('hidden');
      } else if (act === 'color-ok') {
        const c = $('#color-P').value;
        personTmp.avatar = c;
        $('#hex-P').value = c.toUpperCase();
        paintPersonAvatar();
      }
    });
  });
  $('#file-P').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const size = 128;
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        const min = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
        personTmp.avatar = c.toDataURL('image/jpeg', 0.85);
        paintPersonAvatar();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  const onPColor = e => {
    personTmp.avatar = e.target.value;
    $('#hex-P').value = e.target.value.toUpperCase();
    paintPersonAvatar();
  };
  $('#color-P').addEventListener('input', onPColor);
  $('#color-P').addEventListener('change', onPColor);
  $('#hex-P').addEventListener('input', e => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      $('#color-P').value = v;
      personTmp.avatar = v;
      paintPersonAvatar();
    }
  });
  $('#pm-save').addEventListener('click', () => {
    personTmp.name = $('#name-P').value.trim();
    if (!personTmp.name) { toast('请填写名称'); return; }
    const i = db.people.findIndex(x => x.id === personTmp.id);
    if (i >= 0) db.people[i] = personTmp;
    else {
      if (db.people.length >= PEOPLE_MAX) { toast('最多保存 10 个人物信息'); return; }
      db.people.push(personTmp);
    }
    closeModals();
    save();
    renderProfiles();
    openModal('#modal-profiles');
    toast('人物信息已保存');
  });
  $('#pm-x').addEventListener('click', closeModals);

  /* ============ 导出 ============ */
  $('#btn-export').onclick = () => openModal('#modal-export');
  const FMT_META = {
    img:  { label: '长图', ext: 'png', mime: 'image/png' },
    word: { label: 'Word', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  };
  const sanitizeName = n => String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || '未命名对话';
  document.querySelectorAll('.export-btn').forEach(b => {
    b.onclick = () => {
      const fmt = b.dataset.fmt;
      // Word 为会员功能，进入前先门控
      if (fmt === 'word' && !requireVip()) return;
      commitInput();
      const doc = JSON.parse(JSON.stringify(editing));
      doc.title = resolveTitle(doc);
      // 长图与原 TXT 同口径：允许空内容导出（仅标题+双方信息）
      if (!doc.lines.length && fmt !== 'img') { toast('暂无内容可导出'); return; }
      if (fmt === 'pdf') {
        // App：保留导出选择框——系统打印框左滑返回时正好回到此框；浏览器沿用原流程
        if (IS_APP) WTExport.exportPDF(doc);
        else { closeModals(); WTExport.exportPDF(doc); }
        return;
      }

      // img / word：App 内先确认文件名，再由系统文件选择器（SAF）指定保存位置；
      // 浏览器环境沿用原下载流程
      if (!IS_APP) {
        closeModals();
        if (fmt === 'img') {
          WTExport.buildImageBlob(doc)
            .then(blob => WTExport.downloadBlob(blob, sanitizeName(doc.title) + '.png'))
            .catch(() => toast('导出失败，请重试'));
        } else {
          WTExport.exportWord(doc);
        }
        return;
      }
      const meta = FMT_META[fmt];
      $('#savefile-title').textContent = '导出 ' + meta.label;
      $('#savefile-name').value = sanitizeName(doc.title) + '.' + meta.ext;
      openModal('#modal-savefile');
      setTimeout(() => { const inp = $('#savefile-name'); inp.focus(); inp.select(); }, 50);
      $('#savefile-cancel').onclick = closeModals;
      $('#savefile-ok').onclick = () => {
        const rawName = $('#savefile-name').value.trim();
        if (!rawName) return toast('文件名不能为空');
        const name = /\.[a-z0-9]+$/i.test(rawName) ? rawName : rawName + '.' + meta.ext;
        closeModals();
        const job = fmt === 'img'
          ? WTExport.buildImageBlob(doc)
          : WTExport.buildWordBlob(doc);
        job.then(blob => {
          const reader = new FileReader();
          reader.onload = () => {
            if (window.WTNative && WTNative.saveFileWithPicker) {
              WTNative.saveFileWithPicker(name, meta.mime, reader.result);
            } else {
              WTExport.downloadBlob(blob, name);
            }
          };
          reader.readAsDataURL(blob);
        }).catch(() => toast('导出失败，请重试'));
      };
    };
  });

  /* ============ 主题按钮 ============ */
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-theme-ed').onclick = toggleTheme;

  /* ============ 首次使用：种子说明文档 ============ */
  const GUIDE_KEY = IS_APP ? 'wetalk_guide_seeded_app_v7' : 'wetalk_guide_seeded_v7';
  const GUIDE_TITLES = [
    '欢迎使用 WeTalk · 使用说明',
    '欢迎使用WeTalk·网页使用说明',
    '欢迎使用WeTalk·App使用说明'
  ];
  const guideTitle = IS_APP
    ? '欢迎使用WeTalk·App使用说明'
    : '欢迎使用WeTalk·网页使用说明';
  function seedGuide() {
    // 旧版标题 / 另一端标题的说明：每次启动都移除
    const staleTitles = GUIDE_TITLES.filter(t => t !== guideTitle);
    const n0 = db.docs.length;
    db.docs = db.docs.filter(d => !staleTitles.includes(d.title));
    if (db.docs.length !== n0) save();
    if (localStorage.getItem(GUIDE_KEY)) return;
    // 新版本种子：同标题的旧内容也一并替换
    const n1 = db.docs.length;
    db.docs = db.docs.filter(d => d.title !== guideTitle);
    if (db.docs.length !== n1) save();
    /* ---- 说明文档（图文版）：网页端用 w-*.jpg 截图，手机端用 m-*.jpg 截图 ---- */
    const guideShot = (file, caption) =>
      '<img src="images/guide/' + file + '" alt="' + caption + '" '
      + 'style="max-width:100%;height:auto;border-radius:10px;display:block">'
      + '<div style="font-size:12px;opacity:.72;margin-top:6px">' + caption + '</div>';
    const wtWelcome =
      '<b>欢迎使用 WeTalk</b><br>这是一个专注「快速记录对话」的小工具：没有复杂的排版功能，打开就能记，记完即可导出。这份说明会带你快速上手，读完后可以随时删除它。';
    const wtScenes =
      '适用于这些场景：<b>会议纪要、访谈记录、电话沟通备忘、线上聊天整理</b>等。凡是两个人之间的对话，都可以用左右两栏快速记录下来，并导出为规整的文档。';

    /* ========== 网页端说明 ========== */
    const webItems = [
      wtWelcome,
      wtScenes,
      '<b>一、你的文档库</b><br>文档库是软件的主界面，所有文稿与文件夹都在这里统一管理：列表显示名称与创建时间；点文件夹进入下一级，点文稿直接打开编辑；底部显示文稿与文件夹的总数。',
      guideShot('w-01.jpg', '图 1：文档库主界面（网页端）'),
      '<b>二、新建文稿与文件夹</b><br>点击右下角圆形「＋」按钮即可新建。新建文稿时，需要先在弹窗中选择保存位置（「桌面」或某个文件夹），确认后会直接进入编辑界面；新建文件夹只需输入名称。同级同类项目不允许重名。',
      guideShot('w-02.jpg', '图 2：进入文件夹后，面包屑显示当前路径'),
      '<b>三、搜索与排序</b><br>顶部搜索框输入关键字，列表会实时按名称筛选；点击面包屑右侧的排序按钮，可在「新→旧」与「旧→新」之间切换，排序偏好会被自动记住。',
      guideShot('w-03.jpg', '图 3：输入关键字后实时筛选结果'),
      '<b>四、编写界面 · 左右分栏</b><br>对话按左右两栏记录，并按「全局行号」对齐：同一侧连续发言时气泡依次下移，换到另一侧时，新气泡对齐到对侧同一水平线，两边内容永远不会串栏。',
      guideShot('w-04.jpg', '图 4：左右分栏的编辑界面（网页端）'),
      '<b>五、网页端如何发送（重点，请留意）</b><br>· 按 <b>回车</b>：发送到当前选中的角色（默认右侧）<br>· 按 <b>Ctrl + 回车</b>：只在输入框内换行<br>· 用鼠标点击两侧圆圈，或按 <b>Shift + ← / →</b>：切换当前角色，选中侧圆圈会放大加框<br>· <b>按住 ← 或 → 再按回车</b>：本次内容直发对应侧，但不改变当前角色',
      '<b>六、修改气泡与补全遗漏</b><br>· 单击任意已发送气泡即可直接修改文字；点击气泡之外的任意位置保存并退出；若把文字全部删空后退出，该气泡所在行会整体删除，后续行自动补位<br>· 单击两条气泡之间的缝隙，进入「补全模式」：在白色圆框处发送内容即可插入漏掉的对话，可连续补多条，完成后点击右下角「✓」（一条都没发则取消补全）。',
      '<b>七、加粗与下划线</b><br>点击顶部「字体编辑」图标展开 B / U 工具条：先选中输入框或已发送气泡中的文字，再点击对应按钮即可；也可以直接使用快捷键 <b>Ctrl + B</b>、<b>Ctrl + U</b>。',
      '<b>八、设置两个人的头像与名字</b><br>点击左上角人型图标：头像可以从本地图库选择（自动裁剪压缩为 128 像素），也可以使用纯色（色环点选或输入色号）；名字设置后，输入框两侧圆圈显示名字首字，对话区上方也会显示双方名字。',
      guideShot('w-05.jpg', '图 5：角色设置窗口（头像与名字）'),
      '<b>九、自动命名与自动保存</b><br>未手动命名时，文稿自动命名为「左边名字和右边名字的对话」，同名时自动追加数字区分；编辑过程中停止输入 400 毫秒后内容自动保存，无需任何手动操作。',
      '<b>十、导出 PDF / Word / TXT</b><br>点击右上角导出按钮：<b>PDF</b> 通过系统打印窗口选择「另存为 PDF」；<b>Word</b> 为双栏表格排版，包含头像并保留加粗、下划线格式；<b>TXT</b> 首行标注双方名字，内容依次排列。',
      guideShot('w-06.jpg', '图 6：导出文档窗口'),
      '<b>十一、账号与云端同步</b><br>使用邮箱注册并登录后，所有文稿与设置会自动同步到云端，同一账号在网页或 App 登录即可获得全部记录。同步采用三方比对，仅在双方修改确实冲突时才弹窗让你选择，其余情况自动完成。',
      guideShot('w-07.jpg', '图 7：首次打开时的登录窗口'),
      guideShot('w-08.jpg', '图 8：点击左上角 WeTalk 可查看账号与同步状态'),
      '<b>十二、日间 / 夜间主题</b><br>点击右上角月亮图标切换日间与夜间主题，选择会被自动记住。',
      guideShot('w-09.jpg', '图 9：夜间主题下的编辑界面'),
      '准备好了，就点击右下角「＋」开始第一段对话吧。之后忘记任何操作，都可以回到本文档查看。'
    ];

    /* ========== 手机端说明 ========== */
    const appItems = [
      wtWelcome,
      wtScenes,
      '<b>一、你的文档库</b><br>文档库是 App 的主界面，所有文稿与文件夹都在这里管理：列表显示名称与创建时间；点文件夹进入，点文稿打开；底部显示总数。',
      guideShot('m-01.jpg', '图 1：文档库主界面（手机端）'),
      '<b>二、新建文稿与文件夹</b><br>点击右下角圆形「＋」：可选择新建文稿或新建文件夹。新建文稿会先让你选择保存位置，确认后直接进入编辑；新建文件夹输入名称即可。',
      guideShot('m-02.jpg', '图 2：点击 ＋ 后的新建菜单'),
      guideShot('m-03.jpg', '图 3：新建文稿时先选择保存位置'),
      '<b>每条记录右侧的「三个点」</b>，可以对该条执行：重命名、移动、删除。删除文件夹会连同其中的内容一起删除，操作前请确认。',
      guideShot('m-04.jpg', '图 4：行操作菜单'),
      '<b>三、搜索与排序</b><br>顶部搜索框输入关键字即可实时筛选；面包屑右侧的排序按钮用于按创建时间切换新→旧 / 旧→新。',
      guideShot('m-05.jpg', '图 5：按关键字实时筛选'),
      '点击右上角的栏位图标，可展开「快速访问」目录树：单击文件夹展开或折叠，双击文稿直接打开。',
      guideShot('m-06.jpg', '图 6：快速访问导航栏'),
      '<b>四、编写界面 · 左右分栏</b><br>对话按左右两栏、按全局行号对齐：同侧连发依次下移，换侧对齐到同一水平线。手机端较长的气泡可以跨过中间分隔线显示，但始终停留在自己的行内，不会盖住对侧气泡。',
      guideShot('m-07.jpg', '图 7：左右分栏编辑界面（手机端）'),
      '<b>五、手机端如何发送（重点，与电脑端不同）</b><br>· 输入内容后，<b>点左侧圆圈发送到左栏，点右侧圆圈发送到右栏</b><br>· 按回车<b>只在框内换行，不会发送</b><br>· 什么都没输入时点圆圈不会发送，输入了空格则照常发送<br>· 最近一次发送的一侧，圆圈会放大加框提示',
      '<b>六、修改气泡与补全遗漏</b><br>· 单击已发送气泡直接修改，点气泡之外任意位置保存退出；文字删空后退出则删除该行，后续自动补位<br>· 单击两条气泡之间的缝隙进入「补全模式」，在白色圆框处点圆圈发送即可插入遗漏内容，可连续补多条，点右下角「✓」完成。',
      '<b>七、加粗与下划线</b><br>点击顶部「字体编辑」图标展开 B / U 工具条：先选中要处理的文字，再点击对应按钮。',
      '<b>八、设置两个人的头像与名字</b><br>点击左上角人型图标：头像可从手机图库选择，也可以使用纯色（色环或色号）；设置名字后，输入框两侧圆圈显示名字首字，对话区上方显示双方名字。',
      guideShot('m-08.jpg', '图 8：角色设置窗口（手机端）'),
      '<b>九、自动命名与自动保存</b><br>未手动命名时自动生成「XX和XX的对话」标题，同名自动追加数字；编辑内容自动保存，无需任何手动操作。',
      '<b>十、导出 PDF / Word / TXT</b><br>· 导出 <b>TXT / Word</b>：先确认文件名，系统文件选择器会打开，由你指定保存位置<br>· 导出 <b>PDF</b>：直接调起系统打印，在打印窗口选择「另存为 PDF」<br>Word 为双栏排版、含头像并保留格式；TXT 首行标注双方名字。',
      '<b>十一、账号与云端同步</b><br>使用邮箱注册登录后，文稿会自动云端同步，同一账号在手机 App 和网页上登录即可看到全部记录。同步仅在真正冲突时弹窗提示。',
      guideShot('m-09.jpg', '图 9：登录窗口'),
      guideShot('m-10.jpg', '图 10：账号信息与同步状态'),
      '<b>十二、日间 / 夜间主题</b><br>点击右上角月亮图标切换主题，选择会被自动记住。',
      guideShot('m-11.jpg', '图 11：夜间主题编辑界面'),
      '<b>十三、双指缩放字号</b><br>在对话区双指张合，可以放大或缩小气泡字号（0.85～1.6 倍），字号会被记住；该设置只影响本机显示，不影响导出效果。',
      '<b>十四、返回手势说明</b><br>· 有弹窗时：返回手势先关闭弹窗<br>· 编辑页内：返回手势不会退出页面，第一次会提示你点击左上角箭头（内容会自动保存）<br>· 文件夹中：返回上一级<br>· 桌面：在 2 秒内连续返回两次，退出 App',
      '介绍完了。点击右下角「＋」，开始记录你的第一段对话吧！'
    ];
    const items = IS_APP ? appItems : webItems;
    const doc = {
      id: uid(),
      folderId: null,
      title: guideTitle,
      titleManual: true,
      createdAt: Date.now(),
      settings: defaultSettings(),
      // 左右两栏平均排布：奇数序号在左、偶数在右，读起来两侧均衡
      lines: items.map((html, i) => { const l = { side: i % 2 === 0 ? 'L' : 'R', html }; l.row = i + 1; return l; }),
      rowSeq: items.length,
      savedOnce: true
    };
    db.docs.push(doc);
    save();
    localStorage.setItem(GUIDE_KEY, '1');
  }
  /* ============ 云同步（Supabase · 邮箱账号 · 整库 jsonb · 基线式三方同步） ============
     未登录：启动即弹出不可关闭的登录门；登录后整库 db 以 jsonb 存入表 sync_data
     （每个用户一行，RLS 隔离）。保存后 1.5s 自动上传，启动自动检查云端更新。
     靠「基线（上次同步时的数据快照）」做三方比对，仅在真正冲突时才弹窗。 */
  const SUPA_URL = 'https://fdmahwltwoypecyjpmfb.supabase.co';
  const SUPA_ANON = 'sb_publishable_dAFSkJ5BungbrDlG7BqxrA_YqZtPIDq';
  const SUPA_TABLE = 'sync_data';
  const BASELINE_KEY = 'wetalk_baseline_v1';

  let supa = null;
  let supaUser = null;
  let supaSyncing = false;
  let supaDirty = false;
  let supaPushTimer = null;
  let pickPromise = null;          // 全局唯一冲突弹窗，防止多处同步逻辑重复弹窗
  let cloudPickHandled = false;    // 本次打开 App/网站已处理过：后续冲突静默解决不再弹
  let authMode = 'login';

  function supaReady() { return !!(window.supabase && SUPA_URL); }

  function initSupa() {
    if (!supaReady()) return;
    // 所有请求统一 12s 超时：弱网下 fetch 可能无限挂起（注册后表现为一直同步）
    const nativeFetch = window.fetch.bind(window);
    function timedFetch(url, opts) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => ctl.abort());
      return nativeFetch(url, Object.assign({}, opts, { signal: ctl.signal }))
        .finally(() => clearTimeout(timer));
    }
    supa = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: timedFetch }
    });
    supa.auth.onAuthStateChange((event, session) => {
      supaUser = session ? session.user : null;
      renderUserPanel();
      loadMembership();   // 登录/登出/刷新时同步会员状态（函数声明，下方会员模块定义）
    });
  }

  /* ---- 基线：上一次与云端达成一致时本机数据的序列化字符串 ---- */
  function getBaseline() { return localStorage.getItem(BASELINE_KEY); }
  function setBaseline(s) { try { localStorage.setItem(BASELINE_KEY, s); } catch (e) {} }

  /* ---- 表读写（RLS 保证每用户仅自己那行） ---- */
  async function supaGetRow() {
    const { data, error } = await supa.from(SUPA_TABLE).select('payload').maybeSingle();
    if (error) throw { error: error.message };
    return data ? data.payload : null; // jsonb 直接是对象
  }
  async function supaPutRow(payload) {
    const { error } = await supa.from(SUPA_TABLE).upsert(
      { user_id: supaUser.id, payload, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    if (error) throw { error: error.message };
  }

  function applySupaPayload(obj) {
    db = obj;
    const s = JSON.stringify(db);
    localStorage.setItem(DB_KEY, s);
    setBaseline(s);
    applyTheme(); renderLibrary();
  }

  function supaErrText(e) {
    const m = e.error || '';
    if (/could not find the table|sync_data|schema cache/i.test(m))
      return '云端数据表尚未创建：请在 Supabase 的 SQL Editor 执行建表语句后再同步';
    if (/JWT|expired/i.test(m)) return '登录已过期，请重新登录';
    return m || '同步失败，请稍后重试';
  }

  /* ---- 唯一的冲突选择弹窗，返回 'cloud' 或 'local'；并发调用复用同一个 ---- */
  function cloudPickPromise() {
    // 本次启动用户已做过选择：后续任何冲突都静默保留本机内容，不再弹窗
    if (cloudPickHandled) return Promise.resolve('local');
    if (pickPromise) return pickPromise;
    pickPromise = new Promise(resolve => {
      $('#cloudpick-text').innerHTML =
        '云端已有一份数据。<br>恢复云端数据，将覆盖本机内容；<br>保留本机内容，将覆盖云端版本。';
      openModal('#modal-cloudpick');
      $('#cloudpick-cloud').onclick = () => { finish('cloud'); };
      $('#cloudpick-local').onclick = () => { finish('local'); };
      function finish(v) {
        closeModals();
        cloudPickHandled = true;   // 标记本次启动已处理
        const p = pickPromise; pickPromise = null;
        resolve(v);
      }
    });
    return pickPromise;
  }

  /* ---- 语义化深比较：云端 jsonb 往返后即使字节串不同，只要内容相同即视为一致 ---- */
  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    const arrA = Array.isArray(a), arrB = Array.isArray(b);
    if (arrA !== arrB) return false;
    if (arrA) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  /* ---- 三方比对（本机 / 基线 / 云端）：
     'uploaded' 已上传 · 'downloaded' 已恢复云端 · 'same' 完全一致 ---- */
  async function reconcile() {
    const local = JSON.stringify(db);
    const localObj = JSON.parse(local);   // 固定快照：上传内容与基线字符串保证完全一致
    const base = getBaseline();
    let baseObj = null;
    if (base) { try { baseObj = JSON.parse(base); } catch (e) { baseObj = null; } }
    const remoteObj = await supaGetRow();

    if (remoteObj === null) {                       // 云端空：上传本机快照
      await supaPutRow(localObj); setBaseline(local);
      return 'uploaded';
    }
    if (deepEqual(remoteObj, localObj)) { setBaseline(local); return 'same'; }

    const localEmpty = db.docs.length === 0 && db.folders.length === 0;
    if (baseObj === null) {                         // 本设备从未建立基线
      if (localEmpty) { applySupaPayload(remoteObj); return 'downloaded'; }
      const c = await cloudPickPromise();
      if (c === 'cloud') { applySupaPayload(remoteObj); return 'downloaded'; }
      await supaPutRow(localObj); setBaseline(local); return 'uploaded';
    }
    if (deepEqual(localObj, baseObj)) { applySupaPayload(remoteObj); return 'downloaded'; } // 本机无改动：静默拉取
    if (deepEqual(remoteObj, baseObj)) { await supaPutRow(localObj); setBaseline(local); return 'uploaded'; } // 云端无改动：静默推送
    // 双方都偏离基线：真正的冲突才询问
    const c = await cloudPickPromise();
    if (c === 'cloud') { applySupaPayload(remoteObj); return 'downloaded'; }
    await supaPutRow(localObj); setBaseline(local); return 'uploaded';
  }

  /* ---- 本地保存后自动安排上传（1.5s 合并连续编辑） ---- */
  function scheduleSupaPush() {
    if (!supaUser) return;
    supaDirty = true;
    clearTimeout(supaPushTimer);
    supaPushTimer = setTimeout(() => { supaPush(true); }, 1500);
  }

  async function supaPush(auto) {
    if (!supaUser) return;
    if (supaSyncing) { supaDirty = true; return; }
    supaSyncing = true; renderUserPanel();
    try {
      const r = await reconcile();
      supaDirty = false;
      if (auto) {
        if (r === 'downloaded') toast('云端有更新，已自动恢复');
      } else if (r === 'same') toast('已是最新');
      else if (r === 'uploaded') toast('已同步到云端');
      else toast('已恢复云端数据');
    } catch (e) {
      supaDirty = true; // 失败保留改动，下次保存/手动同步重试
      if (!auto) toast(supaErrText(e));
      // 自动同步失败（超时/断网）：3s 后静默重试，直到成功
      if (auto && !/JWT|expired/i.test(e.error || '')) {
        setTimeout(() => { if (supaUser) supaPush(true); }, 3000);
      }
      if (/JWT|expired/i.test(e.error || '')) {
        try { supa.auth.signOut(); } catch (se) {}
        supaUser = null;
        openAuthGate();
      }
    } finally {
      supaSyncing = false; renderUserPanel();
    }
  }

  /* ============ 滑块拼图验证（登录 / 注册前置门槛） ============ */
  const SC = (() => {
    const BW = 300, BH = 150;          // 背景内部分辨率
    const P = 42, R = 9;               // 拼图边长、凸包半径
    const X0 = 6;                      // 拼图起始 x
    const TOL = 5;                     // 对齐容差（内部像素）
    const box = $('#slider-captcha'), puzzle = $('#sc-puzzle'), track = $('#sc-track');
    const bg = $('#sc-bg'), piece = $('#sc-piece'), fillEl = $('#sc-fill');
    const sbtn = $('#sc-btn'), tip = $('#sc-text');
    piece.width = P + 2 * R; piece.height = P + 2 * R;

    let gx = 0, gy = 0;                // 缺口位置
    let verified = false;
    let dragging = false, downX = 0, downLeft = 0, maxDx = 0, cssScale = 1;
    let failCount = 0;

    /* 拼图外形：右侧、下侧各一个向外凸包 */
    function piecePath(c, x, y) {
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + P, y);
      c.lineTo(x + P, y + P * .32);
      c.arc(x + P, y + P * .5, R, -Math.PI / 2, Math.PI / 2);
      c.lineTo(x + P, y + P);
      c.lineTo(x + P * .68, y + P);
      c.arc(x + P * .5, y + P, R, 0, Math.PI);
      c.lineTo(x, y + P);
      c.closePath();
    }

    /* 程序化生成背景：随机渐变 + 几何碎片 + 线条，无需外部图片 */
    function makeScene() {
      const c = document.createElement('canvas');
      c.width = BW; c.height = BH;
      const x = c.getContext('2d');
      const h = Math.floor(Math.random() * 360);
      const g = x.createLinearGradient(0, 0, BW, BH);
      g.addColorStop(0, `hsl(${h},52%,60%)`);
      g.addColorStop(1, `hsl(${(h + 45) % 360},46%,40%)`);
      x.fillStyle = g; x.fillRect(0, 0, BW, BH);
      for (let i = 0; i < 20; i++) {
        const hh = (h + Math.random() * 90 - 30 + 360) % 360;
        x.fillStyle = `hsla(${hh},55%,${35 + Math.random() * 40}%,${.18 + Math.random() * .4})`;
        x.beginPath();
        x.arc(Math.random() * BW, Math.random() * BH, 8 + Math.random() * 26, 0, Math.PI * 2);
        x.fill();
      }
      x.strokeStyle = 'rgba(255,255,255,.22)'; x.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        x.beginPath();
        x.moveTo(Math.random() * BW, Math.random() * BH);
        x.lineTo(Math.random() * BW, Math.random() * BH);
        x.stroke();
      }
      return c;
    }

    /* 生成新挑战 */
    function build() {
      const scene = makeScene();
      gx = Math.round(BW * .42 + Math.random() * (BW * .5 - P - 6));
      gy = Math.round(8 + Math.random() * (BH - P - 2 * R - 16));
      const bc = bg.getContext('2d');
      bc.clearRect(0, 0, BW, BH);
      bc.drawImage(scene, 0, 0);
      piecePath(bc, gx, gy);
      bc.fillStyle = 'rgba(10,12,18,.5)'; bc.fill();
      bc.strokeStyle = 'rgba(255,255,255,.85)'; bc.lineWidth = 1; bc.stroke();
      const pc = piece.getContext('2d');
      pc.clearRect(0, 0, piece.width, piece.height);
      pc.save();
      pc.translate(R - gx, R - gy);
      piecePath(pc, gx, gy); pc.clip();
      pc.drawImage(scene, 0, 0);
      piecePath(pc, gx, gy);
      pc.strokeStyle = 'rgba(255,255,255,.85)'; pc.lineWidth = 1; pc.stroke();
      pc.restore();
    }

    /* 按内部 x 放置拼图块（考虑浮层 CSS 缩放） */
    function placeAt(cx) {
      piece.style.left = (cx - R) * cssScale + 'px';
      piece.style.top = (gy - R) * cssScale + 'px';
      piece.style.width = piece.width * cssScale + 'px';
      piece.style.height = piece.height * cssScale + 'px';
    }

    function showPuzzle() {
      puzzle.classList.add('show');
      track.classList.add('dragging');
      cssScale = puzzle.clientWidth / BW;
      maxDx = track.clientWidth - sbtn.offsetWidth;
      placeAt(X0);
    }

    function pass(hl) {
      verified = true;
      box.classList.add('verified');
      tip.textContent = '验证通过';
      sbtn.style.left = hl + 'px';
      fillEl.style.width = hl + sbtn.offsetWidth + 'px';
      setTimeout(() => puzzle.classList.remove('show'), 350);
      $('#auth-submit').disabled = false;
    }

    function fail(hl) {
      failCount++;
      sbtn.style.transition = 'left .25s ease';
      fillEl.style.transition = 'width .25s ease';
      piece.style.transition = 'left .25s ease';
      sbtn.style.left = '0';
      fillEl.style.width = '0';
      placeAt(X0);
      setTimeout(() => {
        sbtn.style.transition = ''; fillEl.style.transition = ''; piece.style.transition = '';
        if (failCount >= 2) { failCount = 0; build(); }
        puzzle.classList.remove('show');
        track.classList.remove('dragging');
      }, 270);
    }

    sbtn.addEventListener('pointerdown', e => {
      if (verified) return;
      e.preventDefault();
      dragging = true;
      try { sbtn.setPointerCapture(e.pointerId); } catch (_) {}
      downX = e.clientX;
      downLeft = parseFloat(sbtn.style.left) || 0;
      showPuzzle();
    });
    sbtn.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - downX;
      const hl = Math.max(0, Math.min(maxDx, downLeft + dx));
      sbtn.style.left = hl + 'px';
      fillEl.style.width = hl + sbtn.offsetWidth + 'px';
      const cx = X0 + (hl / maxDx) * (BW - P - X0);
      placeAt(cx);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('dragging');
      const hl = parseFloat(sbtn.style.left) || 0;
      const cx = X0 + (hl / maxDx) * (BW - P - X0);
      if (Math.abs(cx - gx) <= TOL) pass(hl); else fail(hl);
    }
    sbtn.addEventListener('pointerup', endDrag);
    sbtn.addEventListener('pointercancel', endDrag);

    /* 重置（切换标签 / 登录失败 / 成功后关闭） */
    function reset() {
      verified = false; failCount = 0;
      box.classList.remove('verified');
      tip.textContent = '按住滑块，拖动完成拼图';
      sbtn.style.transition = 'none'; fillEl.style.transition = 'none'; piece.style.transition = 'none';
      sbtn.style.left = '0'; fillEl.style.width = '0';
      puzzle.classList.remove('show'); track.classList.remove('dragging');
      build();
      $('#auth-submit').disabled = true;
    }

    build();
    return { reset, isVerified: () => verified };
  })();

  /* ============ 强制登录门 ============ */
  function openAuthGate() {
    authMode = 'login';
    document.querySelectorAll('.auth-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.auth === 'login'));
    $('#auth-submit').textContent = '登录';
    $('#auth-note-pw').classList.add('hidden');
    $('#auth-pw2-wrap').classList.add('hidden');
    $('#auth-email').value = '';
    $('#auth-password').value = '';
    $('#auth-password2').value = '';
    $('#auth-error').textContent = '';
    document.querySelectorAll('.pw-eye').forEach(resetOneEye);
    SC.reset();
    openModal('#modal-auth');
  }

  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.auth;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
      $('#auth-pw2-wrap').classList.toggle('hidden', authMode === 'login');
      $('#auth-submit').textContent = authMode === 'login' ? '登录' : '注册并同步';
      $('#auth-note-pw').classList.toggle('hidden', authMode === 'login');
      $('#auth-error').textContent = '';
      SC.reset();
    });
  });

  function closeAuthSuccess() {
    closeUserPanel();
    $('#modal-auth').classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) {
      $('#modal-mask').classList.add('hidden');
    }
    renderUserPanel();
    SC.reset();
  }

  $('#auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const pwd = $('#auth-password').value;
    const err = $('#auth-error');
    err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = '请输入正确的邮箱地址'; return; }
    if (pwd.length < 6) { err.textContent = '密码至少 6 位'; return; }
    if (!SC.isVerified()) { err.textContent = '请先完成滑块验证'; return; }
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      if (!supa) throw { error: '云端连接初始化失败，请检查网络后刷新页面' };
      if (authMode === 'signup') {
        if ($('#auth-password2').value !== pwd) throw { error: '两次输入的密码不一致' };
        const { data, error } = await supa.auth.signUp({ email, password: pwd });
        if (error) throw { error: error.message };
        if (data.session) {
          supaUser = data.session.user;
          closeAuthSuccess();
          toast('登录成功，数据正在自动同步');
          supaPush(true);   // 后台首同步：超时也不阻塞进入，失败自动重试
        } else {
          // 项目开启了邮箱验证：无会话返回
          err.textContent = '注册成功，请查收邮件并点击验证链接后再登录';
        }
      } else {
        const { error } = await supa.auth.signInWithPassword({ email, password: pwd });
        if (error) throw { error: error.message };
        const { data } = await supa.auth.getSession();
        supaUser = data.session ? data.session.user : null;
        closeAuthSuccess();
        toast('登录成功');
        supaPush(true);   // 后台同步云端数据，不阻塞进入
      }
    } catch (ex) {
      err.textContent = ex.error || '操作失败，请重试';
      SC.reset();   // 登录 / 注册失败：滑块作废，需重新验证
    } finally {
      btn.disabled = !SC.isVerified();
    }
  });

  /* ---- 密码眼睛：查看 / 隐藏 ---- */
  function resetOneEye(b) {
    const inp = document.getElementById(b.dataset.target);
    if (inp) inp.type = 'password';
    b.classList.remove('is-hidden-pw');
  }
  document.querySelectorAll('.pw-eye').forEach(b => {
    b.addEventListener('click', () => {
      const inp = document.getElementById(b.dataset.target);
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.classList.toggle('is-hidden-pw', !show);
      b.setAttribute('aria-label', show ? '隐藏密码' : '查看密码');
    });
  });

  /* ============================================================
     会员模块（激活码 / 四档时长 / 到期自动失效）
     · 档位：day 一日体验 · month 月度 · quarter 季度 · year 年度
     · 激活通过 RPC redeem_activation_code 完成（码表仅服务端可访问）
     · 有效期在当前会员基础上顺延，expires_at 为唯一过期判定
     · 门控点：导出 Word / 按键自定义 / 人物信息库第 4~10 条
     ============================================================ */
  const VIP_PLANS = {
    day: '一日体验', month: '月度会员', quarter: '季度会员', year: '年度会员'
  };
  let isVip = false;
  let vipExpiresAt = null;
  let vipPlan = null;

  async function loadMembership() {
    if (!supa || !supaUser) {
      isVip = false; vipExpiresAt = null; vipPlan = null;
      renderVipState();
      return;
    }
    try {
      const { data, error } = await supa
        .from('memberships')
        .select('is_vip, plan, expires_at')
        .eq('user_id', supaUser.id)
        .maybeSingle();
      if (error) return;   // 弱网等失败保持静默，不打扰使用
      vipPlan = data ? data.plan : null;
      vipExpiresAt = data && data.expires_at ? new Date(data.expires_at) : null;
      isVip = !!(data && data.is_vip && vipExpiresAt && vipExpiresAt.getTime() > Date.now());
    } finally {
      renderVipState();
    }
  }

  /* 剩余时间文案 */
  function remainText(exp) {
    const ms = exp.getTime() - Date.now();
    if (ms <= 0) return '会员已过期';
    const d = Math.floor(ms / 864e5);
    if (d >= 1) return `会员剩余 ${d} 天`;
    const h = Math.floor(ms / 36e5);
    if (h >= 1) return `会员剩余 ${h} 小时`;
    return `会员剩余 ${Math.max(1, Math.floor(ms / 6e4))} 分钟`;
  }
  function fmtExpire(exp) {
    const p = n => String(n).padStart(2, '0');
    return `${exp.getFullYear()}-${p(exp.getMonth() + 1)}-${p(exp.getDate())} ${p(exp.getHours())}:${p(exp.getMinutes())}`;
  }
  /* 打开会员弹窗（带当前状态；从主界面入口调用） */
  function openVipModal() {
    $('#vip-code').value = '';
    $('#vip-current').textContent = isVip && vipExpiresAt
      ? `${VIP_PLANS[vipPlan] || '会员'} · ${remainText(vipExpiresAt)}`
      : '';
    openModal('#modal-vip');
    setTimeout(() => $('#vip-code').focus(), 60);
  }

  /* 账号面板会员状态行（始终存在；未开通/已过期时可点击开通） */
  function renderVipState() {
    const el = $('#up-vip-state');
    if (!el) return;
    if (isVip && vipExpiresAt) {
      el.textContent = `${remainText(vipExpiresAt)} · 有效期至 ${fmtExpire(vipExpiresAt)}`;
      el.classList.remove('clickable', 'free');
    } else if (vipExpiresAt) {
      el.textContent = '会员已过期，点击续费';
      el.classList.add('clickable', 'free');
    } else {
      el.textContent = '目前您未开通会员，点击开通';
      el.classList.add('clickable', 'free');
    }
  }

  /* 激活码兑换（返回 plan 名） */
  async function redeemByCode(code) {
    if (!supaUser) throw { error: '请先登录后再激活' };
    const { data, error } = await supa.rpc('redeem_activation_code', {
      p_code: String(code).trim()
    });
    if (error) throw { error: error.message };
    if (!data) throw { error: '激活失败，请重试' };
    vipPlan = data.plan;
    vipExpiresAt = new Date(data.expires_at);
    isVip = vipExpiresAt.getTime() > Date.now();
  }

  /* 会员门控：已会员返回 true；否则关闭当前弹窗并弹激活窗 */
  function requireVip() {
    if (isVip) return true;
    closeModals();
    openVipModal();
    return false;
  }
  async function submitVipCode() {
    const btn = $('#vip-buy');
    const code = $('#vip-code').value.trim();
    if (!code) return toast('请输入激活码');
    if (btn.disabled) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '激活中…';
    try {
      await redeemByCode(code);
      closeModals();
      renderVipState();
      toast(`已激活${VIP_PLANS[vipPlan] || '会员'}`);
    } catch (e) {
      const m = e.error || '';
      if (/schema cache|could not find the table|activation_codes|function/i.test(m))
        toast('会员功能未就绪：请先执行最新版 supabase_membership.sql');
      else if (/permission denied/i.test(m))
        toast('数据表权限缺失：请重新执行最新版 supabase_membership.sql');
      else toast(m || '激活失败，请重试');
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
  $('#vip-buy').addEventListener('click', submitVipCode);
  $('#vip-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitVipCode(); }
  });
  $('#vip-cancel').addEventListener('click', closeModals);
  /* 主界面「我的会员」按钮与状态框（未开通/过期时） */
  $('#up-vip').addEventListener('click', openVipModal);
  $('#up-vip-state').addEventListener('click', () => {
    if ($('#up-vip-state').classList.contains('clickable')) openVipModal();
  });

  /* ============ 启动：恢复会话，自动同步；无会话弹登录门 ============ */
  async function supaBoot() {
    if (!supaReady()) {
      toast('云端连接加载失败，请检查网络后刷新页面');
      return;
    }
    initSupa();
    const { data } = await supa.auth.getSession();
    supaUser = data.session ? data.session.user : null;
    renderUserPanel();
    if (!supaUser) { openAuthGate(); return; }
    try {
      const r = await reconcile();
      if (r === 'downloaded') toast('云端有更新，已自动同步');
    } catch (e) {
      if (/JWT|expired/i.test(e.error || '')) {
        try { await supa.auth.signOut(); } catch (se) {}
        supaUser = null;
        openAuthGate();
      }
      // 其他错误（如断网）静默，可用「立即同步」重试
    }
    renderUserPanel();
  }

  /* ============ 左侧账号栏 ============ */
  function renderUserPanel() {
    if (!$('#user-panel')) return;
    if (supaUser) {
      $('#up-auth').classList.add('hidden');
      $('#up-account').classList.remove('hidden');
      const email = supaUser.email || '';
      $('#up-email-text').textContent = email;
      $('#up-avatar').textContent = (email.slice(0, 1) || '?').toUpperCase();
      $('#up-status').textContent = supaSyncing ? '正在同步…'
        : (supaDirty ? '有改动待同步' : '已连接 · 所有改动已同步');
    } else {
      $('#up-auth').classList.remove('hidden');
      $('#up-account').classList.add('hidden');
    }
  }
  function openUserPanel() {
    renderUserPanel();
    $('#user-panel').classList.add('open');
    $('#user-mask').classList.add('show');
  }
  function closeUserPanel() {
    $('#user-panel').classList.remove('open');
    $('#user-mask').classList.remove('show');
  }

  $('#lib-logo').addEventListener('click', openUserPanel);
  $('#user-mask').addEventListener('click', closeUserPanel);
  $('#up-login-btn').addEventListener('click', () => {
    closeUserPanel();
    openAuthGate();
  });
  $('#up-sync').addEventListener('click', () => supaPush(false));
  $('#up-logout').addEventListener('click', async () => {
    supaDirty = false;
    clearTimeout(supaPushTimer);
    if (supa) { try { await supa.auth.signOut(); } catch (e) {} }
    supaUser = null;
    renderUserPanel();
    closeUserPanel();
    openAuthGate();
    toast('已退出登录，本机数据不受影响');
  });
  $('#getapp-cancel').addEventListener('click', closeModals);

  /* 底部跨端入口：App → 外部浏览器打开网页版；网页 → 下载 App 弹窗 */
  const WEB_URL = 'https://tatoo79.github.io/WeTalk/';
  if (IS_APP) {
    $('#up-cross').innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>访问网页版';
    $('#up-cross').addEventListener('click', () => {
      closeUserPanel();
      if (window.WTNative && window.WTNative.openExternal) window.WTNative.openExternal(WEB_URL);
      else window.open(WEB_URL, '_blank');
    });
  } else {
    $('#up-cross').innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>下载应用';
    $('#up-cross').addEventListener('click', () => {
      closeUserPanel();
      openModal('#modal-getapp');
    });
  }

  /* ============ 启动 ============ */
  load();
  seedGuide();
  applyTheme();
  refreshSortBtn();
  renderLibrary();
  supaBoot();

  /* 异常退出（关页/刷新）前兜底保存草稿与自动标题 */
  window.addEventListener('beforeunload', () => {
    if (!editing) return;
    const html = $('#input-box').innerHTML.trim();
    if (html && html !== '<br>') {
      editing.lines.push({ side: editSide, row: ++editing.rowSeq, html });
    }
    editing.title = resolveTitle(editing);
    save();
  });
})();

