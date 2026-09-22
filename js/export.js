/* ============ WeCTalk · 导出模块（word(.docx) / pdf / 长图jpg） ============ */
const WTExport = (() => {

  /* ---------- HTML 规整 ---------- */
  function normHtml(html) {
    let s = html
      .replace(/<br\s*\/?>/gi, '<br>')
      .replace(/<\/(div|p|li|h\d)>/gi, '<br>')
      .replace(/<(div|p|li|h\d)[^>]*>/gi, '');
    // 白名单：仅保留 b / u / br，其余标签（span、svg 等）整段移除
    s = s.replace(/<([a-zA-Z][^>]*?)\/?>/g, (m, inner) => {
      const tag = inner.trim().toLowerCase();
      return /^(b|\/b|u|\/u|br\b)/.test(tag) ? m : '';
    });
    return s
      .replace(/<br\s*>(\s*(<br\s*>|&nbsp;))+/gi, '<br>')
      .replace(/^\s*(<br\s*>)+\s*/i, '');
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- 头像归一化：照片→原样；纯色→圆形 PNG 图片；空→null ----------
     关键：纯色也生成“真实图片”，避免打印/Word 中 CSS 背景被忽略 */
  function colorCircleDataURL(hex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 128, 128);
    x.fillStyle = hex;
    x.beginPath(); x.arc(64, 64, 64, 0, Math.PI * 2); x.fill();
    return c.toDataURL('image/png');
  }
  async function resolveAvatar(av) {
    if (!av) return null;
    if (av.startsWith('data:')) {
      const m = av.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) return { mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], b64: m[2] };
      return null;
    }
    // 纯色 → 圆形 PNG
    const url = colorCircleDataURL(av);
    const m = url.match(/^data:image\/png;base64,(.+)$/);
    return { mime: 'image/png', b64: m[1] };
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /* ============================================================
     长图（PNG · 2x 高清）：完整排版——标题 + 双方头像/名字 + 全部气泡
     Canvas 两遍布局：先量高排版，再逐元素绘制
     ============================================================ */
  const IMG_W = 750;
  const IMG_SCALE = 2;   // 2 倍分辨率渲染，高清屏不糊（输出 PNG）
  const IMG_PAD = 34;
  const IMG_FS = 15;
  const IMG_LH = Math.round(IMG_FS * 1.55);       // 24
  const IMG_TITLE_FS = 23;
  const IMG_TITLE_LH = 34;
  const IMG_AV = 60;                               // 头像直径
  const IMG_BUBBLE_TOP = 18;                       // 分割线到首条气泡的间距
  const IMG_BUB_PAD_X = 19;
  const IMG_BUB_PAD_Y = 13;
  const IMG_BUB_MAX = IMG_W - IMG_PAD * 2 - 130;   // 气泡文字最大宽度

  /* HTML → 带样式片段（bold / under）+ 换行符 */
  function styledTokens(html) {
    let s = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, t => /^<\/?[bu]>$/i.test(t) ? t : '');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const tokens = [];
    let bold = false, under = false;
    s.split(/(<\/?[bu]>|\n)/g).forEach(p => {
      if (p === '') return;
      const pl = p.toLowerCase();
      if (pl === '<b>') bold = true;
      else if (pl === '</b>') bold = false;
      else if (pl === '<u>') under = true;
      else if (pl === '</u>') under = false;
      else if (p === '\n') tokens.push({ nl: true });
      else tokens.push({ t: p, bold, under });
    });
    return tokens;
  }

  /* 片段 → 排版单元：连续 ASCII 词组 / 空白 / 单字（CJK） */
  function unitsOf(tokens) {
    const units = [];
    tokens.forEach(tk => {
      if (tk.nl) { units.push({ br: true }); return; }
      const re = /[A-Za-z0-9'’.,;:!?（）()·\-–—\/]+|\s+|./g;
      let m;
      while ((m = re.exec(tk.t))) units.push({ t: m[0], bold: tk.bold, under: tk.under });
    });
    return units;
  }

  function setFont(ctx, bold, fs) {
    ctx.font = (bold ? 'bold ' : '') + fs + 'px sans-serif';
  }

  /* 贪心换行 → 每行 [{t,bold,under,w}]，相邻同样式自动合并 */
  function layoutLines(units, maxW, ctx, fs) {
    const raw = [[]];
    let curW = 0;
    const breakLine = () => { raw.push([]); curW = 0; };
    units.forEach(u => {
      if (u.br) { breakLine(); return; }
      if (curW === 0 && /^\s+$/.test(u.t)) return;
      setFont(ctx, u.bold, fs);
      let w = ctx.measureText(u.t).width;
      if (curW + w > maxW && curW > 0) {
        breakLine();
        if (/^\s+$/.test(u.t)) return;
      }
      const line = raw[raw.length - 1];
      if (w > maxW && curW === 0) {
        // 超长词：逐字拆行
        Array.from(u.t).forEach(ch => {
          setFont(ctx, u.bold, fs);
          const cw = ctx.measureText(ch).width;
          if (cw && curW + cw > maxW && curW > 0) breakLine();
          raw[raw.length - 1].push({ t: ch, bold: u.bold, under: u.under, w: cw });
          curW += cw;
        });
        return;
      }
      line.push({ t: u.t, bold: u.bold, under: u.under, w });
      curW += w;
    });
    return raw.map(frags => {
      const merged = [];
      frags.forEach(f => {
        const last = merged[merged.length - 1];
        if (last && last.bold === f.bold && last.under === f.under) {
          last.t += f.t; last.w += f.w;
        } else merged.push({ ...f });
      });
      return merged;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* 头像预加载：dataURL → Image（失败回退占位）；纯色/空 → 色块 */
  function loadAvatar(src) {
    return new Promise(res => {
      if (!src) return res({ color: '#c4c8d2' });
      if (/^#[0-9a-f]{3,8}$/i.test(src)) return res({ color: src });
      if (src.indexOf('data:') === 0) {
        const img = new Image();
        let done = false;
        const finish = v => { if (!done) { done = true; res(v); } };
        img.onload = () => finish({ img });
        img.onerror = () => finish({ color: '#c4c8d2' });
        setTimeout(() => finish({ color: '#c4c8d2' }), 4000);
        img.src = src;
      } else res({ color: '#c4c8d2' });
    });
  }

  function drawAvatar(ctx, av, cx, top, size) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, top + size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = av.color || '#c4c8d2';
    ctx.fill();
    ctx.clip();
    if (av.img) {
      const sc = Math.max(size / av.img.width, size / av.img.height);
      const dw = av.img.width * sc, dh = av.img.height * sc;
      ctx.drawImage(av.img, cx - dw / 2, top + (size - dh) / 2, dw, dh);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, top + size / 2, size / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  async function buildImageBlob(doc) {
    const measure = document.createElement('canvas').getContext('2d');
    const sorted = [...doc.lines].sort((a, b) => a.row - b.row);

    const [avL, avR] = await Promise.all([
      loadAvatar(doc.settings.left.avatar),
      loadAvatar(doc.settings.right.avatar)
    ]);

    // 标题排版
    const titleLines = layoutLines(
      unitsOf([{ t: doc.title || '未命名对话', bold: true, under: false }]),
      IMG_W - IMG_PAD * 2, measure, IMG_TITLE_FS
    );
    // 气泡排版
    const bubbles = sorted.map(l => {
      const lines = layoutLines(unitsOf(styledTokens(l.html)), IMG_BUB_MAX, measure, IMG_FS);
      const h = IMG_BUB_PAD_Y * 2 + Math.max(1, lines.length) * IMG_LH;
      return { side: l.side, lines, h };
    });

    // ---- 总高 ----
    let y = IMG_PAD;
    y += titleLines.length * IMG_TITLE_LH + 24;
    y += IMG_AV + 20;
    y += IMG_BUBBLE_TOP;
    bubbles.forEach(b => { y += b.h + 12; });
    const H = Math.ceil(y + 30);

    // ---- 绘制 ----
    const cv = document.createElement('canvas');
    cv.width = IMG_W * IMG_SCALE; cv.height = H * IMG_SCALE;
    const ctx = cv.getContext('2d');
    ctx.scale(IMG_SCALE, IMG_SCALE);   // 全部按逻辑坐标绘制，输出 2 倍像素
    ctx.textBaseline = 'alphabetic';

    // 背景
    ctx.fillStyle = '#edf0f4';
    ctx.fillRect(0, 0, IMG_W, H);

    // 标题（居中、加粗）
    setFont(ctx, true, IMG_TITLE_FS);
    ctx.fillStyle = '#17181d';
    ctx.textAlign = 'center';
    titleLines.forEach((ln, i) => {
      const text = ln.map(f => f.t).join('');
      ctx.fillText(text, IMG_W / 2, IMG_PAD + IMG_TITLE_FS + i * IMG_TITLE_LH);
    });
    ctx.textAlign = 'left';
    y = IMG_PAD + titleLines.length * IMG_TITLE_LH + 24;

    // 双方头像 + 名字（左右各占一半，外侧对齐）
    // 左侧
    drawAvatar(ctx, avL, IMG_PAD + IMG_AV / 2, y, IMG_AV);
    setFont(ctx, true, 14);
    ctx.fillStyle = '#23252b';
    ctx.fillText(doc.settings.left.name || '左角色', IMG_PAD + IMG_AV + 12, y + IMG_AV / 2 + 5);
    // 右侧
    const nameR = doc.settings.right.name || '右角色';
    setFont(ctx, true, 14);
    const rw = ctx.measureText(nameR).width;
    drawAvatar(ctx, avR, IMG_W - IMG_PAD - IMG_AV / 2, y, IMG_AV);
    ctx.fillText(nameR, IMG_W - IMG_PAD - IMG_AV - 12 - rw, y + IMG_AV / 2 + 5);
    // 分隔线
    y += IMG_AV + 20;
    ctx.strokeStyle = 'rgba(0,0,0,.1)';
    ctx.beginPath();
    ctx.moveTo(IMG_PAD, y); ctx.lineTo(IMG_W - IMG_PAD, y);
    ctx.stroke();
    y += IMG_BUBBLE_TOP;   // 分割线与首条气泡拉开间距

    // 对话气泡
    bubbles.forEach(b => {
      let bw = 0;
      b.lines.forEach(ln => {
        let lw = 0; ln.forEach(f => { lw += f.w; });
        bw = Math.max(bw, lw);
      });
      bw += IMG_BUB_PAD_X * 2;
      bw = Math.min(bw, IMG_BUB_MAX + IMG_BUB_PAD_X * 2);
      const isL = b.side === 'L';
      const bx = isL ? IMG_PAD : IMG_W - IMG_PAD - bw;
      roundRect(ctx, bx, y, bw, b.h, 16);
      ctx.fillStyle = isL ? '#ffffff' : '#22242b';
      ctx.fill();
      // 逐行绘制文字
      b.lines.forEach((ln, li) => {
        const baseY = y + IMG_BUB_PAD_Y + IMG_FS + li * IMG_LH;
        let fx = bx + IMG_BUB_PAD_X;
        ln.forEach(f => {
          setFont(ctx, f.bold, IMG_FS);
          ctx.fillStyle = isL ? '#1b1d22' : '#e9eaee';
          ctx.fillText(f.t, fx, baseY);
          if (f.under) {
            ctx.strokeStyle = isL ? '#1b1d22' : '#e9eaee';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(fx, baseY + 3); ctx.lineTo(fx + f.w, baseY + 3);
            ctx.stroke();
          }
          fx += f.w;
        });
      });
      y += b.h + 12;
    });

    return await new Promise(res => {
      cv.toBlob(blob => res(blob), 'image/png');   // PNG 无损，文字边缘清晰
    });
  }

  /* ============================================================
     Word：生成真正的 .docx（OOXML + ZIP），图片以二进制内嵌，
     Word / WPS 均可直接打开并显示头像
     ============================================================ */

  /* CRC32 */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* 仅存储（不压缩）打包 ZIP */
  function zipStore(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const dosTime = 0, dosDate = 0x21 << 9; // 固定日期 1980-01-01
    files.forEach(f => {
      const nameBytes = enc.encode(f.name);
      const data = f.bytes;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);           // UTF-8 文件名
      lh.setUint16(8, 0, true);                // store
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      const lhBytes = new Uint8Array(lh.buffer);
      chunks.push(lhBytes, nameBytes, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0); ch.setUint16(32, 0); ch.setUint16(34, 0); ch.setUint16(36, 0);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
      offset += lhBytes.length + nameBytes.length + data.length;
    });
    const cdStart = offset;
    let cdSize = 0;
    central.forEach(c => { cdSize += c.length; });
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdStart, true);
    return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  /* 把含 <b><u><br> 的片段转成 OOXML runs */
  function runsXml(html, align) {
    let bold = false, under = false, out = '';
    const flush = (text, br) => {
      if (br) { out += '<w:r><w:br/></w:r>'; return; }
      if (!text) return;
      let rpr = '<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>';
      if (bold) rpr += '<w:b/><w:bCs/>';
      if (under) rpr += '<w:u w:val="single"/>';
      out += `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
    };
    const tokens = normHtml(html).split(/(<\/?[bu]>|<br\s*\/?>)/gi).filter(t => t !== '');
    let buf = '';
    tokens.forEach(tk => {
      const low = tk.toLowerCase();
      const isTag = low === '<b>' || low === '</b>' || low === '<u>' || low === '</u>';
      if (isTag) {
        flush(buf); buf = '';              // 格式状态变化前先冲刷已有文本
        if (low === '<b>') bold = true;
        else if (low === '</b>') bold = false;
        else if (low === '<u>') under = true;
        else if (low === '</u>') under = false;
      } else if (/^<br/i.test(low)) {
        flush(buf); buf = ''; flush('', true);
      } else buf += tk;
    });
    flush(buf);
    if (!out) {
      out = '<w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/></w:rPr>'
          + '<w:t xml:space="preserve">&#160;</w:t></w:r>';
    }
    return out;
  }
  function paraXml(html, align) {
    const jc = align === 'right' ? 'right' : (align === 'center' ? 'center' : 'left');
    return `<w:p><w:pPr><w:jc w:val="${jc}"/>`
      + '<w:spacing w:before="40" w:after="120" w:line="410" w:lineRule="auto"/></w:pPr>'
      + runsXml(html) + '</w:p>';
  }
  /* 带水平边框的空段落（分割线） */
  function borderParaXml(sz, color, before, after) {
    return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>`
      + `<w:pBdr><w:bottom w:val="single" w:sz="${sz}" w:space="1" w:color="${color}"/></w:pBdr></w:pPr></w:p>`;
  }
  function cellXml(width, inner, gridSpan) {
    const span = gridSpan ? `<w:gridSpan w:val="${gridSpan}"/>` : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span}<w:vAlign w:val="center"/></w:tcPr>${inner}</w:tc>`;
  }
  /* 内嵌图片 drawing 标记 */
  function drawingXml(rid) {
    const EMU = 762000; // 80px
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="60"/></w:pPr><w:r><w:drawing>`
      + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
      + `<wp:extent cx="${EMU}" cy="${EMU}"/>`
      + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
      + '<wp:docPr id="' + rid.replace('rId', '') + '" name="Pic' + rid + '"/>'
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + '<pic:nvPicPr><pic:cNvPr id="0" name="avatar"/><pic:cNvPicPr/></pic:nvPicPr>'
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU}" cy="${EMU}"/></a:xfrm>`
      + '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></pic:spPr>'
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  function nameParaXml(name) {
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="40"/></w:pPr>`
      + '<w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:bCs/></w:rPr>'
      + `<w:t xml:space="preserve">${esc(name || ' ')}</w:t></w:r></w:p>`;
  }

  async function buildWordBlob(doc) {
    const s = doc.settings;
    // 头像转内嵌图片
    const imgs = [];
    async function headCell(side, width) {
      const av = await resolveAvatar(s[side].avatar);
      let inner = '';
      if (av) {
        const rid = 'rId' + (100 + imgs.length);
        const ext = av.mime.includes('png') ? 'png' : 'jpeg';
        imgs.push({ rid, ext, bytes: b64ToBytes(av.b64) });
        inner += drawingXml(rid);
      } else {
        inner += '<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>';
      }
      inner += nameParaXml(s[side].name);
      return cellXml(width, inner);
    }
    const W = 4513;
    const headRow = `<w:tr>${await headCell('left', W)}${await headCell('right', W)}</w:tr>`;
    // 名称与正文：加粗分割线 + 上下拉开间距
    const sepRow = `<w:tr>${cellXml(W * 2, borderParaXml(16, '777777', 260, 260), 2)}</w:tr>`;

    const sorted = [...doc.lines].sort((a, b) => a.row - b.row);
    let bodyRows = '';
    sorted.forEach((line, i) => {
      // 右栏内容放在右侧栏内，但文字同样左对齐
      const p = paraXml(normHtml(line.html), 'left');
      if (line.side === 'L') {
        bodyRows += `<w:tr>${cellXml(W, p)}${cellXml(W, '<w:p/>')}</w:tr>`;
      } else {
        bodyRows += `<w:tr>${cellXml(W, '<w:p/>')}${cellXml(W, p)}</w:tr>`;
      }
      if (i < sorted.length - 1) {
        bodyRows += `<w:tr>${cellXml(W * 2, borderParaXml(4, 'DCDFE4', 90, 90), 2)}</w:tr>`;
      }
    });

    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<w:body>'
      + `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>`
      + '<w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:bCs/><w:sz w:val="36"/></w:rPr>'
      + `<w:t>${esc(doc.title)}</w:t></w:r></w:p>`
      + '<w:tbl><w:tblPr><w:tblW w:w="9026" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
      + '<w:tblBorders><w:top w:val="none" w:sz="0" w:color="auto"/><w:left w:val="none" w:sz="0" w:color="auto"/>'
      + '<w:bottom w:val="none" w:sz="0" w:color="auto"/><w:right w:val="none" w:sz="0" w:color="auto"/>'
      + '<w:insideH w:val="none" w:sz="0" w:color="auto"/><w:insideV w:val="none" w:sz="0" w:color="auto"/></w:tblBorders>'
      + '</w:tblPr>'
      + `<w:tblGrid><w:gridCol w:w="${W}"/><w:gridCol w:w="${W}"/></w:tblGrid>`
      + headRow + sepRow + bodyRows + '</w:tbl>'
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
      + '</w:sectPr></w:body></w:document>';

    // 关系与内容类型
    const rels = imgs.map(im =>
      `<Relationship Id="${im.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${im.rid}.${im.ext}"/>`
    ).join('');
    const docRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + rels + '</Relationships>';
    const rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';
    const defaults = ['rels|application/vnd.openxmlformats-package.relationships+xml',
      'xml|application/xml', 'jpeg|image/jpeg', 'png|image/png']
      .map(([e, c]) => `<Default Extension="${e}" ContentType="${c}"/>`).join('');
    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + defaults
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>';

    const enc = new TextEncoder();
    const files = [
      { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
      { name: '_rels/.rels', bytes: enc.encode(rootRels) },
      { name: 'word/_rels/document.xml.rels', bytes: enc.encode(docRels) },
      { name: 'word/document.xml', bytes: enc.encode(documentXml) },
      ...imgs.map(im => ({ name: `word/media/${im.rid}.${im.ext}`, bytes: im.bytes }))
    ];
    return zipStore(files);
  }
  function exportWord(doc) {
    return buildWordBlob(doc).then(blob => downloadBlob(blob, doc.title + '.docx'));
  }

  /* ---------- PDF（打印另存；头像全部为 <img>，等图片解码后再打印） ---------- */
  async function buildPrintHtml(doc, autoPrint) {
    const s = doc.settings;
    const [avL, avR] = await Promise.all([
      resolveAvatar(s.left.avatar), resolveAvatar(s.right.avatar)
    ]);
    const imgTag = av => av
      ? `<div class="av"><img src="data:${av.mime};base64,${av.b64}"></div>`
      : '<div class="av empty"></div>';

    let body = '';
    [...doc.lines].sort((a, b) => a.row - b.row).forEach(line => {
      body += `<div class="row"><div class="cell l">${line.side === 'L' ? normHtml(line.html) : ''}</div>`
        + `<div class="cell r">${line.side === 'R' ? normHtml(line.html) : ''}</div></div><div class="rl"></div>`;
    });

    const printScript = autoPrint ? `
<script>
  window.onload=function(){
    var imgs=Array.prototype.slice.call(document.images);
    if(!imgs.length){ setTimeout(function(){window.print();},300); return; }
    var done=0;
    function fin(){ if(++done>=imgs.length) setTimeout(function(){window.print();},400); }
    imgs.forEach(function(im){
      if(im.complete && im.naturalWidth>0) fin();
      else { im.onload=fin; im.onerror=fin; }
    });
  };
<\/script>` : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>
  *{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#1a1c1f;margin:0;padding:46px 52px;}
  h1{text-align:center;font-size:20pt;margin:0 0 22px;}
  .head{display:flex;width:100%;align-items:flex-end;}
  .head .half{width:50%;display:flex;flex-direction:column;align-items:center;gap:11px;}
  .av{width:74px;height:74px;border-radius:50%;}
  .av img{width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;}
  .av.empty{visibility:hidden;}
  .nm{font-weight:700;font-size:12.5pt;min-height:20px;}
  .sep{width:100%;margin:26px 0 26px;border-top:2px solid #999;}
  .body{display:flex;flex-direction:column;}
  .row{display:flex;width:100%;min-height:2em;}
  .cell{width:50%;font-size:11pt;line-height:2.05;padding:8px 14px;word-break:break-word;white-space:pre-wrap;}
  .cell.l,.cell.r{text-align:left;}
  .rl{margin:2px 56px 0;border-top:1px solid #e0e2e7;}
  .body > .rl:last-child{display:none;}
  @media print{ body{padding:22px 30px;} }
</style></head><body>
<h1>${esc(doc.title)}</h1>
<div class="head">
  <div class="half">${imgTag(avL)}<div class="nm">${esc(s.left.name || '')}</div></div>
  <div class="half">${imgTag(avR)}<div class="nm">${esc(s.right.name || '')}</div></div>
</div>
<div class="sep"></div>
<div class="body">${body}</div>
${printScript}
</body></html>`;
  }

  async function exportPDF(doc) {
    /* App：交给原生用离屏 WebView 直接调系统打印，
       不在 App 内开预览窗口（预览页返回手势会直接退出 App） */
    if (window.WTNative && WTNative.printHtml) {
      const html = await buildPrintHtml(doc, false);
      WTNative.printHtml(doc.title, html);
      return;
    }
    const html = await buildPrintHtml(doc, true);
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  return { exportWord, exportPDF, buildWordBlob, buildImageBlob, downloadBlob };
})();
