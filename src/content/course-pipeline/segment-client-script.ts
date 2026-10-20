/**
 * 本地标注页面的**客户端脚本**（唯一一份，作为**原始文本**内联进单文件 HTML）。
 *
 * ── 为什么它必须单独成一个模块（F1 的根因）──
 *
 * 早先这段脚本是**外层模板字符串的一部分**。于是同一段源码里有**两层**转义：
 * TypeScript 先解析一层，浏览器再解析一层 —— 而作者只需要一层。
 * 后果是实测的阻断缺陷：`window.confirm("…\n" + …)` 里的 `\n` 在外层
 * 被消费成**真实换行**，于是**发给浏览器的**那段 JS 里字符串字面量
 * 被换行截断 ⇒ `new Function(script)` 抛 `SyntaxError` ⇒
 * 整页交互全死（"新建翻译单元"点了没反应），而 HTTP 仍然 200。
 *
 * 修法不是"把那几处补成 `\\n`"，而是**消除第二层转义**：
 *
 * - 这段脚本是 `String.raw` 的**原始文本**，工具链**逐字节**照发给浏览器；
 *   里面写的 `\n` 就是 JS 的换行转义，不会被 TypeScript 再解析一次。
 * - 它**不含任何插值**（`${…}` 一律禁止，由测试守）。因此不存在
 *   "把数据安全地嵌进脚本"这个问题 —— 数据根本不进脚本。
 * - 数据只经 `fetch('/api/bootstrap')` 以 **JSON** 取回，再用 `textContent`
 *   写进 DOM。**教材正文永远不进入 HTML 文档，也不进入可执行代码。**
 *
 * 这一条同时满足两个要求：客户端 JS 有**唯一一处**转义边界，
 * 且产出的脚本可被 JS 引擎机械地解析/执行（由 `tests/course-segment-tool.test.ts`
 * 与 `scripts/course-segment-smoke.ts` 的语法门禁守护）。
 *
 * ── 它**不**含什么 ──
 *
 * - 不含会话 token（token 经 URL **fragment** 交给页面，只在内存里）；
 * - 不含课程正文、不含计划内容、不含任何绝对路径；
 * - 不含 `console` 调用（终端输出会被记录进自动化上下文）；
 * - 不含任何外部资源引用。
 *
 * ── 这一版重写的是**交互模型**，不是数据契约 ──
 *
 * 使用者 第一次打开这个页面时看不懂它在干什么。因此这一版把界面从
 * "开发者标注控制台"改成**一条被引导的任务**：
 *
 * | 旧行为 | 新行为 |
 * | --- | --- |
 * | 需要先理解"单元 / 通道 / 家具 / 未指派" | 只有「新建一份练习」+「这一段属于什么」 |
 * | 先选行、再点通道按钮（且要 Shift+点击扩展） | 先点类别、再点第一行、再点最后一行 |
 * | 英文枚举名直接显示（`source`、`ignored_furniture`） | 一律中文产品语言，枚举名只留在不可见属性里 |
 * | `unassigned: 42` / `overlaps: 1` | 「还有 42 行没有处理」/「有 1 处内容被重复标记，需要处理」 |
 * | 报错说"重叠" | 「这几行已经被标成其他内容，请先取消原来的标记。」 |
 * | 校验和 / 坐标堆在侧栏 | 收进「高级信息」，证据一条不删 |
 *
 * **底层的选择器契约、覆盖率与重叠判定、fail-closed 语义完全没有改动** ——
 * 这一版只改"谁能看懂怎么用"。
 */

/**
 * 客户端脚本原文。
 *
 * 刻意用 `String.raw`：写完即所得，工具链不改写任何字符。
 * **禁止插值** —— 需要数据时走 `fetch`，不要往这里拼字符串。
 */
