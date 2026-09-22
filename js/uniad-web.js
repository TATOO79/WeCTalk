/*
 * UniAdWeb —— DCloud uni-ad H5 信息流广告的独立网页版加载器
 * 来源逻辑移植自 @dcloudio/uni-h5 运行时（端点 https://hac1.dcloud.net.cn/ah5v2）
 * 用法：UniAdWeb.mount(document.getElementById('xxx'), '广告位adpid')
 * 注意：仅用于 https 网页；不要放进 App WebView（广告平台不允许 web 广告出现在 app 内）
 */
(function (global) {
  'use strict';

  var CONFIG_URL = 'https://hac1.dcloud.net.cn/ah5v2';
  var REPORT_URL = 'https://has1.dcloud.net.cn/ahl';
  var CACHE_KEY = 'uni_app_ad_config';
  var CACHE_TIME = 10 * 60 * 1000;
  var PROVIDER_GDT = '2';      // 腾讯优量汇
  var PROVIDER_TUIA = '10035'; // DCloud 直投（图鸦素材）

  /* ---------------- 广告位配置（带本地缓存） ---------------- */
  var cache = null;
  try {
    var raw = global.localStorage && global.localStorage.getItem(CACHE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed.last && Date.now() - parsed.last <= CACHE_TIME) cache = parsed.data;
    }
  } catch (e) { cache = null; }

  function saveCache(data) {
    cache = data;
    try {
      global.localStorage && global.localStorage.setItem(
        CACHE_KEY, JSON.stringify({ last: Date.now(), data: data }));
    } catch (e) {}
  }

  function fetchConfig(adpid) {
    if (cache) return Promise.resolve(cache);
    var ctrl = global.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { ctrl && ctrl.abort(); }, 8000);
    var q = CONFIG_URL + '?d=' + encodeURIComponent(global.location.hostname) +
            '&a=' + encodeURIComponent(adpid);
    return fetch(q, { signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        clearTimeout(timer);
        if (res.ret !== 0) throw new Error(res.msg || ('配置错误 ' + res.ret));
        saveCache(res.data);
        return res.data;
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }

  /* ---------------- 三方 SDK 脚本加载（每种 provider 只加载一次） ---------------- */
  var scriptState = {}; // providerId: 'loading' | 'done'

  function loadProviderScript(providerId, attrs) {
    if (scriptState[providerId] === 'done') return Promise.resolve();
    if (scriptState[providerId] === 'loading') {
      return new Promise(function (resolve, reject) {
        var iv = setInterval(function () {
          if (scriptState[providerId] === 'done') { clearInterval(iv); resolve(); }
        }, 100);
        setTimeout(function () { clearInterval(iv); reject(new Error('脚本加载超时')); }, 10000);
      });
    }
    scriptState[providerId] = 'loading';
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.id = 'uniad_provider' + providerId;
      if (attrs) Object.keys(attrs).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      s.onload = function () { scriptState[providerId] = 'done'; resolve(); };
      s.onerror = function () { delete scriptState[providerId]; reject(new Error('广告SDK加载失败')); };
      document.body.appendChild(s);
    });
  }

  /* ---------------- 曝光/事件上报（失败静默，不影响展示） ---------------- */
  function report(adpid, type, providerId) {
    try {
      var img = new Image();
      var q = REPORT_URL + '?d=' + encodeURIComponent(global.location.hostname) +
              '&a=' + encodeURIComponent(adpid) + '&at=' + type +
              (providerId ? '&t=' + encodeURIComponent(providerId) : '');
      img.src = q;
    } catch (e) {}
  }

  function randomId() {
    var t = '';
    for (var i = 0; i < 4; i++) {
      t += ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
    }
    return '_u' + t;
  }

  /* ---------------- 具体渠道渲染 ---------------- */

  // 腾讯优量汇：原生图文，NATIVE.renderAd 渲染到指定 id 的容器
  function renderGdt(container, provider, slot, adpid, next) {
    var viewId = randomId();
    var view = document.createElement('div');
    view.id = viewId; view.className = viewId;
    container.innerHTML = '';
    container.appendChild(view);

    global.TencentGDT = global.TencentGDT || [];
    global.TencentGDT.push({
      placement_id: slot.a3,
      app_id: slot.a2,
      type: 'native',
      count: 1,
      onComplete: function (ads) {
        if (ads && ads.constructor === Array && ads.length > 0) {
          global.TencentGDT.NATIVE.renderAd(ads[0], viewId);
          report(adpid, 40, PROVIDER_GDT);
        } else {
          next();
        }
      }
    });

    // 5 秒内未渲染出有效高度 → 尝试下一条
    var checks = 0, timer = setInterval(function () {
      checks++;
      var ok = container.children.length > 0 && container.clientHeight > 40;
      if (ok) { clearInterval(timer); report(adpid, 40, PROVIDER_GDT); }
      else if (checks >= 5) { clearInterval(timer); next(); }
    }, 1000);
  }

  // DCloud 直投（图鸦）：先展示素材图，点击后调起落地页
  function renderTuia(container, provider, slot, adpid, next) {
    var url;
    if (Object.prototype.toString.call(slot.imgs) === '[object Array]') {
      var valid = slot.imgs.filter(function (x) { return typeof x === 'string' && x; });
      if (valid.length) url = valid[Math.floor(Math.random() * valid.length)];
    }
    if (!url && typeof slot.img === 'string') url = slot.img;
    if (!url) { next(); return; }

    var img = document.createElement('img');
    img.src = url; img.alt = '广告';
    img.setAttribute('draggable', 'false');
    img.style.cssText = 'width:100%;height:auto;display:block;cursor:pointer';
    img.onerror = next;
    img.onclick = function () {
      var tuia = global.TuiaSDKLite;
      if (!tuia || typeof tuia.execute !== 'function') return;
      tuia.execute({
        data: {
          pid: slot.a3,
          fail_message: 'ad load fail',
          product_name: document.title || global.location.hostname
        },
        success: function () {},
        fail: function () {}
      });
    };
    container.innerHTML = '';
    container.appendChild(img);
    report(adpid, 40, PROVIDER_TUIA);
  }

  /* ---------------- 对外 API ---------------- */

  function mount(el, adpid) {
    if (!el || !adpid) return;
    el.innerHTML = '';
    el.style.display = 'none';

    fetchConfig(adpid).then(function (config) {
      var providers = config.a || {};
      var groups = config.b || [];
      var slots = groups[0] || [];

      function tryIndex(i) {
        if (i >= slots.length) { el.style.display = 'none'; return; }
        var slot = slots[i];
        if (!slot) { tryIndex(i + 1); return; }
        var pid = String(slot.a1);
        var provider = providers[pid];
        var script = provider && (provider.script || provider.s);
        if (!provider) { tryIndex(i + 1); return; }

        loadProviderScript(pid, script).then(function () {
          el.style.display = 'block';
          if (pid === PROVIDER_GDT) {
            renderGdt(el, provider, slot, adpid, function () { tryIndex(i + 1); });
          } else if (pid === PROVIDER_TUIA) {
            renderTuia(el, provider, slot, adpid, function () { tryIndex(i + 1); });
          } else {
            tryIndex(i + 1); // 未知渠道，跳过
          }
        }).catch(function () { tryIndex(i + 1); });
      }
      tryIndex(0);
    }).catch(function () { el.style.display = 'none'; });
  }

  function unmount(el) {
    if (el) el.innerHTML = '';
  }

  global.UniAdWeb = { mount: mount, unmount: unmount };
})(window);
