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
  }
  function save() {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    scheduleCloudPush(); // 登录 GitHub 云账号后：本地每次保存自动安排上传（函数声明，下方云模块定义）
    scheduleSupaPush();  // 登录 Supabase 账号后：同理自动安排上传（函数声明，下方模块定义）
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
    stopDevicePolling();
    $('#modal-mask').classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  }
  $('#modal-mask').addEventListener('click', closeModals);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
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

  /* 输入：
     · App：回车只在框内换行，发送靠点左右圆圈（零字符不发送，输入空格可发空格）
     · 网页：回车发送到当前选中角色（默认右，黑圈常驻标识）；
       Ctrl+回车 = 框内换行；
       Shift+←/→ = 切换选中角色（延续，直到再次切换）；
       按住 ←/→ 再按回车 = 本次直发该侧，但不改变选中角色。 */
  const inputBox = $('#input-box');

  /* 跟踪左右方向键是否处于按住状态（仅电脑端，用于「方向键+回车」直发） */
  const heldArrow = { L: false, R: false };
  function heldDir() {
    if (heldArrow.L && !heldArrow.R) return 'L';
    if (heldArrow.R && !heldArrow.L) return 'R';
    return null;
  }
  if (!IS_APP) {
    const trackArrow = (down, e) => {
      if (e.key === 'ArrowLeft') heldArrow.L = down;
      else if (e.key === 'ArrowRight') heldArrow.R = down;
    };
    document.addEventListener('keydown', e => trackArrow(true, e));
    document.addEventListener('keyup', e => trackArrow(false, e));
    window.addEventListener('blur', () => { heldArrow.L = heldArrow.R = false; });
  }

  inputBox.addEventListener('keydown', e => {
    if (IS_APP) return;   // App 不拦截任何按键，回车走 contenteditable 默认换行
    /* Shift+←/→：切换常驻角色 */
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setWebSide(e.key === 'ArrowLeft' ? 'L' : 'R');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {            // Ctrl+回车：框内换行
        document.execCommand('insertLineBreak');
        return;
      }
      const dir = heldDir();                    // 按住方向键+回车：直发该侧
      commitInput(true, dir || webSide);  // 不切换常驻角色；零字符不发送
    }
  });
  // 失焦时把草稿存为一条（不重绘，防止破坏选区）
  inputBox.addEventListener('blur', () => commitInput(false));

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
      if (!mask.classList.contains('hidden')) { mask.click(); return true; }
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

  /* ============ 导出 ============ */
  $('#btn-export').onclick = () => openModal('#modal-export');
  const FMT_META = {
    txt:  { label: 'TXT', ext: 'txt', mime: 'text/plain' },
    word: { label: 'Word', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  };
  const sanitizeName = n => String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || '未命名对话';
  document.querySelectorAll('.export-btn').forEach(b => {
    b.onclick = () => {
      commitInput();
      const doc = JSON.parse(JSON.stringify(editing));
      doc.title = resolveTitle(doc);
      const fmt = b.dataset.fmt;
      if (!doc.lines.length && fmt !== 'txt') { toast('暂无内容可导出'); return; }
      if (fmt === 'pdf') {
        // App：保留导出选择框——系统打印框左滑返回时正好回到此框；浏览器沿用原流程
        if (IS_APP) WTExport.exportPDF(doc);
        else { closeModals(); WTExport.exportPDF(doc); }
        return;
      }

      // txt / word：App 内先确认文件名，再由系统文件选择器（SAF）指定保存位置；
      // 浏览器环境沿用原下载流程
      if (!IS_APP) {
        closeModals();
        if (fmt === 'txt') WTExport.exportTXT(doc);
        else WTExport.exportWord(doc);
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
        const job = fmt === 'txt'
          ? Promise.resolve(WTExport.buildTXTBlob(doc))
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
  const GUIDE_KEY = IS_APP ? 'wetalk_guide_seeded_app_v3' : 'wetalk_guide_seeded_v2';
  function seedGuide() {
    if (localStorage.getItem(GUIDE_KEY)) return;
    // App 升级说明文案时，用新版种子替换旧版使用说明（仅 App 环境）
    if (IS_APP) {
      const n0 = db.docs.length;
      db.docs = db.docs.filter(d => d.title !== '欢迎使用 WeTalk · 使用说明');
      if (db.docs.length !== n0) save();
    }
    const diagram =
      '<svg viewBox="0 0 240 132" style="width:100%;max-width:252px;height:auto;margin:8px 0 2px;fill:none;stroke:currentColor;stroke-width:1.5;">'
      + '<line x1="120" y1="6" x2="120" y2="126" style="stroke:currentColor;opacity:.25;stroke-dasharray:4 4;stroke-width:1.2"/>'
      + '<rect x="14" y="12"  width="82" height="26" rx="10" style="fill:currentColor;opacity:.16;stroke:none"/>'
      + '<rect x="144" y="12"  width="82" height="26" rx="10" style="fill:currentColor;opacity:.5;stroke:none"/>'
      + '<rect x="14" y="52"  width="82" height="26" rx="10" style="fill:currentColor;opacity:.16;stroke:none"/>'
      + '<rect x="144" y="52"  width="82" height="26" rx="10" style="fill:currentColor;opacity:.5;stroke:none"/>'
      + '<rect x="144" y="92"  width="82" height="26" rx="10" style="fill:currentColor;opacity:.5;stroke:none"/>'
      + '</svg>';
    const switchTip = IS_APP
      ? '<b>四、输入与切换（手机端）</b><br>· 输入框左右各有一个圆圈，<u>点左圈发送到左栏，点右圈发送到右栏</u>；最近一次发送的一侧圆圈会放大加框，该侧输入栏向中间铺开一层渐变作为选中标识；什么都没输入时点击不会发送任何内容，输入了空格则会照常发送空格。<br>· <u>回车</u>只在输入框内换行，不会发送。<br>案例：右侧输入「明天三点见面」点右圈 → 右栏出现气泡；再输入「好的」点左圈 → 内容落在左侧对应行。<br>· <u>双指张合</u>可放大 / 缩小对话区字号，只影响本机预览、不影响导出，字号会被记住。<br>注意：编辑页内系统返回手势不会离开页面（第一次会提示点左上角箭头）；在文件夹中返回上一级，在桌面连续两次返回退出 App。'
      : '<b>四、输入与切换</b><br>· 输入框左右各有一个圆圈，<b>略大并带一圈外框</b>的圆圈是当前选中角色（默认右侧），该侧输入栏同时向中间铺开一层渐变，选中状态会一直保持到下次切换（日间墨灰、夜间鎏金）。<br>· <u>鼠标点圆圈</u>或 <u>Shift + ← / →</u>：切换选中角色。<br>· <u>回车</u>：发送到当前选中角色。<br>· <u>Ctrl + 回车</u>：在输入框内换行。<br>· 按住 <u>← 或 → 再按回车</u>：本次直接发送到对应侧，但不改变选中角色。<br>案例：选中右侧时输入「明天三点见面」回车 → 右栏出现气泡；按住 ← 再按回车可把内容直发左侧，松开后再回车仍发送到右侧。';
    const saveTip = IS_APP
      ? '<b>七、保存机制（手机端）</b><br>· <b>新建文稿时先选择保存位置</b>（桌面或某个文件夹），确认后才进入编写。<br>· 编辑内容<b>默认自动保存</b>，无需任何手动操作；点左上角箭头即返回文档库。<br>· 文稿位置可随时通过列表三点菜单里的「移动」更换，移动时可以直接选择「桌面」。'
      : '<b>七、保存机制</b><br>· 新建文稿时先选择保存位置（桌面或某个文件夹），确认后进入编写。<br>· 编辑内容会自动保存，不会打断编辑；点左上角箭头返回文档库。';
    const items = [
      '<b>欢迎使用 WeTalk</b><br>这是一个专注于「快速记录对话」的小工具。没有复杂的排版功能，打开就能记，记完即可导出。这份说明会带你快速上手，读完后可以随时删除它。',
      '<b>一、主界面 · 你的文档库</b><br>· 中间是文稿与文件夹列表，显示名称和创建日期，列表独立滚动，上下栏始终固定不动。<br>· 每行右侧的「三个点」可对该项目执行 <u>重命名 / 移动 / 删除</u>。<br>· 右下角圆形 ＋ 用来新建文稿或文件夹。<br>· 底部居中显示文稿与文件夹总数。',
      '<b>二、快速导航与搜索</b><br>· 点右上角的栏位图标，右侧会展开快速导航：<b>单击文件夹</b>即可展开 / 折叠它包含的内层文件夹和文稿；<b>双击文稿</b>直接进入编辑。<br>· 顶部搜索框输入关键字，会实时按名称筛选文稿和文件夹；清空即恢复。',
      '<b>三、编写界面 · 左右分栏</b><br>对话按左右两栏记录，并按「全局行号」对齐——同侧连发依次下移，换到另一侧时会对齐到同一水平线的对侧栏位，两边内容永远不会串栏。'
      + diagram
      + '<span style="font-size:12.5px;opacity:.75;">示意图：右侧连发两条（深色），左侧回复落在对应行（浅色）。</span>',
      switchTip,
      '<b>五、气泡修改与补全</b><br>· <u>单击任意已发送气泡</u>即可直接修改文字；保存方式是点该气泡之外的任意位置（仅退出本次编辑，不会触发其他操作），再次点击才恢复正常操作；把文字全部删空后退出，该气泡所在行会整体删除，后续行自动补位。<br>· <u>单击两个气泡之间的缝隙</u>（含第一行与名称栏之间）进入「补全模式」：中间出现横跨左右的白色圆框，把内容' + (IS_APP ? '用左右圆圈发送' : '回车发送（可用方向键+回车选侧）') + '进去，可连续补多条；点右下角 ✓ 完成，一条没发就点 ✓ 则取消补全、各行回到原位。（最后一条气泡下方不会触发补全。）<br>· 点顶栏的「字体编辑」图标，下方会展开 B / U 工具条；不仅能给即将输入的文字加格式，也可以<b>选中已发送气泡里的文字</b>再点 B / U' + (IS_APP ? '' : '（气泡内也支持 Ctrl+B、Ctrl+U）') + '，只格式化选中的部分，再点一次图标收起工具条。',
      '<b>六、人物设置</b><br>点左上角的人型图标（角色设置），可为左右两人分别设置：<br>· <u>头像</u>：从本地图库选择，或切换到纯色模式点选色环 / 输入色号，颜色会即时显示，直接点保存即可（无需再点行内小确定）。<br>· <u>名字</u>：设置后，输入框左右两个圆圈会分别显示两人名字的第一个字（未设置时仍显示「左 / 右」），对话区上方也会在左右两栏居中显示对应名字。<br>没有手动填写标题时，文稿会自动命名为「左边名字和右边名字的对话」，同名时自动追加数字区分。',
      saveTip,
      '<b>八、导出三种格式</b><br>点右上角导出图标：<br>· <u>TXT</u>：首行标注（左）（右）名字，右侧对话靠右排列。<br>· <u>Word</u>：双栏排版、左右绝不混行，顶部含居中头像与名字，保留加粗、下划线与头像图片。<br>' + (IS_APP ? 'TXT / Word 确认文件名后会打开系统文件选择器，由你指定具体保存位置。<br>· ' : '· ') + '<u>PDF</u>：版式与 Word 一致，在系统打印窗口选择「另存为 PDF」即可。',
      '<b>九、数据与隐私</b><br>所有文稿、设置和头像默认保存在<b>本机</b>中，无需联网。需要在多台设备（手机 / 电脑）之间同步时，点顶部标题旁的<b>云朵图标</b>：App 内可用 GitHub 账号授权登录，网页版可粘贴访问令牌；数据会自动保存到你 GitHub 账号下的私有仓库（他人不可见），换设备后重新连接即可恢复全部记录；也可以随时退出登录，退出不影响本机已有数据。' + (IS_APP ? '卸载 App 或清除应用数据会同时删除本机内容，请重要记录及时导出备份。' : '清理浏览器数据会同时删除本机内容，请重要记录及时导出备份。') + '<br><br>准备好了，就点右下角 ＋ 开始第一段对话吧。'
    ];
    const doc = {
      id: uid(),
      folderId: null,
      title: '欢迎使用 WeTalk · 使用说明',
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

  /* ============ 云同步（GitHub Device Flow · 私有仓库整库同步） ============
     最经济方案：永久 0 元。点云朵 → 浏览器在 GitHub 官方页输入一次性授权码 →
     数据以 JSON 存放在你账号下自动创建的私有仓库 wetalk-data 中；
     任何设备（网页 / App）登录同一 GitHub 账号即可恢复，双端共用本模块。 */
  const GH_CLIENT_ID = 'Ov23li8OlmkfBhi89I6r';
  const GH_API = 'https://api.github.com';
  const GH_REPO = 'wetalk-data';
  const GH_PATH = 'wetalk-db.json';
  const GH_MAX_BYTES = 900000;   // Contents API 单文件约 1MB 上限
  const CLOUD_KEY = 'wetalk_cloud_v1';
  let cloud = null;              // { token, login, sha }
  let cloudSyncing = false;
  let cloudPushTimer = null;
  let cloudDirty = false;
  let deviceTimer = null;
  let deviceStopped = false;

  function cloudConfigured() { return !/^__GH_CLIENT_ID__$/.test(GH_CLIENT_ID); }
  function loadCloudMeta() {
    try { cloud = JSON.parse(localStorage.getItem(CLOUD_KEY)); } catch (e) { cloud = null; }
  }
  function saveCloudMeta() {
    try { localStorage.setItem(CLOUD_KEY, JSON.stringify(cloud)); } catch (e) {}
  }
  function clearCloudMeta() {
    cloud = null;
    try { localStorage.removeItem(CLOUD_KEY); } catch (e) {}
    refreshCloudBtn();
  }

  /* GitHub REST API（JSON） */
  function ghRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, GH_API + path, true);
      xhr.setRequestHeader('Accept', 'application/vnd.github+json');
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (cloud && cloud.token) xhr.setRequestHeader('Authorization', 'Bearer ' + cloud.token);
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        let data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data || {});
        else reject({ status: xhr.status, error: (data && (data.message || data.error)) || ('请求失败 (' + xhr.status + ')') });
      };
      xhr.onerror = () => reject({ status: 0, error: '网络不可用，请检查网络连接' });
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }
  /* Device Flow 表单端点（github.com，非 api）：
     App 走 Java 原生桥（OAuth 端点不支持网页跨域）；网页端 XHR */
  function ghForm(url, params) {
    if (IS_APP && window.WTNative) {
      return new Promise((resolve, reject) => {
        let raw;
        try {
          raw = /\/device\/code$/.test(url)
            ? window.WTNative.ghDeviceCode(params.client_id)
            : window.WTNative.ghPollToken(params.client_id, params.device_code);
        } catch (e) {
          return reject({ error: 'bridge_error', error_description: '原生桥调用失败' });
        }
        let data = null;
        try { data = JSON.parse(raw); } catch (e) {}
        if (!data) return reject({ error: 'bad_response', error_description: '返回内容无法解析' });
        if (data.error) reject(data); else resolve(data);
      });
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300 && data) {
          if (data.error) reject(data); else resolve(data);
        }
        else reject({ status: xhr.status, error: (data && (data.error_description || data.error)) || '请求失败' });
      };
      xhr.onerror = () => reject({ status: 0, error: 'network_error', error_description: '网络不可用，请检查网络连接' });
      xhr.send(new URLSearchParams(params).toString());
    });
  }

  const ghMe         = () => ghRequest('GET', '/user');
  const ghRepoInfo   = login => ghRequest('GET', '/repos/' + login + '/' + GH_REPO);
  const ghCreateRepo = () => ghRequest('POST', '/user/repos', { name: GH_REPO, private: true, auto_init: false });
  const ghGetFile    = login => ghRequest('GET', '/repos/' + login + '/' + GH_REPO + '/contents/' + GH_PATH);
  const ghPutFile    = (login, content, sha) => {
    const body = { message: 'wetalk sync ' + new Date().toISOString().replace('T', ' ').slice(0, 19), content };
    if (sha) body.sha = sha;
    return ghRequest('PUT', '/repos/' + login + '/' + GH_REPO + '/contents/' + GH_PATH, body);
  };

  function ghErrText(e) {
    if (e.status === 401) return '登录已过期，请重新登录';
    if (e.status === 403 && /rate limit/i.test(e.error || '')) return 'GitHub 请求过于频繁，请稍后再试';
    return e.error || '同步失败，请稍后重试';
  }

  /* UTF-8 安全的 base64 编解码 */
  const b64encode = str => btoa(unescape(encodeURIComponent(str)));
  function b64decode(b64) {
    try { return decodeURIComponent(escape(atob((b64 || '').replace(/\s/g, '')))); }
    catch (e) { return atob((b64 || '').replace(/\s/g, '')); }
  }

  /* ---- 本地保存后自动安排上传（1.5 秒合并连续编辑；上传前先核对云端版本） ---- */
  function scheduleCloudPush() {
    if (!cloud || !cloud.token) return;
    cloudDirty = true;
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => { cloudPush(true); }, 1500);
  }

  function applyCloudPayload(payload) {
    db = JSON.parse(payload);
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    saveCloudMeta();
    applyTheme(); renderLibrary();
  }

  /* 云端版本与本机不一致时的二选一弹窗，返回 'cloud'（恢复云端）或 'local'（本机覆盖） */
  function cloudPickPromise(label) {
    return new Promise(resolve => {
      const who = label || 'GitHub 云端';
      $('#cloudpick-text').textContent =
        who + '已有一份数据。恢复云端数据会覆盖本机现有内容；保留本机内容则会覆盖云端版本。';
      openModal('#modal-cloudpick');
      $('#cloudpick-cloud').onclick = () => { closeModals(); resolve('cloud'); };
      $('#cloudpick-local').onclick = () => { closeModals(); resolve('local'); };
    });
  }

  /* 拉取云端文件；不存在返回 null */
  async function fetchRemoteFile() {
    const remote = await ghGetFile(cloud.login);
    cloud.sha = remote.sha; saveCloudMeta();
    return b64decode(remote.content);
  }

  async function cloudPush(auto) {
    if (!cloud || !cloud.token) return;
    if (cloudSyncing) { cloudDirty = true; return; }
    cloudSyncing = true; refreshCloudBtn();
    try {
      const localStr = JSON.stringify(db);
      if (localStr.length > GH_MAX_BYTES) throw { status: 0, error: '本机数据过大，已超过 GitHub 单文件同步上限' };
      let remoteStr = null;
      try {
        remoteStr = await fetchRemoteFile();
      } catch (ge) {
        if (ge.status !== 404) throw ge; // 文件尚未创建属正常
      }
      if (remoteStr !== null && remoteStr !== localStr) {
        const choice = await cloudPickPromise();
        if (choice === 'cloud') {
          applyCloudPayload(remoteStr);
          cloudDirty = false;
          toast('已恢复云端数据');
          return;
        }
        // 选择本机覆盖：沿用刚拿到的最新 sha
      }
      const put = await ghPutFile(cloud.login, b64encode(localStr), cloud.sha);
      cloud.sha = put.content.sha; saveCloudMeta(); cloudDirty = false;
      if (!auto) toast('已同步到云端');
    } catch (e) {
      cloudDirty = true; // 网络失败：改动保留，下次保存或手动同步时重试
      if (!auto) toast(ghErrText(e));
    } finally {
      cloudSyncing = false; refreshCloudBtn();
    }
  }

  /* ---- Device Flow 登录 ---- */
  function stopDevicePolling() {
    deviceStopped = true;
    clearTimeout(deviceTimer);
    deviceTimer = null;
  }
  function showDeviceView() {
    $('#gh-login').classList.add('hidden');
    $('#gh-device').classList.remove('hidden');
  }
  function showLoginStart() {
    $('#gh-device').classList.add('hidden');
    $('#gh-login').classList.remove('hidden');
    $('#gh-login-app').classList.toggle('hidden', !IS_APP);
    $('#gh-login-web').classList.toggle('hidden', IS_APP);
    $('#gh-token-error').textContent = '';
    $('#gh-token-input').value = '';
  }
  /* 网页端：粘贴令牌连接 */
  async function startWebTokenLogin() {
    const input = $('#gh-token-input');
    const err = $('#gh-token-error');
    const token = input.value.trim();
    err.textContent = '';
    if (!/^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(token)) {
      err.textContent = '令牌格式不正确，应为 ghp_ 或 github_pat_ 开头';
      return;
    }
    const btn = $('#gh-token-ok'); btn.disabled = true;
    try {
      await afterDeviceAuth(token);
    } catch (e) {
      err.textContent = ghErrText(e);
    } finally {
      btn.disabled = false;
    }
  }
  async function startDeviceLogin() {
    if (!cloudConfigured()) return toast('云同步尚未配置');
    const btn = $('#gh-start'); btn.disabled = true;
    try {
      const code = await ghForm('https://github.com/login/device/code', { client_id: GH_CLIENT_ID, scope: 'repo' });
      showDeviceView();
      $('#gh-code').textContent = code.user_code;
      $('#gh-url').textContent = code.verification_uri;
      let interval = Math.max(code.interval || 5, 5);
      const expiresAt = Date.now() + (code.expires_in || 900) * 1000;
      deviceStopped = false;

      const poll = async () => {
        if (deviceStopped) return;
        if (Date.now() > expiresAt) {
          $('#gh-wait').textContent = '授权码已过期，请重新发起登录';
          setTimeout(() => { if (!deviceStopped) { showLoginStart(); } }, 1600);
          return;
        }
        try {
          const r = await ghForm('https://github.com/login/oauth/access_token', {
            client_id: GH_CLIENT_ID, device_code: code.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          });
          if (r.access_token) {
            stopDevicePolling();
            await afterDeviceAuth(r.access_token);
            return;
          }
        } catch (e) {
          const why = e.error || '';
          if (why === 'authorization_pending') {
            $('#gh-wait').textContent = '等待授权中…完成后自动继续';
          } else if (why === 'slow_down') {
            interval += 5;
          } else if (why === 'access_denied') {
            stopDevicePolling();
            $('#gh-wait').textContent = '你取消了授权';
            setTimeout(showLoginStart, 1400);
            return;
          } else if (why === 'expired_token') {
            stopDevicePolling();
            $('#gh-wait').textContent = '授权码已过期，请重新发起登录';
            setTimeout(showLoginStart, 1600);
            return;
          } else {
            stopDevicePolling();
            $('#gh-wait').textContent = e.error_description || e.error || '登录失败，请重试';
            setTimeout(showLoginStart, 1800);
            return;
          }
        }
        deviceTimer = setTimeout(poll, interval * 1000);
      };
      poll();
    } catch (e) {
      showLoginStart();
      toast(ghErrText(e));
    } finally {
      btn.disabled = false;
    }
  }

  /* 授权成功：确认账号 → 确保私有仓库 → 首同步 */
  async function ensureRepo(login) {
    try {
      await ghRepoInfo(login);
    } catch (e) {
      if (e.status === 404) await ghCreateRepo();
      else throw e;
    }
  }
  async function afterDeviceAuth(token) {
    cloud = { token, login: null, sha: null };
    const me = await ghMe();
    cloud.login = me.login;
    saveCloudMeta();
    await ensureRepo(cloud.login);
    const localStr = JSON.stringify(db);
    const localEmpty = db.docs.length === 0 && db.folders.length === 0;
    let remoteStr = null;
    try {
      remoteStr = await fetchRemoteFile();
    } catch (ge) {
      if (ge.status !== 404) throw ge;
    }
    if (remoteStr === null) {
      const put = await ghPutFile(cloud.login, b64encode(localStr), null);
      cloud.sha = put.content.sha; saveCloudMeta();
      closeModals();
      toast('登录成功，本机数据已上传云端');
    } else if (remoteStr === localStr) {
      closeModals();
      toast('登录成功，数据已是同步状态');
    } else if (localEmpty) {
      applyCloudPayload(remoteStr);
      closeModals();
      toast('登录成功，已恢复云端数据');
    } else {
      const choice = await cloudPickPromise();
      if (choice === 'cloud') {
        applyCloudPayload(remoteStr);
        toast('已恢复云端数据');
      } else {
        const put = await ghPutFile(cloud.login, b64encode(localStr), cloud.sha);
        cloud.sha = put.content.sha; saveCloudMeta();
        toast('本机数据已上传');
      }
    }
    refreshCloudBtn();
  }

  /* ---- 启动时自动恢复会话并检查云端新版本 ---- */
  async function cloudBoot() {
    if (!cloudConfigured()) { refreshCloudBtn(); return; }
    loadCloudMeta();
    refreshCloudBtn();
    if (!cloud || !cloud.token) return;
    try {
      const me = await ghMe();
      cloud.login = me.login; saveCloudMeta();
      await ensureRepo(cloud.login);
      let remoteStr = null;
      try {
        remoteStr = await fetchRemoteFile();
      } catch (ge) {
        if (ge.status === 404) remoteStr = null; else throw ge;
      }
      if (remoteStr === null) {
        const put = await ghPutFile(cloud.login, b64encode(JSON.stringify(db)), null);
        cloud.sha = put.content.sha; saveCloudMeta();
        return;
      }
      if (remoteStr !== JSON.stringify(db)) {
        const choice = await cloudPickPromise();
        if (choice === 'cloud') {
          applyCloudPayload(remoteStr);
          toast('已恢复云端数据');
        } else {
          await cloudPush(false);
        }
      }
    } catch (e) {
      if (e.status === 401) clearCloudMeta();
      // 网络错误保持静默，下次手动同步即可
    }
    refreshCloudBtn();
  }

  /* ---- 手动「立即同步」 ---- */
  async function syncNow() {
    if (!cloud || !cloud.token) return openCloudModal();
    if (cloudSyncing) return;
    try {
      const localStr = JSON.stringify(db);
      let remoteStr = null;
      try {
        remoteStr = await fetchRemoteFile();
      } catch (ge) {
        if (ge.status !== 404) throw ge;
      }
      if (remoteStr === localStr) return toast('已是最新');
      await cloudPush(false);
    } catch (e) { toast(ghErrText(e)); }
  }

  /* ---- 云同步 UI ---- */
  function refreshCloudBtn() {
    const btn = $('#btn-cloud');
    if (!btn) return;
    btn.classList.toggle('is-linked', !!(cloud && cloud.token));
    btn.classList.toggle('is-busy', !!cloudSyncing);
    btn.title = !cloudConfigured() ? '云同步未配置'
      : !cloud ? '云同步：点此登录'
      : cloudSyncing ? '云同步：正在同步…' : '云同步：已连接（' + cloud.login + '）';
  }
  function showCloudAuth() {
    stopDevicePolling();
    $('#cloud-auth').classList.remove('hidden');
    $('#cloud-account').classList.add('hidden');
    showLoginStart();
  }
  function showCloudAccount() {
    $('#cloud-auth').classList.add('hidden');
    $('#cloud-account').classList.remove('hidden');
    $('#cloud-name').textContent = cloud.login;
    $('#cloud-avatar').textContent = (cloud.login || '?').slice(0, 1).toUpperCase();
    $('#cloud-status').textContent = cloudSyncing ? '正在同步…' : (cloudDirty ? '有改动待同步' : '已连接 · 所有改动已同步');
  }
  function openCloudModal() {
    if (!cloudConfigured()) return toast('云同步尚未配置');
    if (cloud && cloud.token) showCloudAccount(); else showCloudAuth();
    openModal('#modal-cloud');
  }

  $('#btn-cloud').addEventListener('click', openCloudModal);
  $('#gh-start').addEventListener('click', startDeviceLogin);
  $('#gh-cancel-device').addEventListener('click', () => {
    stopDevicePolling();
    closeModals();
  });
  $('#gh-token-ok').addEventListener('click', startWebTokenLogin);
  $('#gh-token-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); startWebTokenLogin(); }
  });
  $('#cloud-logout').addEventListener('click', () => {
    stopDevicePolling();
    closeModals();
    clearCloudMeta();
    toast('已退出云同步，本机数据不受影响');
  });
  $('#cloud-sync-now').addEventListener('click', () => { closeModals(); syncNow(); });

  /* ============ 云同步（Supabase · 邮箱账号 · 整库 jsonb 同步） ============
     与 GitHub 通道并存、互不影响：登录 Supabase 账号后，整库 db 以 jsonb 存入
     表 sync_data（每个用户一行），保存后自动上传、换设备登录自动恢复。
     SDK 经 CDN 加载；离线/加载失败时本通道静默停用，不影响其他功能。 */
  const SUPA_URL = 'https://fdmahwltwoypecyjpmfb.supabase.co';
  const SUPA_ANON = 'sb_publishable_dAFSkJ5BungbrDlG7BqxrA_YqZtPIDq';
  const SUPA_TABLE = 'sync_data';
  let supa = null;            // Supabase 客户端
  let supaUser = null;
  let supaSyncing = false;
  let supaDirty = false;
  let supaPushTimer = null;

  function supaEnabled() { return !!(window.supabase && SUPA_URL); }
  function initSupa() {
    if (!supaEnabled()) return;
    supa = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    supa.auth.onAuthStateChange((event, session) => {
      supaUser = session ? session.user : null;
      renderUserPanel();
    });
  }

  /* ---- 表读写 ---- */
  async function supaGetRow() {
    const { data, error } = await supa.from(SUPA_TABLE).select('payload').maybeSingle();
    if (error) throw { error: error.message };
    return data ? data.payload : null; // jsonb，已是对象
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
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    applyTheme(); renderLibrary();
  }
  function supaErrText(e) {
    const m = e.error || '';
    if (/could not find the table|sync_data|schema cache/i.test(m))
      return '云端数据表尚未创建：请在 Supabase 的 SQL Editor 执行建表语句后再同步';
    if (/JWT|expired/i.test(m)) return '登录已过期，请重新登录';
    return m || '同步失败，请稍后重试';
  }

  /* ---- 本地保存后自动安排上传（与 GitHub 通道同样的 1.5s 合并节奏） ---- */
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
      const localStr = JSON.stringify(db);
      const remoteObj = await supaGetRow();
      const remoteStr = remoteObj ? JSON.stringify(remoteObj) : null;
      if (remoteStr !== null && remoteStr !== localStr) {
        const choice = await cloudPickPromise('Supabase 云端');
        if (choice === 'cloud') {
          applySupaPayload(remoteObj);
          supaDirty = false;
          toast('已恢复云端数据');
          return;
        }
        // 选择本机覆盖：继续执行 upsert
      }
      await supaPutRow(db);
      supaDirty = false;
      if (!auto) toast('已同步到云端');
    } catch (e) {
      supaDirty = true; // 失败保留改动，下次保存/手动同步重试
      if (!auto) toast(supaErrText(e));
      if (/JWT|expired/i.test(e.error || '')) { supaUser = null; supa.auth.signOut(); }
    } finally {
      supaSyncing = false; renderUserPanel();
    }
  }

  /* ---- 登录/注册成功后的首同步（四态：无远端 / 相同 / 本机空 / 冲突） ---- */
  async function supaFirstSync() {
    const localStr = JSON.stringify(db);
    const localEmpty = db.docs.length === 0 && db.folders.length === 0;
    const remoteObj = await supaGetRow();
    if (!remoteObj) {
      await supaPutRow(db);
      toast('登录成功，本机数据已上传云端');
    } else if (JSON.stringify(remoteObj) === localStr) {
      toast('登录成功，数据已是同步状态');
    } else if (localEmpty) {
      applySupaPayload(remoteObj);
      toast('登录成功，已恢复云端数据');
    } else {
      const choice = await cloudPickPromise('Supabase 云端');
      if (choice === 'cloud') {
        applySupaPayload(remoteObj);
        toast('已恢复云端数据');
      } else {
        await supaPutRow(db);
        toast('本机数据已上传');
      }
    }
  }

  /* ---- 启动：恢复会话并检查云端新版本 ---- */
  async function supaBoot() {
    if (!supaEnabled()) return;
    initSupa();
    const { data } = await supa.auth.getSession();
    supaUser = data.session ? data.session.user : null;
    renderUserPanel();
    if (!supaUser) return;
    try {
      const remoteObj = await supaGetRow();
      if (!remoteObj) { await supaPutRow(db); return; }
      if (JSON.stringify(remoteObj) !== JSON.stringify(db)) {
        const choice = await cloudPickPromise('Supabase 云端');
        if (choice === 'cloud') {
          applySupaPayload(remoteObj);
          toast('已恢复云端数据');
        } else {
          await supaPush(false);
        }
      }
    } catch (e) {
      if (/JWT|expired/i.test(e.error || '')) { supaUser = null; supa.auth.signOut(); }
      // 网络错误保持静默，下次手动同步即可
    }
    renderUserPanel();
  }

  /* ---- 左侧账号栏 UI ---- */
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
  $('#up-sync').addEventListener('click', () => supaPush(false));
  $('#up-logout').addEventListener('click', async () => {
    supaDirty = false;
    if (supa) await supa.auth.signOut();
    supaUser = null;
    renderUserPanel();
    toast('已退出登录，本机数据不受影响');
  });
  $('#getapp-cancel').addEventListener('click', closeModals);

  /* 登录/注册 标签切换 */
  let upMode = 'login';
  document.querySelectorAll('.up-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      upMode = tab.dataset.up;
      document.querySelectorAll('.up-tab').forEach(t => t.classList.toggle('active', t === tab));
      $('#up-password2').classList.toggle('hidden', upMode === 'login');
      $('#up-submit').textContent = upMode === 'login' ? '登录' : '注册并同步';
      $('#up-error').textContent = '';
    });
  });

  /* 登录/注册 提交 */
  $('#up-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#up-email').value.trim();
    const pwd = $('#up-password').value;
    const err = $('#up-error');
    err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = '请输入正确的邮箱地址'; return; }
    if (pwd.length < 6) { err.textContent = '密码至少 6 位'; return; }
    const btn = $('#up-submit');
    btn.disabled = true;
    try {
      if (!supa) throw { error: '云端模块加载失败，请检查网络后刷新页面' };
      if (upMode === 'signup') {
        if ($('#up-password2').value !== pwd) throw { error: '两次输入的密码不一致' };
        const { data, error } = await supa.auth.signUp({ email, password: pwd });
        if (error) throw { error: error.message };
        if (data.session) {
          await supaFirstSync();
          closeUserPanel();
        } else {
          // 项目开启了邮箱验证：无会话返回
          err.textContent = '注册成功，请查收邮件并点击验证链接后再登录';
        }
      } else {
        const { error } = await supa.auth.signInWithPassword({ email, password: pwd });
        if (error) throw { error: error.message };
        await supaFirstSync();
        closeUserPanel();
      }
    } catch (ex) {
      err.textContent = ex.error || '操作失败，请重试';
    } finally {
      btn.disabled = false;
    }
  });

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
      '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>下载应用';
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
  cloudBoot();
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