export const ANNOTATION_CLIENT_SCRIPT = String.raw`
"use strict";
(function () {
  var TOKEN_HEADER = "x-cet6-session-token";

  /*
   * ── 面向 使用者的词汇表 ──
   *
   * 内部通道名（source / reference_translation / notes /
   * ignored_furniture）**只**用于 data-channel 属性与提交给服务端的 JSON。
   * 任何**可见**位置都用这里的名字，使用者 永远不需要看到英文枚举名。
   */
  var CHANNEL_LABELS = {
    source: "中文原文",
    reference_translation: "课程参考译文",
    notes: "老师讲解 / 语言点",
    ignored_furniture: "页眉页脚（忽略）"
  };
  var CHANNEL_SHORT = {
    source: "原文",
    reference_translation: "参考译文",
    notes: "讲解",
    ignored_furniture: "页眉页脚"
  };
  var CHANNEL_ORDER = ["source", "reference_translation", "notes", "ignored_furniture"];

  function labelOf(channel) {
    return CHANNEL_LABELS[channel] || String(channel);
  }
  function shortOf(channel) {
    return CHANNEL_SHORT[channel] || String(channel);
  }

  /** 人话的单元名：**永远不暴露内部 unit id**。 */
  function unitName(index) {
    return "第 " + (index + 1) + " 份练习";
  }

  /*
   * ── token 来自 URL **fragment**，且立刻从地址栏抹掉 ──
   *
   * fragment（# 之后）**不会**随请求发给服务器（见 RFC 3986 / WHATWG URL）：
   * 它只存在于浏览器本地。因此 token 不会出现在服务端请求目标里，
   * 也就不会进访问日志、Referer 或任何服务端记录。
   *
   * 读完立刻 replaceState 抹掉它：视觉上不再可见，也不再留在当前历史条目里
   * （避免被肩窥或随后手工复制粘贴时泄露）。
   */
  var token = null;
  try {
    var hash = window.location.hash || "";
    if (hash.charAt(0) === "#") hash = hash.slice(1);
    var parts = hash.split("&");
    for (var i = 0; i < parts.length; i += 1) {
      var kv = parts[i].split("=");
      if (kv[0] === "token" && kv.length === 2 && kv[1]) { token = decodeURIComponent(kv[1]); break; }
    }
  } catch (error) { token = null; }

  // 立刻把 fragment 从可见地址与当前历史条目里移除
  if (window.location.hash) {
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    catch (error) { /* 尽力而为；失败也不影响安全语义（fragment 本来就不发给服务器） */ }
  }

  // ── 界面状态 ──
  var boot = null;
  var assets = [];
  var units = [];
  var activeUnit = -1;      // 当前正在标的那份练习
  var pendingChannel = null; // 已选类别（等待点第一行/最后一行）
  var anchor = null;         // 已选的起点 { assetKey, page, line }
  var hoverLine = -1;        // 起点之后的悬停预览
  var selectedMark = null;   // 当前选中的那条已标记录 { unit, assignment }
  var undoStack = [];        // 撤销栈（快照）
  var savedDigest = "";      // 最近一次保存成功后的计划校验和
  var dirty = false;
  var saving = false;

  var MAX_UNDO = 50;

  function el(id) { return document.getElementById(id); }

  function setBanner(kind, text) {
    var b = el("banner");
    if (!b) return;
    b.className = text ? "banner " + kind : "";
    b.textContent = text || "";
  }

  function fatal(text) {
    setBanner("err", text);
    document.body.classList.remove("onboarding-open");
    var doc = el("doc");
    if (doc) doc.textContent = "";
    var save = el("save");
    if (save) save.disabled = true;
    var nu = el("newUnit");
    if (nu) nu.disabled = true;
    var g = el("guideAction");
    if (g) g.textContent = "这个页面无法载入内容。请回到终端重新打开标注地址。";
  }

  if (!token) {
    fatal("这个页面缺少本次会话的凭据。请使用终端里打印出来的**完整标注地址**（它以 #token=… 结尾）。");
    return;
  }

  /*
   * ── 私有引导数据走**带 token 请求头的 JSON API** ──
   *
   * 页面本身（GET /）是**静态外壳**：它不含课程正文、不含 token、
   * 不含计划内容、不含源绝对路径。因此一个本机其他进程即使取到页面，
   * 也拿不到任何私有内容，更拿不到写计划所需的能力。
   */
  fetch("/api/bootstrap", { headers: { "x-cet6-session-token": token } })
    .then(function (response) {
      if (response.status === 403) throw new Error("凭据无效或已过期（服务可能已重启）。");
      if (!response.ok) throw new Error("载入失败：HTTP " + response.status);
      return response.json();
    })
    .then(function (payload) {
      boot = payload;
      assets = payload.assets || [];
      restoreExistingPlan(payload.existingPlan);
      renderDocument();
      refresh();
      el("newUnit").disabled = false;
      /*
       * ── 引导成功后 Save **必须**变为可用 ──
       *
       * Save 的初始态是**禁用**（数据未载入时不该能保存，见下方
       * "save.disabled = true"），失败路径由 fatal() 保持禁用。
       * 因此**成功路径必须显式把它启用** —— 否则 Save 永远停在禁用态，
       * 整个标注流程走不完（实测：载入成功、可建单元、可指派，
       * 但点 Save 发不出任何请求）。
       *
       * 这里**不**复刻校验逻辑：Save 是否真的能写盘，仍由点击处理器里的
       * 既有检查（有无练习 / 每份是否有原文 / 有无重叠 / 未处理行确认）
       * 与**服务端 + 计划校验器**共同决定。浏览器只负责让控件可达。
       */
      document.getElementById("save").disabled = false;
      if (assets.length === 0) setBanner("err", "没有可以标注的内容。请先在终端重新抽取这份讲义。");
      else setBanner("info", "内容已经载入。按上面的提示一步步来就行。");
    })
    .catch(function (error) {
      fatal("无法载入内容：" + (error && error.message ? error.message : "未知错误"));
    });

  /*
   * ── Save 的三态（唯一状态机）──
   *
   *   1. 载入中        ⇒ **禁用**（就在这一行：fetch 的 then 回调是异步的，
   *                       因此它在本行之后才可能执行）；
   *   2. 引导失败      ⇒ **保持禁用**（fatal() 负责）；
   *   3. 引导成功      ⇒ **启用**（上面的成功回调负责）。
   *
   * 这三处必须同时成立：少任何一处，Save 要么永远不可用，
   * 要么在数据未就绪时就能点。
   */
  el("save").disabled = true;

  // ── 撤销栈 ──
  function snapshot() {
    return JSON.parse(JSON.stringify({ units: units, activeUnit: activeUnit }));
  }

  /** 在任何**会改变标注**的操作之前压栈。 */
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  function restoreExistingPlan(existingPlan) {
    if (!existingPlan || !Array.isArray(existingPlan.units)) return;
    units = existingPlan.units.map(function (u, index) {
      return {
        title: String(u.title || unitName(index)),
        kind: "translation_passage",
        assignments: (u.assignments || []).map(function (a) {
          var r = a.range || {};
          return {
            channel: String(a.channel), assetKey: String(r.assetKey),
            page: Number(r.page), lineStart: Number(r.lineStart), lineEnd: Number(r.lineEnd),
            note: a.note == null ? null : String(a.note)
          };
        })
      };
    });
    if (units.length > 0) activeUnit = 0;
    if (existingPlan.author) el("author").value = String(existingPlan.author);
    if (existingPlan.reason) el("reason").value = String(existingPlan.reason);
  }

  // ── 渲染讲义（**正文只经 textContent 进入 DOM**）──
  function renderDocument() {
    var docEl = el("doc");
    docEl.textContent = "";
    assets.forEach(function (asset) {
      var head = document.createElement("div");
      head.className = "meta";
      head.style.margin = "10px 0 6px";
      head.textContent = "这份讲义：" + asset.label;
      docEl.appendChild(head);

      asset.pages.forEach(function (page) {
        var box = document.createElement("div");
        box.className = "page" + (page.hasTextLayer ? "" : " no-text");
        var ph = document.createElement("div");
        ph.className = "page-head";
        var left = document.createElement("span");
        left.textContent = "第 " + page.page + " 页";
        var right = document.createElement("span");
        right.textContent = page.hasTextLayer ? (page.lines.length + " 行") : "这一页没有可选的文字";
        ph.appendChild(left); ph.appendChild(right);
        box.appendChild(ph);

        (page.lines || []).forEach(function (text, index) {
          var lineEl = document.createElement("div");
          lineEl.className = "line";
          lineEl.dataset.asset = asset.assetKey;
          lineEl.dataset.page = String(page.page);
          lineEl.dataset.line = String(index + 1);

          var no = document.createElement("span");
          no.className = "no";
          no.textContent = String(index + 1);

          var mark = document.createElement("span");
          mark.className = "mark";

          var tx = document.createElement("span");
          tx.className = "tx";
          tx.textContent = text;

          lineEl.appendChild(no);
          lineEl.appendChild(mark);
          lineEl.appendChild(tx);

          lineEl.addEventListener("click", function () {
            onLineClick(asset.assetKey, page.page, index + 1);
          });
          /* 起点选完之后，鼠标划过的范围**先给预览** —— 让人在点最后一行之前
             就能看见"将要被标成什么"，不必猜。 */
          lineEl.addEventListener("mouseover", function () {
            if (anchor === null) return;
            if (anchor.assetKey !== asset.assetKey || anchor.page !== page.page) return;
            if (hoverLine === index + 1) return;
            hoverLine = index + 1;
            paintSelection();
          });
          box.appendChild(lineEl);
        });
        docEl.appendChild(box);
      });
    });
  }

  // ── 「这一段属于什么？」：先点类别，再点第一行，再点最后一行 ──
  function onLineClick(assetKey, page, line) {
    if (pendingChannel === null) {
      /*
       * 没选类别时点行：
       * - 若这一行**已经被标过**，就选中那条记录，让人可以直接取消或改标；
       * - 否则明确告诉人"得先选一个类别" —— 不让人自己猜。
       */
      var key = assetKey + "|" + page + "|" + line;
      var stats = computeStats();
      var existing = stats.claim[key];
      if (existing) {
        selectMark(existing.unit, existing.assignment);
        setBanner("info", "这几行已经标成「" + labelOf(existing.channel) + "」了。可以点「取消这个标记」，或先选一个类别再重新标。");
        refresh();
        return;
      }
      setBanner("err", "请先在右边选一个类别（例如「中文原文」），再点这一段的第一行。");
      refresh();
      return;
    }

    if (activeUnit < 0) {
      setBanner("err", "请先新建一份翻译练习，再来标内容。");
      refresh();
      return;
    }

    if (anchor === null) {
      anchor = { assetKey: assetKey, page: page, line: line };
      hoverLine = line;
      clearMarkSelection();
      setBanner("info", "已选起点，再点这一段的最后一行。");
      refresh();
      return;
    }

    if (anchor.assetKey !== assetKey || anchor.page !== page) {
      // 选区只在**同一页**内成立（计划的选择器就是"第几页第几行"）
      anchor = { assetKey: assetKey, page: page, line: line };
      hoverLine = line;
      clearMarkSelection();
      setBanner("info", "选区不能跨页。已把起点改到这一页，请再点这一段的最后一行。");
      refresh();
      return;
    }

    var from = Math.min(anchor.line, line);
    var to = Math.max(anchor.line, line);
    applyRange(pendingChannel, assetKey, page, from, to);
  }

  function applyRange(channel, assetKey, page, from, to) {
    pushUndo();
    units[activeUnit].assignments.push({
      channel: channel, assetKey: assetKey, page: page,
      lineStart: from, lineEnd: to, note: null
    });
    dirty = true;
    savedDigest = "";
    anchor = null;
    hoverLine = -1;
    pendingChannel = null;
    clearMarkSelection();
    var where = "第 " + page + " 页 · 第 " + from + (from === to ? "" : " 到 " + to) + " 行";
    setBanner("ok", "「" + labelOf(channel) + "」已标记（" + where + "）。");
    refresh();
  }

  function selectMark(unitIndex, assignment) {
    selectedMark = { unit: unitIndex, assignment: assignment };
  }

  function clearMarkSelection() {
    selectedMark = null;
  }

  /** 删除当前选中的那条标记（或指定的那一条）。 */
  function removeAssignment(unitIndex, assignment) {
    var list = units[unitIndex] ? units[unitIndex].assignments : null;
    if (!list) return false;
    var at = list.indexOf(assignment);
    if (at < 0) return false;
    pushUndo();
    list.splice(at, 1);
    dirty = true;
    savedDigest = "";
    clearMarkSelection();
    setBanner("ok", "这个标记已经取消。");
    refresh();
    return true;
  }

  function undo() {
    if (undoStack.length === 0) {
      setBanner("info", "没有可以撤销的操作了。");
      refresh();
      return;
    }
    var previous = undoStack.pop();
    units = previous.units;
    activeUnit = previous.activeUnit;
    if (activeUnit >= units.length) activeUnit = units.length - 1;
    anchor = null;
    hoverLine = -1;
    pendingChannel = null;
    clearMarkSelection();
    dirty = true;
    savedDigest = "";
    setBanner("ok", "已经撤销上一步。");
    refresh();
  }

  // ── 进度与问题（**本地预演**）──
  /*
   * 页面上算的是**预览**；保存时服务端与重新抽取会各自用权威实现独立再算一次。
   * 页面算错不会让错误的计划生效。
   *
   * 重叠判据与权威实现一致：**同一行只要被指派两次就算冲突**，
   * 包括同一份练习同一类别（那会让内容在正文里重复）。
   */
  function computeStats() {
    var all = [];
    assets.forEach(function (asset) {
      asset.pages.forEach(function (page) {
        if (!page.hasTextLayer) return;
        for (var i = 1; i <= page.lines.length; i++) all.push(asset.assetKey + "|" + page.page + "|" + i);
      });
    });
    var claim = {};
    var overlapKeys = [];
    var counts = { source: 0, reference_translation: 0, notes: 0, ignored_furniture: 0 };
    units.forEach(function (unit, ui) {
      unit.assignments.forEach(function (a) {
        var asset = assets.find(function (x) { return x.assetKey === a.assetKey; });
        if (!asset) return;
        var page = asset.pages.find(function (p) { return p.page === a.page; });
        if (!page || !page.hasTextLayer) return;
        for (var i = a.lineStart; i <= a.lineEnd; i++) {
          if (i < 1 || i > page.lines.length) continue;
          var key = a.assetKey + "|" + a.page + "|" + i;
          if (claim[key] !== undefined) {
            if (overlapKeys.indexOf(key) < 0) overlapKeys.push(key);
            claim[key].conflict = true;
            claim[key].conflictChannels = [claim[key].channel, a.channel];
          } else {
            claim[key] = { channel: a.channel, unit: ui, assignment: a };
            counts[a.channel] = (counts[a.channel] || 0) + 1;
          }
        }
      });
    });
    var unassigned = all.filter(function (k) { return claim[k] === undefined; });
    var unitsWithoutSource = [];
    units.forEach(function (u, index) {
      var has = u.assignments.filter(function (a) { return a.channel === "source"; }).length >= 1;
      if (!has) unitsWithoutSource.push(index);
    });
    return {
      total: all.length, counts: counts, overlapKeys: overlapKeys, unassigned: unassigned,
      unitsWithoutSource: unitsWithoutSource, claim: claim,
      hasSource: units.length > 0 && unitsWithoutSource.length === 0
    };
  }

  /** 把内部坐标翻成 使用者 看得懂的定位文字。 */
  function locationText(key) {
    var pieces = String(key).split("|");
    return "第 " + pieces[1] + " 页 · 第 " + pieces[2] + " 行";
  }

  // ── 「当前该做什么」：这是整个引导的核心 ──
  function guideFor(stats) {
    if (boot === null) {
      return { where: "正在载入", action: "正在读取这份讲义，请稍等。" };
    }
    if (assets.length === 0) {
      return { where: "当前：没有内容", action: "这份讲义没有抽取出可标注的文字，请回到终端重新抽取。" };
    }
    if (units.length === 0) {
      return { where: "当前：还没有翻译练习", action: "请先点下面的「+ 新建一份翻译练习」。" };
    }
    if (activeUnit < 0) {
      return { where: "当前：还没选中练习", action: "请在下面点一下要标的那份练习。" };
    }

    var where = "当前：" + unitName(activeUnit);
    var unit = units[activeUnit];

    if (anchor !== null) {
      return { where: where, action: "已选起点，再点这一段的最后一行。" };
    }
    if (pendingChannel !== null) {
      return {
        where: where,
        action: "请选择「" + labelOf(pendingChannel) + "」：先点这一段的第一行，再点最后一行。"
      };
    }
    if (selectedMark !== null) {
      var marked = selectedMark.assignment;
      return {
        where: where,
        action: "这几行标的是「" + labelOf(marked.channel) + "」。可以点「取消这个标记」，也可以先选别的类别再重新标。"
      };
    }
    if (stats.overlapKeys.length > 0) {
      return {
        where: where,
        action: "有几行被标了两次。请点那几行，再用「取消这个标记」去掉多余的一条。"
      };
    }

    // 推荐下一个类别：原文 → 参考译文 → 讲解 → 页眉页脚
    var missing = null;
    for (var i = 0; i < CHANNEL_ORDER.length; i += 1) {
      var channel = CHANNEL_ORDER[i];
      var used = unit.assignments.some(function (a) { return a.channel === channel; });
      if (!used) { missing = channel; break; }
    }
    if (missing !== null) {
      var extra = "";
      if (missing === "reference_translation") extra = "如果这份练习没有参考译文，可以跳过。";
      if (missing === "notes") extra = "没有讲解也可以跳过。";
      if (missing === "ignored_furniture") extra = "没有页眉页脚就可以跳过。";
      return {
        where: where,
        action: "接下来标「" + labelOf(missing) + "」：先在上面点它，再点第一行和最后一行。" + extra
      };
    }
    if (stats.unassigned.length > 0) {
      return {
        where: where,
        action: "这份练习还有 " + stats.unassigned.length + " 行没有处理。请继续标，或者把不是正文的行标成「页眉页脚（忽略）」。"
      };
    }
    return { where: where, action: "这份练习已经全部标好了。点「检查并保存」提交，或点「完成这份练习，开始下一份」。" };
  }

  // ── 渲染 ──
  function refresh() {
    var stats = computeStats();

    // 1) 逐行上色 + **文字标签**（不靠颜色单独表意）
    Array.prototype.forEach.call(document.querySelectorAll(".line"), function (lineEl) {
      var key = lineEl.dataset.asset + "|" + lineEl.dataset.page + "|" + lineEl.dataset.line;
      lineEl.className = "line";
      lineEl.style.outline = "";
      var mark = lineEl.querySelector(".mark");
      mark.className = "mark";
      mark.textContent = "";

      var c = stats.claim[key];
      if (c) {
        lineEl.classList.add(c.channel);
        lineEl.classList.add("marked");
        mark.classList.add(c.channel);
        mark.textContent = shortOf(c.channel);
      } else if (stats.total > 0) {
        lineEl.classList.add("unassigned");
      }
      if (c && c.conflict) lineEl.classList.add("overlap");
    });

    // 2) 当前选中的那条标记（**先**画"正在选"的预览，再叠加选中态，
    //    否则 paintSelection 的清理会把选中态的描边一起抹掉）
    paintSelection();
    if (selectedMark !== null) {
      var list = units[selectedMark.unit] ? units[selectedMark.unit].assignments : [];
      if (list.indexOf(selectedMark.assignment) < 0) clearMarkSelection();
      else paintRange(selectedMark.assignment, "picked", "2px solid #1b1a17");
    }

    // 3) 「当前该做什么」
    var guide = guideFor(stats);
    el("guideWhere").textContent = guide.where;
    el("guideAction").textContent = guide.action;

    // 4) 进度：只用人的话，不出现 unassigned / overlap 这类词
    var progress = el("progress");
    progress.textContent = "";
    var handled = stats.total - stats.unassigned.length;
    var bar = document.createElement("div");
    bar.className = "progress-bar";
    var fill = document.createElement("span");
    var ratio = stats.total === 0 ? 0 : Math.round((handled / stats.total) * 100);
    fill.style.width = ratio + "%";
    bar.appendChild(fill);
    progress.appendChild(bar);

    var headline = document.createElement("div");
    /*
     * ── 「还有 N 行没有处理」是**进度**，不是**错误** ──
     *
     * 早先这里在"还有未处理行"时加 bad（红色）。实测截图证明那会让人
     * 一打开页面就以为"东西坏了" —— 而"还没标完"是流程中的正常状态。
     *
     * 因此：进度行只在**全部处理好**时用绿色（good）；
     * "还有 N 行"用中性文字色。**红色只留给真的冲突**（重复标记），
     * 那一条在下面单独渲染。
     */
    headline.className = "progress-line " + (stats.unassigned.length === 0 ? "good" : "");
    headline.textContent = stats.total === 0
      ? "没有可处理的内容"
      : (stats.unassigned.length === 0
        ? "全部 " + stats.total + " 行都处理好了"
        : "还有 " + stats.unassigned.length + " 行没有处理");
    progress.appendChild(headline);

    var sub = document.createElement("div");
    sub.className = "progress-sub";
    sub.textContent = "已处理 " + handled + " / " + stats.total + " 行 · 共 " + units.length + " 份练习";
    progress.appendChild(sub);

    if (stats.overlapKeys.length > 0) {
      var ov = document.createElement("div");
      ov.className = "progress-line bad";
      ov.textContent = "有 " + stats.overlapKeys.length + " 处内容被重复标记，需要处理";
      progress.appendChild(ov);
    }

    // 5) 问题：**人话**，并给出下一步动作
    var issues = el("issues");
    issues.textContent = "";
    if (stats.overlapKeys.length > 0) {
      var d2 = document.createElement("div");
      d2.className = "issue";
      d2.textContent = "这几行已经被标成其他内容，请先取消原来的标记。";
      issues.appendChild(d2);
      var list2 = document.createElement("div");
      list2.className = "hint";
      list2.textContent = stats.overlapKeys.slice(0, 8).map(locationText).join("、") +
        (stats.overlapKeys.length > 8 ? " 等" : "");
      issues.appendChild(list2);
    }
    stats.unitsWithoutSource.forEach(function (index) {
      var d3 = document.createElement("div");
      d3.className = "issue";
      d3.textContent = unitName(index) + " 还没有标「中文原文」。每一份练习至少要有原文。";
      issues.appendChild(d3);
    });

    // 6) 练习列表
    var unitList = el("units");
    unitList.textContent = "";
    units.forEach(function (unit, index) {
      var box = document.createElement("div");
      box.className = "unit" + (index === activeUnit ? " armed" : "");

      var h = document.createElement("h4");
      var input = document.createElement("input");
      input.type = "text";
      input.value = unit.title;
      input.addEventListener("input", function () { unit.title = input.value; dirty = true; });
      input.addEventListener("blur", function () {
        // 空的练习名对 使用者 没有意义，也会让保存被服务端拒绝 —— 直接恢复默认名
        if (String(unit.title).trim() === "") { unit.title = unitName(index); input.value = unit.title; }
      });
      h.appendChild(input);
      box.appendChild(h);

      if (unit.assignments.length === 0) {
        var empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "还没有标任何内容。";
        box.appendChild(empty);
      }

      unit.assignments.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "assign" + (selectedMark !== null && selectedMark.assignment === a ? " picked" : "");
        var left = document.createElement("span");
        var chip = document.createElement("span");
        chip.className = "chip " + a.channel;
        chip.textContent = labelOf(a.channel);
        left.appendChild(chip);
        left.appendChild(document.createTextNode(
          " 第 " + a.page + " 页 · 第 " + a.lineStart + (a.lineStart === a.lineEnd ? "" : " 到 " + a.lineEnd) + " 行"
        ));
        var rm = document.createElement("button");
        rm.className = "small danger";
        rm.textContent = "取消标记";
        rm.addEventListener("click", function () { removeAssignment(index, a); });
        row.appendChild(left); row.appendChild(rm);
        box.appendChild(row);
      });

      var btn = document.createElement("button");
      btn.className = "small";
      btn.textContent = index === activeUnit ? "✓ 正在标这一份" : "改标这一份";
      btn.addEventListener("click", function () {
        activeUnit = index;
        pendingChannel = null;
        anchor = null;
        hoverLine = -1;
        clearMarkSelection();
        setBanner("info", "现在标的是" + unitName(index) + "。");
        refresh();
      });
      box.appendChild(btn);
      unitList.appendChild(box);
    });

    // 7) 四类按钮状态
    var noUnit = activeUnit < 0;
    Array.prototype.forEach.call(document.querySelectorAll("#channelBtns button"), function (b) {
      b.disabled = noUnit;
      b.dataset.on = (pendingChannel === b.dataset.channel) ? "1" : "0";
    });

    // 8) 撤销 / 取消 / 取消标记
    el("undo").disabled = undoStack.length === 0;
    el("cancelPick").disabled = (anchor === null && pendingChannel === null && selectedMark === null);
    el("unmark").disabled = selectedMark === null;
    el("nextUnit").disabled = false;

    // 9) 保存按钮与提示
    /*
     * save.disabled **刻意不在这里设置**。
     *
     * Save 的可达性是一个**三态状态机**（载入中禁用 / 引导失败保持禁用 /
     * 引导成功启用），而那三处分别在别的地方：
     * el("save").disabled = true（初始）、fatal()、以及引导成功回调里
     * 那一行显式启用。若在这里（每次 refresh）也顺手启用它，那么
     * "成功回调忘了启用 Save"这个**实测发生过的阻断缺陷**就会被这行
     * 掩盖 —— 变异测试 M19 也就抓不到它了。
     */
    var save = el("save");
    save.textContent = saving ? "正在检查并保存…" : "检查并保存";
    el("saveHint").textContent = savedDigest !== ""
      ? "已经保存好了。"
      : (stats.overlapKeys.length > 0
        ? "有几处内容被重复标记，先处理掉才能保存。"
        : "把每一行都标好之后，点这里保存。");

    el("saveState").textContent = savedDigest !== ""
      ? "● 已保存"
      : (dirty ? "● 有还没保存的修改" : "");
    el("loadState").textContent = boot === null ? "" : "内容已载入";

    // 10) 高级信息：**证据一条不删**，只是收起来
    renderAdvanced(stats);

    // 11) 取消全部「已选」时把状态说清楚
    document.body.dataset.picking = anchor !== null ? "1" : "0";
  }

  function paintRange(range, cls, outline) {
    for (var i = range.lineStart; i <= range.lineEnd; i += 1) {
      var lineEl = document.querySelector(
        '.line[data-asset="' + cssEscape(range.assetKey) + '"][data-page="' + range.page + '"][data-line="' + i + '"]'
      );
      if (!lineEl) continue;
      if (cls) lineEl.classList.add(cls);
      if (outline) lineEl.style.outline = outline;
    }
  }

  /** 画"正在选"的预览：起点 + 悬停终点构成的闭区间。 */
  function paintSelection() {
    Array.prototype.forEach.call(document.querySelectorAll(".line.picked, .line.anchor"), function (lineEl) {
      lineEl.classList.remove("picked");
      lineEl.classList.remove("anchor");
      /* 只清掉"正在选"这一层描边；已标记录选中态的描边由 paintRange 重画 */
      lineEl.style.outline = "";
    });
    if (anchor === null) return;
    var to = hoverLine > 0 ? hoverLine : anchor.line;
    var from = Math.min(anchor.line, to);
    var last = Math.max(anchor.line, to);
    for (var i = from; i <= last; i += 1) {
      var lineEl = document.querySelector(
        '.line[data-asset="' + cssEscape(anchor.assetKey) + '"][data-page="' + anchor.page + '"][data-line="' + i + '"]'
      );
      if (!lineEl) continue;
      lineEl.classList.add("picked");
    }
    var anchorEl = document.querySelector(
      '.line[data-asset="' + cssEscape(anchor.assetKey) + '"][data-page="' + anchor.page + '"][data-line="' + anchor.line + '"]'
    );
    if (anchorEl) anchorEl.classList.add("anchor");
  }

  function renderAdvanced(stats) {
    var body = el("advancedBody");
    body.textContent = "";
    if (boot === null) return;

    function row(label, value) {
      var div = document.createElement("div");
      div.className = "adv-row";
      div.textContent = label + "：" + value;
      body.appendChild(div);
    }

    row("课程 id", String(boot.courseId));
    row("源摘要", String(boot.sourceDigest));
    assets.forEach(function (asset) {
      row("资产", asset.assetKey + " · 校验和 " + String(asset.sha256));
    });
    el("planDigest").textContent = savedDigest === ""
      ? "尚未保存过计划"
      : "计划校验和：" + savedDigest;

    var coords = [];
    units.forEach(function (unit, index) {
      unit.assignments.forEach(function (a) {
        coords.push(unitName(index) + " · " + a.channel + " · " + a.assetKey +
          " p" + a.page + ":" + a.lineStart + "-" + a.lineEnd);
      });
    });
    row("已标记行数", String(stats.total - stats.unassigned.length) + " / " + String(stats.total));
    row("坐标清单", coords.length === 0 ? "（空）" : coords.slice(0, 60).join("；"));
  }

  function cssEscape(value) { return String(value).replace(/["\\]/g, "\\$&"); }

  /*
   * ── 页内确认：**不用 window.confirm** ──
   *
   * 原生 confirm 会冻结整个页面，且样式/文案无法与页面一致；
   * 更重要的是它在自动化测试里无法被真实点击驱动。这里用页内面板，
   * 保持"一次只有一个需要决定的问题"。
   */
  function askConfirm(message, yesText, noText) {
    return new Promise(function (resolve) {
      var box = el("confirmBox");
      box.textContent = "";
      box.hidden = false;
      var p = document.createElement("div");
      p.className = "confirm-line";
      p.textContent = message;
      box.appendChild(p);
      var row = document.createElement("div");
      row.className = "row";
      var yes = document.createElement("button");
      yes.className = "primary";
      yes.textContent = yesText;
      yes.addEventListener("click", function () { box.hidden = true; box.textContent = ""; resolve(true); });
      var no = document.createElement("button");
      no.textContent = noText;
      no.addEventListener("click", function () { box.hidden = true; box.textContent = ""; resolve(false); });
      row.appendChild(yes); row.appendChild(no);
      box.appendChild(row);
    });
  }

  // ── 控件绑定 ──
  el("startAnnotating").addEventListener("click", function () {
    document.body.classList.remove("onboarding-open");
    refresh();
  });

  el("help").addEventListener("click", function () {
    document.body.classList.add("onboarding-open");
  });

  el("newUnit").addEventListener("click", function () {
    pushUndo();
    units.push({ title: unitName(units.length), kind: "translation_passage", assignments: [] });
    activeUnit = units.length - 1;
    pendingChannel = null;
    anchor = null;
    hoverLine = -1;
    clearMarkSelection();
    dirty = true;
    savedDigest = "";
    setBanner("info", unitName(activeUnit) + " 已经建好。现在在上面选一个类别，再点第一行和最后一行。");
    refresh();
  });

  el("nextUnit").addEventListener("click", function () {
    pushUndo();
    units.push({ title: unitName(units.length), kind: "translation_passage", assignments: [] });
    activeUnit = units.length - 1;
    pendingChannel = null;
    anchor = null;
    hoverLine = -1;
    clearMarkSelection();
    dirty = true;
    savedDigest = "";
    setBanner("info", "已开始 " + unitName(activeUnit) + "。");
    refresh();
  });

  el("cancelPick").addEventListener("click", function () {
    anchor = null;
    hoverLine = -1;
    pendingChannel = null;
    clearMarkSelection();
    setBanner("info", "已经取消当前的选择。");
    refresh();
  });

  el("undo").addEventListener("click", undo);

  el("unmark").addEventListener("click", function () {
    if (selectedMark === null) return;
    removeAssignment(selectedMark.unit, selectedMark.assignment);
  });

  /* Ctrl/Cmd+Z 也能撤销 —— 但只要焦点在输入框里就让浏览器自己处理 */
  window.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (String(event.key).toLowerCase() !== "z") return;
    var target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    event.preventDefault();
    undo();
  });

  Array.prototype.forEach.call(document.querySelectorAll("#channelBtns button"), function (b) {
    b.addEventListener("click", function () {
      if (activeUnit < 0) {
        setBanner("err", "请先新建一份翻译练习，再来标内容。");
        return;
      }
      pendingChannel = b.dataset.channel;
      anchor = null;
      hoverLine = -1;
      clearMarkSelection();
      setBanner("info", "已选「" + labelOf(pendingChannel) + "」。请点这一段的第一行。");
      refresh();
    });
  });

  el("save").addEventListener("click", function () {
    if (saving) return;
    if (!boot) { setBanner("err", "内容还没载入完成，请稍等。"); return; }
    var stats = computeStats();
    if (units.length === 0) {
      setBanner("err", "请先新建一份翻译练习，标好内容之后再保存。");
      el("guideAction").textContent = "请先点下面的「+ 新建一份翻译练习」。";
      return;
    }
    if (!stats.hasSource) {
      setBanner("err", "每一份练习都必须至少标一段「中文原文」。请先补上。");
      focusUnit(stats.unitsWithoutSource[0]);
      return;
    }
    if (stats.overlapKeys.length > 0) {
      setBanner("err", "这几行已经被标成其他内容，请先取消原来的标记，再保存。");
      scrollToKey(stats.overlapKeys[0]);
      return;
    }

    var steps = Promise.resolve(true);
    if (stats.unassigned.length > 0) {
      var warning = "还有 " + stats.unassigned.length + " 行没有处理。\n" +
        "现在保存的话，这份练习会缺少这些内容。";
      steps = steps.then(function (go) {
        if (!go) return false;
        return askConfirm(warning, "仍然保存", "回去继续标");
      });
    }
    if (boot.existingPlan && boot.existingPlan.units) {
      steps = steps.then(function (go) {
        if (!go) return false;
        return askConfirm(
          "这个位置已经有一份保存过的分段计划。\n现在保存会把它替换掉。",
          "替换并保存",
          "先不保存"
        );
      });
    }

    steps.then(function (go) {
      if (!go) {
        setBanner("info", "已取消保存。可以继续标注。");
        return;
      }
      saving = true;
      refresh();
      setBanner("info", "正在检查并保存…");
      fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cet6-session-token": token },
        body: JSON.stringify({
          author: el("author").value || "owner",
          reason: el("reason").value || "",
          units: units.map(function (unit, index) {
            return {
              title: String(unit.title).trim() === "" ? unitName(index) : unit.title,
              kind: "translation_passage",
              assignments: unit.assignments
            };
          })
        })
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, body: j }; });
      }).then(function (result) {
        saving = false;
        if (result.body && result.body.ok) {
          dirty = false;
          savedDigest = result.body.planDigest ? String(result.body.planDigest) : "";
          showDone();
          setBanner("ok", "已保存。");
          refresh();
        } else {
          // **绝不假装成功**：只按服务端回包判定
          var detail = (result.body && (result.body.error || result.body.detail)) || "未知原因";
          setBanner("err", "没能保存：" + plainFailure(detail));
          refresh();
        }
      }).catch(function () {
        saving = false;
        setBanner("err", "没能保存：和本地服务的连接中断了。请确认终端里的标注进程还在运行。");
        refresh();
      });
    });
  });

  /**
   * 把服务端/校验器返回的失败原因翻成 使用者 看得懂的话。
   *
   * 刻意**只做措辞映射**，不改判定 —— 权威校验仍然在服务端与计划校验器里，
   * 浏览器不复制一遍（两份实现必然漂移）。
   */
  function plainFailure(detail) {
    var text = String(detail);
    if (text.indexOf("plan_range_overlap") >= 0 || text.indexOf("重叠") >= 0) {
      return "有几行被标了两次。请点那几行，再用「取消这个标记」去掉多余的一条。";
    }
    if (text.indexOf("plan_unassigned_content") >= 0) {
      return "还有内容没有处理完。请把剩下的行也标上类别。";
    }
    if (text.indexOf("plan_unit_source_count") >= 0 || text.indexOf("plan_unit_title_missing") >= 0) {
      return "每一份练习都要有名字，并且至少标一段「中文原文」。";
    }
    if (text.indexOf("stale") >= 0 || text.indexOf("陈旧") >= 0) {
      return "这份讲义的内容变过了，刚才的标记已经对不上了。请回到终端重新打开标注地址。";
    }
    if (text.indexOf("plan_range_line_out_of_bounds") >= 0 || text.indexOf("plan_range_page_out_of_bounds") >= 0) {
      return "有标记落在了不存在的位置。请取消那几条标记重新标一次。";
    }
    return text;
  }

  function focusUnit(index) {
    if (index === undefined || index === null) return;
    activeUnit = index;
    refresh();
  }

  function scrollToKey(key) {
    var pieces = String(key).split("|");
    var lineEl = document.querySelector(
      '.line[data-asset="' + cssEscape(pieces[0]) + '"][data-page="' + pieces[1] + '"][data-line="' + pieces[2] + '"]'
    );
    if (lineEl && lineEl.scrollIntoView) lineEl.scrollIntoView({ block: "center" });
  }

  /** 成功之后：**只留一件要做的事** —— 关掉这个页面，回去说一声。 */
  function showDone() {
    var done = el("done");
    done.textContent = "";
    done.hidden = false;

    var title = document.createElement("div");
    title.className = "done-title";
    title.textContent = "✓ 已保存";

    var close = document.createElement("div");
    close.className = "done-close";
    close.textContent = "现在可以关闭这个页面。";

    var next = document.createElement("div");
    next.className = "done-next";
    next.textContent = "回到 ChatGPT 告诉我：“翻译分段已保存”。";

    done.appendChild(title);
    done.appendChild(close);
    done.appendChild(next);

    /*
     * ── 成功面板**必须真的出现在眼前**（实测截图证明的缺陷）──
     *
     * 「检查并保存」按钮在侧栏**底部**，而成功面板在侧栏**顶部**。
     * 使用者 点完保存时侧栏多半已经滚到了底部 —— 于是成功提示渲染在
     * 视野之外，看起来像"点了没反应"。这正是最坏的一类反馈失败：
     * 保存其实成功了，人却以为没成。
     *
     * 因此这里显式把侧栏滚回顶部，并把成功面板滚进视野。
     * scrollIntoView 在极老的浏览器里可能不存在，因此先判存在。
     */
    var aside = document.querySelector("aside");
    if (aside) aside.scrollTop = 0;
    if (typeof done.scrollIntoView === "function") done.scrollIntoView({ block: "start" });
  }

  window.addEventListener("beforeunload", function (event) {
    if (dirty) { event.preventDefault(); event.returnValue = ""; }
  });
})();
`;
