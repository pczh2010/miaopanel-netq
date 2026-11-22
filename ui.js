/* netq — 网络质量（纯前端，无服务端依赖、无需编译）
 * 全部测量在浏览器里完成，结果留在浏览器内。
 */
(function () {
  "use strict";

  /* ------------------------------------------------------- 测点定义
   * cors: 该端点返回 Access-Control-Allow-Origin:*，浏览器能读到确切耗时
   * 其余端点走 no-cors，只能计时到"响应到达"，精度略低但仍可用
   */
  var CN_NODES = [
    { name: "阿里云 DoH", url: "https://dns.alidns.com/resolve?name=qq.com&type=A", cors: true },
    { name: "腾讯 DoH", url: "https://doh.pub/dns-query?name=qq.com&type=A", cors: false },
    { name: "百度", url: "https://hm.baidu.com/hm.js", cors: false },
    { name: "阿里云 CDN", url: "https://res.dnsv1.com/", cors: false }
  ];
  var INT_NODES = [
    { name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query?name=qq.com&type=A", cors: true },
    { name: "jsDelivr", url: "https://cdn.jsdelivr.net/npm/vue@3/package.json", cors: true }
  ];

  /* ------------------------------------------------------- 工具 */
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; }
  function ms(v) { return v == null || v < 0 ? "—" : (v < 10 ? v.toFixed(1) : Math.round(v)) + " ms"; }
  function mbps(v) { return v == null || v <= 0 ? "—" : v.toFixed(1) + " Mbps"; }
  function pct(v) { return v == null ? "—" : (v * 100).toFixed(0) + "%"; }
  function colorOf(v) { if (v == null || v < 0) return "#e74c3c"; if (v > 250) return "#e74c3c"; if (v > 120) return "#f39c12"; return "#2ecc71"; }

  function timedOnce(node, timeoutMs) {
    var start = performance.now();
    var opt = node.cors
      ? { url: node.url, opts: { cache: "no-store" } }
      : { url: node.url, opts: { cache: "no-store", mode: "no-cors" } };
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    var o = Object.assign({}, opt.opts);
    if (ctl) o.signal = ctl.signal;
    return fetch(opt.url, o).then(function () {
      clearTimeout(timer);
      return performance.now() - start;
    }).catch(function () {
      clearTimeout(timer);
      return -1;
    });
  }

  // 多次采样：返回 {median, jitter, loss, samples}
  function sample(node, rounds, timeoutMs) {
    var seq = Promise.resolve(), got = [], fail = 0;
    for (var i = 0; i < rounds; i++) {
      seq = seq.then(function () { return timedOnce(node, timeoutMs); }).then(function (v) {
        if (v < 0) fail++; else got.push(v);
      });
    }
    return seq.then(function () {
      if (!got.length) return { median: -1, jitter: -1, loss: 1, n: 0 };
      var s = got.slice().sort(function (a, b) { return a - b; });
      var med = s[Math.floor(s.length / 2)];
      var spam = s[s.length - 1] - s[0];
      return { median: med, jitter: spam, loss: fail / rounds, n: got.length };
    });
  }

  function panelRTT(rounds) {
    var api = (window.__MP_PLUGIN_API__ || "/api/v1/plugins/netq/api");
    var got = [], seq = Promise.resolve();
    for (var i = 0; i < rounds; i++) {
      seq = seq.then(function () {
        var t = performance.now();
        return fetch(api + "/healthz", { cache: "no-store", mode: "cors" })
          .then(function () { got.push(performance.now() - t); })
          .catch(function () {});
      });
    }
    return seq.then(function () {
      if (!got.length) return -1;
      got.sort(function (a, b) { return a - b; });
      return got[Math.floor(got.length / 2)];
    });
  }

  /* ------------------------------------------------------- 下行测速
   * 优先从面板同源接口取流；面板不给时退化为不可测（不报假数）
   */
  function measureDown(bytes) {
    var api = (window.__MP_PLUGIN_API__ || "/api/v1/plugins/netq/api");
    var start = performance.now(), got = 0;
    return fetch(api + "/dl?bytes=" + bytes, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok || !r.body || !r.body.getReader) return 0;
        var rd = r.body.getReader();
        function pump() {
          return rd.read().then(function (x) {
            if (x.done) return got;
            got += x.value.length;
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        var secs = (performance.now() - start) / 1000;
        if (got < 50000 || secs <= 0.05) return 0;
        return (got * 8) / secs / 1e6;
      })
      .catch(function () { return 0; });
  }

  /* ------------------------------------------------------- 线路判断 */
  function judgeLine(mine, cnResults, intResults) {
    var best = cnResults.filter(function (r) { return r.median >= 0; })
      .sort(function (a, b) { return a.median - b.median; })[0];
    if (!best) return { tag: "无法判断", desc: "国内测点全部不可达，可能被墙或本地网络受限。", color: "#8899a6" };
    if (mine < 0) return { tag: "无法判断", desc: "到面板本身无响应。", color: "#8899a6" };

    var lossAvg = cnResults.reduce(function (s, r) { return s + r.loss; }, 0) / cnResults.length;
    var jitterAvg = cnResults.filter(function (r) { return r.jitter >= 0; })
      .reduce(function (s, r) { return s + r.jitter; }, 0) / Math.max(1, cnResults.filter(function (r) { return r.jitter >= 0; }).length);

    if (lossAvg > 0.34)
      return { tag: "连通性差", desc: "国内多个测点大量丢包，可能是被限速、被墙或出口拥塞。", color: "#e74c3c" };
    if (mine > 300 || best.median > 400)
      return { tag: "远距离绕路特征", desc: "延迟明显偏高。常见于海外低价 VPS 走非优化国际线路，带宽可能很大但体验不稳。", color: "#e74c3c" };
    if (mine < 100 && jitterAvg < 12 && lossAvg < 0.05)
      return { tag: "优化线路特征", desc: "低延迟、低抖动、少丢包。符合 CN2/优化中转这类线路的表现。", color: "#2ecc71" };
    if (jitterAvg > 50 || lossAvg > 0.1)
      return { tag: "普通线路 + 明显抖动", desc: "延迟可能还行，但抖动或丢包偏大。这是普通宽带或拥塞国际线路的典型特征。", color: "#f39c12" };
    if (mine < 200)
      return { tag: "常规机房/云主机", desc: "延迟与抖动都在正常范围，没有明显专线特征，也没有明显劣化。", color: "#4a9eff" };
    return { tag: "中等质量国际线路", desc: "延迟偏高但稳定，属于常见的国际中转。", color: "#f39c12" };
  }

  /* ------------------------------------------------------- 视图 */
  function section(title, sub) {
    var root = el("div");
    root.style.cssText = "background:var(--mp-bg-card,#1b222c);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px 16px;margin-bottom:12px";
    var t = el("div", "", title);
    t.style.cssText = "font-size:12px;color:#8899a6;margin-bottom:2px";
    root.appendChild(t);
    if (sub) {
      var s = el("div", "", sub);
      s.style.cssText = "font-size:11px;color:#5f6d7a;margin-bottom:10px";
      root.appendChild(s);
    } else {
      t.style.marginBottom = "12px";
    }
    var body = el("div");
    root.appendChild(body);
    return { root: root, body: body };
  }
  function card(label, unit) {
    var box = el("div");
    var l = el("div", "", label); l.style.cssText = "font-size:11px;color:#8899a6;margin-bottom:2px";
    var v = el("span", "", "—"); v.style.cssText = "font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.4px";
    var u = el("span", "", unit ? " " + unit : ""); u.style.cssText = "font-size:11px;font-weight:400;color:#8899a6";
    box.appendChild(l); box.appendChild(v); box.appendChild(u);
    return { box: box, value: v };
  }
  function grid(n) { var g = el("div"); g.style.cssText = "display:grid;grid-template-columns:repeat(" + n + ",1fr);gap:12px"; return g; }
  function btn(text) {
    var b = el("button", "", text);
    b.style.cssText = "padding:6px 14px;border-radius:7px;border:1px solid rgba(74,158,255,.4);background:rgba(74,158,255,.12);color:var(--mp-primary,#4a9eff);font-size:12px;cursor:pointer";
    b.onmouseenter = function () { b.style.background = "rgba(74,158,255,.22)"; };
    b.onmouseleave = function () { b.style.background = "rgba(74,158,255,.12)"; };
    return b;
  }
  function nodeRow(name, cors) {
    var line = el("div");
    line.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:rgba(255,255,255,.03);border-radius:7px;margin-bottom:6px";
    var l = el("span", "", name);
    l.style.cssText = "font-size:12px;color:#aab7c4";
    if (!cors) {
      var tag = el("span", "", " 计时");
      tag.style.cssText = "font-size:10px;color:#5f6d7a;border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:0 4px;margin-left:6px";
      l.appendChild(tag);
    }
    var v = el("span", "", "—");
    v.style.cssText = "font-variant-numeric:tabular-nums;font-size:13px;color:#8899a6";
    line.appendChild(l); line.appendChild(v);
    return { line: line, value: v };
  }

  function build() {
    var root = el("div");
    root.style.cssText = "padding:16px;font:13px/1.6 -apple-system,'Segoe UI',system-ui,sans-serif;color:var(--mp-text,#dfe7ef);max-width:960px";

    var head = el("div");
    head.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:14px";
    var h = el("h2", "", "网络质量"); h.style.cssText = "margin:0;font-size:16px;font-weight:600";
    var go = btn("开始检测");
    head.appendChild(h);
    var badge = el("span", "", "v" + VERSION);
    badge.style.cssText = "font-size:10px;color:#5f6d7a;border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:1px 5px;margin-left:-2px";
    head.appendChild(badge); head.appendChild(go);
    root.appendChild(head);

    // ① 线路判断
    var verdict = section("线路判断", "");
    var vbox = el("div");
    vbox.style.cssText = "padding:12px 14px;border-radius:8px;background:rgba(255,255,255,.03);border-left:3px solid #8899a6";
    var vtag = el("div", "", "未检测"); vtag.style.cssText = "font-size:15px;font-weight:600;margin-bottom:3px";
    var vdesc = el("div", "", "点「开始检测」，大约 15 秒出结果"); vdesc.style.cssText = "font-size:12px;color:#8899a6;line-height:1.6";
    vbox.appendChild(vtag); vbox.appendChild(vdesc);
    verdict.body.appendChild(vbox);
    root.appendChild(verdict.root);

    // ② 我的连接
    var mine = section("我的连接 · 浏览器 ⇄ 服务器", "");
    var mg = grid(3);
    var mDown = card("下行", "Mbps"), mLat = card("延迟", "ms"), mLoss = card("丢包", "");
    mg.appendChild(mDown.box); mg.appendChild(mLat.box); mg.appendChild(mLoss.box);
    mine.body.appendChild(mg);
    root.appendChild(mine.root);

    // ③ 中国大陆
    var cn = section("中国大陆到服务器", "用你的浏览器实际访问这些节点，延迟越低说明你所在网络到国内越通畅");
    var cnMap = {};
    CN_NODES.forEach(function (n) { var r = nodeRow(n.name, n.cors); cnMap[n.name] = r.value; cn.body.appendChild(r.line); });
    root.appendChild(cn.root);

    // ④ 国际对照
    var intl = section("国际对照", "和上面比一比：国内明显快于国际，说明线路对大陆有优化");
    var intlMap = {};
    INT_NODES.forEach(function (n) { var r = nodeRow(n.name, n.cors); intlMap[n.name] = r.value; intl.body.appendChild(r.line); });
    root.appendChild(intl.root);

    // ⑤ 历史
    var hist = section("检测历史", "本页打开后每次检测的记录，刷新即清空");
    var list = el("div");
    list.style.cssText = "max-height:180px;overflow:auto;font-size:12px;color:#8899a6";
    hist.body.appendChild(list);
    root.appendChild(hist.root);

    var foot = el("div", "", "全部测量在你的浏览器里完成，不上传任何数据。线路判断是基于延迟/抖动/丢包特征的推断，不能替代 AS 路径或 MTR 的线路认定。");
    foot.style.cssText = "margin-top:6px;font-size:11px;line-height:1.7;color:#5f6d7a;border-top:1px dashed rgba(255,255,255,.08);padding-top:10px";
    root.appendChild(foot);

    go.onclick = function () { run(go, { mDown: mDown, mLat: mLat, mLoss: mLoss, cnMap: cnMap, intlMap: intlMap, vtag: vtag, vdesc: vdesc, vbox: vbox, list: list }); };
    return { root: root, runBtn: go, refs: { mDown: mDown, mLat: mLat, mLoss: mLoss, cnMap: cnMap, intlMap: intlMap, vtag: vtag, vdesc: vdesc, vbox: vbox, list: list } };
  }

  /* ------------------------------------------------------- 执行一次完整检测 */
  function run(btn, R) {
    btn.disabled = true; btn.textContent = "检测中…";
    R.vtag.textContent = "检测中…"; R.vtag.style.color = "#8899a6";
    R.vdesc.textContent = "正在采样，约 15 秒";
    Object.keys(R.cnMap).forEach(function (k) { R.cnMap[k].textContent = "…"; });
    Object.keys(R.intlMap).forEach(function (k) { R.intlMap[k].textContent = "…"; });

    // 先测面板往返（最直接反映"你到服务器"）
    var panelP = panelRTT(8);
    var downP = measureDown(2000000);
    var cnP = Promise.all(CN_NODES.map(function (n) { return sample(n, 4, 6000).then(function (r) { r.node = n; return r; }); }));
    var intlP = Promise.all(INT_NODES.map(function (n) { return sample(n, 3, 6000).then(function (r) { r.node = n; return r; }); }));

    return Promise.all([panelP, downP, cnP, intlP]).then(function (res) {
      var panelRtt = res[0], down = res[1], cnRes = res[2], intlRes = res[3];

      // 渲染各节点
      cnRes.forEach(function (r) {
        var v = R.cnMap[r.node.name];
        if (!v) return;
        v.textContent = ms(r.median) + (r.loss > 0 ? " · 丢 " + pct(r.loss) : "");
        v.style.color = colorOf(r.median);
      });
      intlRes.forEach(function (r) {
        var v = R.intlMap[r.node.name];
        if (!v) return;
        v.textContent = ms(r.median) + (r.loss > 0 ? " · 丢 " + pct(r.loss) : "");
        v.style.color = colorOf(r.median);
      });

      // 我的连接
      R.mDown.value.textContent = down > 0 ? down.toFixed(1) : "—";
      R.mDown.value.style.color = down > 0 ? "#dfe7ef" : "#8899a6";
      R.mLat.value.textContent = panelRtt >= 0 ? Math.round(panelRtt) : "—";
      R.mLat.value.style.color = colorOf(panelRtt);
      var cnLoss = cnRes.reduce(function (s, r) { return s + r.loss; }, 0) / cnRes.length;
      R.mLoss.value.textContent = pct(cnLoss);
      R.mLoss.value.style.color = cnLoss > 0.2 ? "#e74c3c" : cnLoss > 0.05 ? "#f39c12" : "#2ecc71";

      // 线路判断
      var v = judgeLine(panelRtt, cnRes, intlRes);
      R.vtag.textContent = v.tag;
      R.vtag.style.color = v.color;
      R.vdesc.textContent = v.desc;
      R.vbox.style.borderLeftColor = v.color;

      // 历史
      var best = cnRes.filter(function (r) { return r.median >= 0; }).sort(function (a, b) { return a.median - b.median; })[0];
      var t = new Date();
      var stamp = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2) + ":" + ("0" + t.getSeconds()).slice(-2);
      var row = el("div", "", stamp + "  ·  " + v.tag + "  ·  面板 " + (panelRtt >= 0 ? Math.round(panelRtt) + "ms" : "—") +
        "  ·  最快国内 " + (best ? best.node.name + " " + Math.round(best.median) + "ms" : "—") +
        "  ·  下行 " + (down > 0 ? down.toFixed(1) + "Mbps" : "—"));
      row.style.cssText = "padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)";
      row.style.color = v.color;
      R.list.insertBefore(row, R.list.firstChild);
      while (R.list.childNodes.length > 30) R.list.removeChild(R.list.lastChild);

      btn.disabled = false; btn.textContent = "重新检测";
    }).catch(function () {
      btn.disabled = false; btn.textContent = "重新检测";
      R.vtag.textContent = "检测失败";
      R.vtag.style.color = "#e74c3c";
      R.vdesc.textContent = "部分测点不可达，换个网络环境或稍后再试。";
    });
  }

  /* ------------------------------------------------------- 挂载 */
  var unmountFn;
  function mount(container) {
    var v = build();
    container.innerHTML = "";
    container.appendChild(v.root);
    v.runBtn.click();
    unmountFn = function () { /* 纯前端：无定时器需要清理 */ };
    return unmountFn;
  }
  var api = { mount: function (c) { unmountFn = mount(c); return unmountFn; }, unmount: function () { if (unmountFn) unmountFn(); } };
  if (window.MiaoPanelPlugin && typeof window.MiaoPanelPlugin.register === "function") {
    window.MiaoPanelPlugin.register("netq", api);
  } else {
    window.netqPlugin = api;
    var auto = document.getElementById("mp-plugin-root") || document.getElementById("plugin-root");
    if (auto) mount(auto);
  }
})();
