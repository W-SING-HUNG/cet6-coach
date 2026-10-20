/**
 * A1 只读检查工作台 · **客户端脚本**（唯一一份，作为**原始文本**内联）。
 *
 * ── 它为什么单独成模块（与 `segment-client-script.ts` 同一条理由）──
 *
 * 脚本被内联进单文件 HTML。若它写在页面的模板字符串里，同一段源码就会有
 * **两层转义**：TypeScript 先解析一层，浏览器再解析一层 —— 而作者只需要一层。
 * 实测过的后果是整页交互全死（`\n` 在外层被消费 ⇒ 发给浏览器的 JS
 * 字符串字面量被换行截断 ⇒ 引擎抛 `SyntaxError`），而 HTTP 仍然 200。
 *
 * 因此：`String.raw` 原文 + **禁止插值**。
 * - 里面写的 `\n` 就是 JS 的换行转义，不会被 TypeScript 再解析一次；
 * - 数据只经 `fetch` 以 **JSON** 取回，再用 `textContent` 写进 DOM。
 *   **课程正文与路径永远不进入 HTML 文档，也不进入可执行代码。**
 *
 * 由 `tests/course-segment-tool.test.ts` 的**源码级**断言守护
 * （模板体里不得出现反引号或 `${`）—— 必须是源码级，因为模板一旦被
 * 提前终结，对常量取值的断言会恒真。
 *
 * ── 它**不含**什么 ──
 *
 * - 不含会话 token（token 经 URL **fragment** 交进来，只在内存里）；
 * - 不含课程正文、计划内容、任何绝对路径；
 * - 不含 `console` 调用（终端输出会被记录进自动化上下文）；
 * - 不含任何外部资源引用、任何绝对 URL。
 *
 * ── 三条产品纪律（面向不懂这套架构的 使用者）──
 *
 * 1. **只读必须看得见。** 页头常驻「只读 · 不会修改或保存任何东西」，
 *    而且**根本不存在**保存 / 导入按钮 —— A1 的能力边界不是靠文案声明的。
 * 2. **每一步都能回答"我看到什么 / 该怎么办"。** 冲突与警告一律同时给出
 *    原因与处置（`recovery` 字段），绝不只丢一个错误码。
 * 3. **不确定就说不确定。** "未匹配"、"等价性未验证"、"库不完整"
 *    都如实显示，绝不折成一个看起来确定的结论。
 *
 * ── 键盘与读屏 ──
 *
 * 每个可交互元素都是原生 `<button>` 或 `<input type="checkbox">`，
 * 焦点样式由 CSS 的 `:focus-visible` 给出；状态变化经 `role="status"`
 * 的 live region 播报。加载中 / 错误 / 禁用三态都有明确文案。
 */

/**
 * 客户端脚本原文。
 *
 * 刻意用 `String.raw`：写完即所得。**禁止插值** —— 需要数据时走 fetch。
 */
export const INTAKE_CLIENT_SCRIPT = String.raw`
"use strict";
(function () {
  var TOKEN_HEADER = "x-cet6-session-token";
  var ENDPOINTS = {
    state: "/api/intake/state",
    browse: "/api/intake/browse",
    pick: "/api/intake/pick",
    inspect: "/api/intake/inspect"
  };

  /* ── 面向 使用者的词汇表（内部枚举名绝不进可见位置）── */
  var KIND_LABELS = {
    pdf: "PDF",
    docx: "Word 文档",
    audio: "音频",
    image: "图片",
    unsupported: "本版本不解析的类型"
  };
  var SEGMENT_KIND_LABELS = {
    reading_passage: "阅读材料",
    listening_conversation: "听力对话",
    listening_passage: "听力篇章",
    listening_recording: "听力讲座",
    translation_passage: "翻译练习",
    writing_template: "写作模板",
    method_note: "方法讲解"
  };
  var MATCH_LABELS = {
    strong_candidate: "证据较强",
    possible_candidate: "有可比证据",
    weak_candidate: "证据较弱",
    no_candidate: "无候选"
  };
  var ISSUE_LABELS = {
    rejected_path: "没有被读取的条目",
    empty_file: "空文件",
    duplicate_content: "内容重复",
    same_name_different_bytes: "同名但内容不同",
    unsupported_type: "本版本不解析的类型",
    extraction_failed: "PDF 解析失败",
    page_without_text_layer: "没有文字层的页",
    text_extraction_deferred: "Word 文档未被解析",
    grouping_invariant_violated: "分组出现自相矛盾",
    material_grouping_requires_review: "材料分组需要人工确认",
    no_segments_extracted: "没有产出课程段",
    match_ambiguous: "真题候选存在歧义",
    canonical_library_incomplete: "真题库不完整"
  };

  var MAX_TARGETS_PER_VIEW = 10;

  var token = null;
  var state = { hasSource: false, sourceLabel: null };
  var tree = null;
  var selectedDirs = {};
  var excludedFiles = {};
  var lastResult = null;
  var busy = false;
  var expanded = {};

  function el(id) { return document.getElementById(id); }

  function say(text) {
    var live = el("live");
    if (live) live.textContent = text || "";
  }

  function setNotice(container, kind, text, fix) {
    var host = el(container);
    if (!host) return;
    host.textContent = "";
    if (!text) return;
    var box = document.createElement("div");
    box.className = "notice " + kind;
    var p = document.createElement("div");
    p.textContent = text;
    box.appendChild(p);
    if (fix) {
      var q = document.createElement("div");
      q.className = "fix";
      q.textContent = "怎么办：" + fix;
      box.appendChild(q);
    }
    host.appendChild(box);
  }

  function textNode(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || isNaN(bytes)) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function pageRange(start, end) {
    if (start === null || start === undefined) return "未登记页码";
    if (end === null || end === undefined || end === start) return "第 " + start + " 页";
    return "第 " + start + "–" + end + " 页";
  }

  function segmentKindLabel(kind) {
    return SEGMENT_KIND_LABELS[kind] || "课程段";
  }

  function matchLabelLabel(label) {
    return MATCH_LABELS[label] || String(label);
  }

  /* ── token：从 URL fragment 读取并立刻抹掉（fragment 不发给服务器）── */
  try {
    var hash = window.location.hash || "";
    if (hash.charAt(0) === "#") hash = hash.slice(1);
    var parts = hash.split("&");
    for (var i = 0; i < parts.length; i += 1) {
      var kv = parts[i].split("=");
      if (kv[0] === "token" && kv.length === 2 && kv[1]) { token = decodeURIComponent(kv[1]); break; }
    }
  } catch (error) { token = null; }

  if (window.location.hash) {
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    catch (error) { /* 尽力而为；fragment 本来就不发给服务器 */ }
  }

  function setBusy(next, message) {
    busy = next;
    if (next && message) say(message);
    refreshControls();
  }

  function refreshControls() {
    var pickBtn = el("pick");
    if (pickBtn) pickBtn.disabled = busy;
    var change = el("changeDir");
    if (change) change.disabled = busy || !state.hasSource;
    var rescanBtn = el("rescan");
    if (rescanBtn) rescanBtn.disabled = busy || !state.hasSource;
    var inspectBtn = el("inspect");
    var any = selectedCount() > 0;
    if (inspectBtn) inspectBtn.disabled = busy || !state.hasSource || !any;
    for (var index = 0; index < ["selectAll", "selectNone", "expandAll", "collapseAll"].length; index += 1) {
      var id = ["selectAll", "selectNone", "expandAll", "collapseAll"][index];
      var node = el(id);
      if (node) node.disabled = busy;
    }
    var hint = el("inspectHint");
    if (hint) {
      if (!state.hasSource) hint.textContent = "请先选择课程文件夹。";
      else if (!any) hint.textContent = "请至少选择一个文件（空的选择范围不能检查）。";
      else hint.textContent = "将检查选中的 " + selectedCount() + " 个文件。";
    }
  }

  /* ── 与服务器的通信（token 一律走请求头）── */
  function request(path, options) {
    var opts = options || {};
    var headers = {};
    headers["content-type"] = "application/json";
    if (token) headers[TOKEN_HEADER] = token;
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "omit",
      cache: "no-store"
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (payload) {
        return { status: response.status, ok: response.ok, body: payload };
      });
    });
  }

  function describeFailure(result, fallback) {
    if (result && result.body && typeof result.body.error === "string" && result.body.error !== "") {
      return result.body.error;
    }
    if (result && result.status === 0) return fallback;
    return fallback;
  }

  /* ── 选择计数（含目录级三态）── */
  function selectedCount() {
    if (!tree) return 0;
    var count = 0;
    for (var index = 0; index < tree.files.length; index += 1) {
      if (isFileIncluded(tree.files[index].relativePath)) count += 1;
    }
    return count;
  }

  function isFileIncluded(relativePath) {
    if (excludedFiles[relativePath]) return false;
    if (selectedDirs[""]) return true;
    var parts = relativePath.split("/");
    var prefix = "";
    for (var index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix === "" ? parts[index] : prefix + "/" + parts[index];
      if (selectedDirs[prefix]) return true;
    }
    return false;
  }

  function filesUnder(relativePath) {
    if (!tree) return [];
    var prefix = relativePath === "" ? "" : relativePath + "/";
    var out = [];
    for (var index = 0; index < tree.files.length; index += 1) {
      var file = tree.files[index];
      if (relativePath === "" || file.relativePath === relativePath || file.relativePath.indexOf(prefix) === 0) {
        if (file.relativePath !== relativePath) out.push(file);
      }
    }
    return out;
  }

  /**
   * 目录的勾选状态：全选 / 全不选 / **部分选择**（indeterminate）。
   *
   * 三态必须真的呈现给用户：一个"半选"的父目录若显示成未勾选，
   * 用户会以为里面什么都没选 —— 而实际有文件会被检查。
   */
  function directoryState(relativePath) {
    var files = filesUnder(relativePath);
    if (files.length === 0) return "empty";
    var included = 0;
    for (var index = 0; index < files.length; index += 1) {
      if (isFileIncluded(files[index].relativePath)) included += 1;
    }
    if (included === 0) return "none";
    if (included === files.length) return "all";
    return "partial";
  }

  // ── 目录树渲染 ──
  function buildTreeModel() {
    var root = { name: tree.sourceRootLabel, path: "", children: {}, files: [] };
    var dirs = tree.directories || [];
    for (var index = 0; index < dirs.length; index += 1) {
      var parts = dirs[index].split("/");
      var node = root;
      var prefix = "";
      for (var depth = 0; depth < parts.length; depth += 1) {
        prefix = prefix === "" ? parts[depth] : prefix + "/" + parts[depth];
        if (!node.children[prefix]) {
          node.children[prefix] = { name: parts[depth], path: prefix, children: {}, files: [] };
        }
        node = node.children[prefix];
      }
    }
    for (var f = 0; f < tree.files.length; f += 1) {
      var file = tree.files[f];
      var parent = root;
      var dirParts = file.relativePath.split("/");
      var dirPrefix = "";
      for (var d = 0; d < dirParts.length - 1; d += 1) {
        dirPrefix = dirPrefix === "" ? dirParts[d] : dirPrefix + "/" + dirParts[d];
        if (!parent.children[dirPrefix]) {
          parent.children[dirPrefix] = { name: dirParts[d], path: dirPrefix, children: {}, files: [] };
        }
        parent = parent.children[dirPrefix];
      }
      parent.files.push(file);
    }
    return root;
  }

  function renderNode(node, depth) {
    var li = document.createElement("li");

    if (node.path !== "" || node.name) {
      var row = document.createElement("div");
      row.className = "node";
      var hasChildren = Object.keys(node.children).length > 0 || node.files.length > 0;
      var toggle = document.createElement("button");
      toggle.className = "toggle";
      toggle.type = "button";
      toggle.textContent = hasChildren ? (isExpanded(node.path) ? "▾" : "▸") : "·";
      toggle.setAttribute("aria-label", isExpanded(node.path) ? "折叠" : "展开");
      row.appendChild(toggle);

      var box = document.createElement("input");
      box.type = "checkbox";
      box.id = "dir-" + (node.path === "" ? "root" : node.path);
      var nodeState = directoryState(node.path);
      box.checked = nodeState === "all";
      box.indeterminate = nodeState === "partial";
      box.setAttribute("aria-label", "选择文件夹 " + node.name);
      box.addEventListener("change", function () {
        setDirectoryInclusion(node.path, box.checked);
        renderTree();
        updateSelectionSummary();
      });
      row.appendChild(box);

      var label = document.createElement("label");
      label.setAttribute("for", box.id);
      var nameWrap = document.createElement("span");
      nameWrap.className = "nm";
      nameWrap.appendChild(textNode("span", "base", node.name));
      var fileCount = filesUnder(node.path).length;
      nameWrap.appendChild(textNode("span", "meta", " · " + fileCount + " 个文件"));
      label.appendChild(nameWrap);
      row.appendChild(label);

      toggle.addEventListener("click", function () {
        expanded[node.path] = !isExpanded(node.path);
        renderTree();
      });

      li.appendChild(row);
    }

    var open = node.path === "" || isExpanded(node.path);
    if (open) {
      var list = document.createElement("ul");
      list.className = "kids";
      var childKeys = Object.keys(node.children).sort();
      for (var index = 0; index < childKeys.length; index += 1) {
        list.appendChild(renderNode(node.children[childKeys[index]], depth + 1));
      }
      for (var f = 0; f < node.files.length; f += 1) {
        list.appendChild(renderFile(node.files[f]));
      }
      if (childKeys.length === 0 && node.files.length === 0) {
        list.appendChild(textNode("li", "meta", "（空文件夹）"));
      }
      li.appendChild(list);
    }

    return li;
  }

  function renderFile(file) {
    var li = document.createElement("li");
    var row = document.createElement("div");
    row.className = "node";

    var spacer = document.createElement("span");
    spacer.className = "toggle";
    spacer.textContent = "";
    row.appendChild(spacer);

    var box = document.createElement("input");
    box.type = "checkbox";
    box.id = "file-" + file.relativePath;
    box.checked = isFileIncluded(file.relativePath);
    box.setAttribute("aria-label", "选择文件 " + file.basename);
    box.addEventListener("change", function () {
      if (box.checked) delete excludedFiles[file.relativePath];
      else excludedFiles[file.relativePath] = true;
      renderTree();
      updateSelectionSummary();
    });
    row.appendChild(box);

    var label = document.createElement("label");
    label.setAttribute("for", box.id);
    var wrap = document.createElement("span");
    wrap.className = "nm";
    wrap.appendChild(textNode("span", "base", file.basename));
    wrap.appendChild(textNode("span", "meta",
      " · " + (KIND_LABELS[file.kind] || file.kind) + " · " + formatBytes(file.bytes) +
      (file.bytes === 0 ? " · 空文件" : "")));
    label.appendChild(wrap);
    row.appendChild(label);

    li.appendChild(row);
    return li;
  }

  function isExpanded(path) { return expanded[path] === true; }

  function setDirectoryInclusion(path, include) {
    if (path === "") {
      if (include) { selectedDirs[""] = true; }
      else { delete selectedDirs[""]; }
    } else if (include) {
      selectedDirs[path] = true;
    } else {
      delete selectedDirs[path];
    }
    var files = filesUnder(path);
    for (var index = 0; index < files.length; index += 1) {
      if (include) delete excludedFiles[files[index].relativePath];
    }
  }

  function renderTree() {
    var host = el("tree");
    if (!host || !tree) return;
    host.textContent = "";
    if (tree.files.length === 0) {
      host.appendChild(textNode("div", "empty", "这个文件夹里没有可检查的文件。"));
      return;
    }
    var rootList = document.createElement("ul");
    rootList.appendChild(renderNode(buildTreeModel(), 0));
    host.appendChild(rootList);
  }

  function updateSelectionSummary() {
    if (!tree) return;
    var total = tree.files.length;
    var included = selectedCount();
    var excluded = total - included;
    var counts = el("selCounts");
    if (counts) {
      counts.textContent = "";
      counts.appendChild(document.createTextNode("已选 "));
      counts.appendChild(textNode("b", null, String(included)));
      counts.appendChild(document.createTextNode(" 个文件 · 已排除 "));
      counts.appendChild(textNode("b", null, String(excluded)));
      counts.appendChild(document.createTextNode(" 个"));
    }
    var fill = el("selBarFill");
    var percent = total === 0 ? 0 : Math.round((included / total) * 100);
    if (fill) fill.style.width = percent + "%";
    var bar = el("selBar");
    if (bar) bar.setAttribute("aria-valuenow", String(percent));
    refreshControls();
  }

  /* ── 第 2/3/4 步的渲染 ── */
  function renderCards(result) {
    var host = el("cards");
    if (!host) return;
    host.textContent = "";
    var counts = result.counts;
    var cards = [
      { n: counts.pdfParsed, t: "可以读出文字层的 PDF", ok: counts.pdfParsed > 0 },
      { n: counts.pdfWithoutTextLayer + counts.pdfFailed, t: "没有文字层或解析失败的 PDF", bad: (counts.pdfWithoutTextLayer + counts.pdfFailed) > 0 },
      { n: counts.deferred, t: "本版本暂不解析的其它文档（Word）", warn: counts.deferred > 0 },
      { n: counts.empty, t: "空文件（多半是导出失败）", bad: counts.empty > 0 }
    ];
    for (var index = 0; index < cards.length; index += 1) {
      var card = document.createElement("div");
      card.className = "card";
      card.appendChild(textNode("div", "n", String(cards[index].n)));
      card.appendChild(textNode("div", "t", cards[index].t));
      host.appendChild(card);
    }

    var facts = el("crossFacts");
    if (!facts) return;
    facts.textContent = "";
    facts.appendChild(textNode("h3", null, "范围与跨文件事实"));

    var lines = document.createElement("ul");
    lines.className = "plain";
    lines.appendChild(textNode("li", null,
      "这次检查了 " + counts.selected + " 个文件" +
      (counts.excluded > 0 ? "（还有 " + counts.excluded + " 个没有选中，因此不参与这次结果）" : "") + "。"));
    lines.appendChild(textNode("li", null,
      "解析结果：成功 " + counts.pdfParsed + " · 无文字层 " + counts.pdfWithoutTextLayer +
      " · 解析失败 " + counts.pdfFailed + " · 未解析的 Word " + counts.deferred + "。"));
    if (result.rejectedPaths.length > 0) {
      lines.appendChild(textNode("li", null, "有 " + result.rejectedPaths.length + " 个条目没有被读取（原因见下）。"));
    }
    facts.appendChild(lines);
  }

  function issueTag(severity) {
    if (severity === "blocking") return { cls: "tag bad", text: "会挡住后续步骤" };
    return { cls: "tag warn", text: "需要留意" };
  }

  function renderIssues(hostId, issues) {
    var host = el(hostId);
    if (!host) return;
    host.textContent = "";
    if (!issues || issues.length === 0) return;
    host.appendChild(textNode("h3", null, "冲突与警告（" + issues.length + " 条）"));
    for (var index = 0; index < issues.length; index += 1) {
      var issue = issues[index];
      var item = document.createElement("div");
      item.className = "item";
      var head = document.createElement("div");
      head.className = "head";
      var tag = issueTag(issue.severity);
      head.appendChild(textNode("span", tag.cls, tag.text));
      head.appendChild(textNode("span", "t", ISSUE_LABELS[issue.code] || issue.code));
      item.appendChild(head);
      item.appendChild(textNode("p", "why", issue.detail));
      /*
       * 每一条都必须给处置。
       *
       * 只报错不给"怎么办"是反馈缺陷 —— 使用者 会卡在一个他无法行动的状态上。
       * 这个字段由服务端生成（见服务层的 buildIssues），这里只负责显示。
       */
      item.appendChild(textNode("p", "fix", "怎么办：" + issue.recovery));
      host.appendChild(item);
    }
  }

  function renderMaterials(result) {
    var host = el("materials");
    if (!host) return;
    host.textContent = "";
    if (!result.materials || result.materials.length === 0) {
      host.appendChild(textNode("div", "empty", "这次范围内没有识别出任何课程材料。"));
      return;
    }
    for (var index = 0; index < result.materials.length; index += 1) {
      var material = result.materials[index];
      var item = document.createElement("div");
      item.className = "item";

      var head = document.createElement("div");
      head.className = "head";
      head.appendChild(textNode("span", "t", material.title));
      if (material.moduleHint) {
        head.appendChild(textNode("span", "tag info", SEGMENT_KIND_LABELS[
          material.moduleHint === "reading" ? "reading_passage" :
          material.moduleHint === "listening" ? "listening_passage" :
          material.moduleHint === "translation" ? "translation_passage" :
          material.moduleHint === "writing" ? "writing_template" : "method_note"
        ]));
      }
      if (material.unverifiedEquivalence) {
        head.appendChild(textNode("span", "tag warn", "两种版本的等价性未验证"));
      }
      if (material.reviewNotes.length > 0) {
        head.appendChild(textNode("span", "tag warn", "需要人工确认"));
      }
      item.appendChild(head);

      var repList = document.createElement("ul");
      repList.className = "plain";
      for (var r = 0; r < material.representations.length; r += 1) {
        var rep = material.representations[r];
        repList.appendChild(textNode("li", null, rep.label + "：" + rep.sourceRelativePath));
      }
      item.appendChild(repList);

      if (material.reviewNotes.length > 0) {
        for (var n = 0; n < material.reviewNotes.length; n += 1) {
          item.appendChild(textNode("p", "why", material.reviewNotes[n]));
        }
      }

      if (material.segments.length === 0) {
        item.appendChild(textNode("p", "why", "这份材料没有产出课程段 —— 这是刻意的：工具不发明边界。"));
        item.appendChild(textNode("p", "fix",
          "怎么办：若需要把它分成多份练习，那属于后续的人工标注步骤。本页只做只读检查，不会保存结构。"));
      } else {
        item.appendChild(textNode("h3", null, "课程段（" + material.segments.length + " 个）"));
        for (var s = 0; s < material.segments.length; s += 1) {
          var segment = material.segments[s];
          var segRow = document.createElement("div");
          segRow.className = "node";
          var segText = document.createElement("span");
          segText.className = "nm";
          segText.appendChild(textNode("span", "base", segment.title));
          segText.appendChild(textNode("span", "meta",
            " · " + segmentKindLabel(segment.kind) + " · " + pageRange(segment.pageStart, segment.pageEnd) +
            (segment.notApplicableByDesign ? " · 按设计不参与真题匹配" : "") +
            (segment.reviewRequired ? " · 需要人工确认" : "")));
          segRow.appendChild(segText);
          item.appendChild(segRow);
        }
      }

      var details = document.createElement("details");
      details.className = "adv";
      details.appendChild(textNode("summary", null, "分组依据（证据）"));
      var basis = document.createElement("ul");
      basis.className = "plain";
      for (var b = 0; b < material.basis.length; b += 1) {
        basis.appendChild(textNode("li", null, material.basis[b]));
      }
      details.appendChild(basis);
      item.appendChild(details);

      host.appendChild(item);
    }
  }

  /**
   * 跨段聚合的目标索引（**长列表的诚实呈现**）。
   *
   * 每段最多 5 条建议 ⇒ 单段列表看不到"长"这件事。而一次检查确实可能覆盖
   * 10+ 个不同目标，因此这里给出**去重后的完整索引**，并在超过一屏时
   * 显式显示"共 N 个，当前显示 M 个"+ 展开控件。
   *
   * **身份必须稳定且可见**：每条都显示「卷 · 大题 · 题组」三段式身份，
   * 而不是一个被截断的标签 —— 用户要能拿着它去真题库里找到那一份。
   */
  function renderTargetIndex(entries) {
    var box = document.createElement("div");
    box.className = "item";
    box.appendChild(textNode("h3", null, "这次涉及的全部真题目标（" + entries.length + " 个，已去重）"));
    box.appendChild(textNode("p", "why",
      "下面是这次检查里机器提出过建议的**每一个**不同目标（同一个目标被多段提到时只列一次）。" +
      "它们都只是建议 —— 没有建立任何链接。"));

    var shown = Math.min(entries.length, MAX_TARGETS_PER_VIEW);
    var expandedAll = false;

    function paint() {
      box.textContent = "";
      box.appendChild(textNode("h3", null, "这次涉及的全部真题目标（" + entries.length + " 个，已去重）"));
      box.appendChild(textNode("p", "why",
        "下面是这次检查里机器提出过建议的**每一个**不同目标（同一个目标被多段提到时只列一次）。" +
        "它们都只是建议 —— 没有建立任何链接。"));

      var list = document.createElement("ul");
      list.className = "plain";
      var limit = expandedAll ? entries.length : shown;
      for (var index = 0; index < limit; index += 1) {
        var entry = entries[index];
        var item = document.createElement("li");
        item.className = "target-row";
        item.setAttribute("data-target-key", entry.targetKey);
        item.appendChild(textNode("span", "base", entry.label));
        item.appendChild(textNode("span", "meta",
          " · 被 " + entry.segmentIds.length + " 段提到 · 最高 " + entry.bestScore.toFixed(3)));
        list.appendChild(item);
      }
      box.appendChild(list);

      if (entries.length > MAX_TARGETS_PER_VIEW) {
        var more = document.createElement("div");
        more.className = "more";
        more.appendChild(textNode("span", null,
          "共 " + entries.length + " 个目标，当前显示 " + limit + " 个。"));
        var toggle = document.createElement("button");
        toggle.className = "small";
        toggle.type = "button";
        toggle.textContent = expandedAll ? "收起" : "展开全部";
        toggle.setAttribute("data-target-index-toggle", "1");
        toggle.addEventListener("click", function () {
          expandedAll = !expandedAll;
          paint();
        });
        more.appendChild(toggle);
        box.appendChild(more);
      }
    }

    paint();
    return box;
  }

  /**
   * 长列表必须诚实地分页，**绝不**截断后声称完整。
   *
   * 一个被悄悄截掉的列表会让 使用者 以为"只有这几个候选"，
   * 而实际库里还有别的 —— 那正是"未匹配"与"已匹配"都变得不可信的那种缺陷。
   * 因此这里显式显示"共 N 条，当前显示前 M 条"，并提供展开控件。
   */
  function renderSuggestionList(suggestions) {
    var box = document.createElement("div");
    if (suggestions.length === 0) return box;

    var shown = Math.min(suggestions.length, MAX_TARGETS_PER_VIEW);
    var expandedAll = false;

    function paint() {
      box.textContent = "";
      var limit = expandedAll ? suggestions.length : shown;
      for (var index = 0; index < limit; index += 1) {
        var suggestion = suggestions[index];
        var row = document.createElement("div");
        row.className = "item";
        var head = document.createElement("div");
        head.className = "head";
        head.appendChild(textNode("span", "tag info", matchLabelLabel(suggestion.matchLabel)));
        head.appendChild(textNode("span", "t", suggestion.label));
        row.appendChild(head);

        var scoring = document.createElement("ul");
        scoring.className = "plain";
        scoring.appendChild(textNode("li", null,
          "分数 " + suggestion.score.toFixed(3) + "（只是排序用的加权和，不是匹配概率）"));
        scoring.appendChild(textNode("li", null,
          "正文包含度 " + (suggestion.scoring.bodyContainment * 100).toFixed(1) + "%" +
          " · 正文重合度 " + (suggestion.scoring.bodyJaccard * 100).toFixed(1) + "%" +
          (suggestion.scoring.projectionExact ? " · 文本指纹完全一致" : "")));
        if (suggestion.scoring.stemOverlap !== null) {
          scoring.appendChild(textNode("li", null,
            "题干重叠 " + (suggestion.scoring.stemOverlap * 100).toFixed(1) + "%" +
            (suggestion.scoring.optionOverlap !== null
              ? " · 选项重叠 " + (suggestion.scoring.optionOverlap * 100).toFixed(1) + "%" : "")));
        }
        row.appendChild(scoring);

        /*
         * 上下文线索**单独一区**，并明确标注"不参与打分"。
         *
         * 这是产品语义而不是排版偏好：文件名 / 套别号 / 题号 / 课程答案
         * 都是**上下文**，把它们混进证据区会让人以为它们参与了判断。
         */
        var context = suggestion.contextOnly;
        var details = document.createElement("details");
        details.className = "adv";
        details.appendChild(textNode("summary", null, "上下文线索（以下不参与打分）"));
        var ctx = document.createElement("ul");
        ctx.className = "plain";
        ctx.appendChild(textNode("li", null, "课程侧文件名：" + (context.courseFileName || "（未登记）")));
        ctx.appendChild(textNode("li", null, "套别号：" + (context.courseSetLabel || "（未登记）")));
        ctx.appendChild(textNode("li", null,
          "材料里观测到的题号：" + (context.observedQuestionNumbers.length > 0
            ? context.observedQuestionNumbers.join("、") : "（无）")));
        ctx.appendChild(textNode("li", null,
          "候选卷的题号：" + (context.canonicalQuestionNumbers.length > 0
            ? context.canonicalQuestionNumbers.join("、") : "（无）")));
        if (context.courseAnswerKey) {
          ctx.appendChild(textNode("li", null, "课程侧给的答案（源件主张，不是判分真相）：" + context.courseAnswerKey));
        }
        details.appendChild(ctx);
        row.appendChild(details);
        row.appendChild(textNode("p", "why", "机器建议不等于核验 —— 它不会建立任何链接。"));
        box.appendChild(row);
      }

      if (suggestions.length > MAX_TARGETS_PER_VIEW) {
        var more = document.createElement("div");
        more.className = "more";
        more.appendChild(textNode("span", null,
          "共 " + suggestions.length + " 条建议，当前显示 " + limit + " 条。"));
        var toggle = document.createElement("button");
        toggle.className = "small";
        toggle.type = "button";
        toggle.textContent = expandedAll ? "收起" : "展开全部";
        toggle.addEventListener("click", function () {
          expandedAll = !expandedAll;
          paint();
        });
        more.appendChild(toggle);
        box.appendChild(more);
      }
    }

    paint();
    return box;
  }

  function renderMatches(result) {
    var host = el("matches");
    var summary = el("matchSummary");
    if (!host) return;
    host.textContent = "";

    if (summary) {
      summary.textContent = "";
      var withSuggestions = 0;
      var ambiguous = 0;
      var unmatched = 0;
      var notApplicable = 0;
      for (var index = 0; index < result.matches.length; index += 1) {
        var match = result.matches[index];
        if (match.view === "suggestions" || match.view === "ambiguous") withSuggestions += 1;
        if (match.view === "ambiguous") ambiguous += 1;
        if (match.view === "unmatched") unmatched += 1;
        if (match.view === "not_applicable") notApplicable += 1;
      }
      summary.appendChild(textNode("div", null,
        "共 " + result.matches.length + " 个课程段：有候选 " + withSuggestions +
        " 个（其中存在歧义 " + ambiguous + " 个）· 库里没有可比对象 " + unmatched +
        " 个 · 按设计不参与匹配 " + notApplicable + " 个。"));
      summary.appendChild(textNode("div", null,
        "这次结果一共涉及 " + result.distinctTargetCount + " 个不同的真题目标。"));
      summary.appendChild(textNode("div", null,
        result.canonicalLibrary.complete
          ? "真题库读取完整（" + result.canonicalLibrary.papers.length + " 份卷子参与了比对）。"
          : "真题库不完整（有 " + result.canonicalLibrary.readFailures.length +
            " 份卷子读不出来）。因此「未匹配」与「最高分建议」都不完全可信。"));
    }

    /*
     * ── 跨段聚合的目标索引：**长列表必须诚实分页** ──
     *
     * 每段最多 5 条建议（既有契约），因此**单段**列表永远不会超过 5 条。
     * 而"长列表"是真实存在的：一次检查可以跨段覆盖 10+ 个不同目标。
     *
     * 若界面只按段列，用户就没有一个地方能看到"这次涉及了哪些目标" ——
     * 而那正是任务书要求 "total counts, stable target identity and
     * expandable/paginated rendering for long lists" 的场景。
     *
     * 判据刻意是**两条**：总数必须显示，**且**展开控件必须存在。
     * 一个被悄悄截断的列表会让 使用者 以为"只有这几个"，而实际还有别的。
     */
    if (result.targetIndex && result.targetIndex.length > 0) {
      host.appendChild(renderTargetIndex(result.targetIndex));
    }

    if (result.matches.length === 0) {
      host.appendChild(textNode("div", "empty", "这次范围内没有课程段，因此没有候选可比。"));
      return;
    }

    for (var m = 0; m < result.matches.length; m += 1) {
      var item = document.createElement("div");
      item.className = "item";
      var head = document.createElement("div");
      head.className = "head";
      head.appendChild(textNode("span", "t", result.matches[m].segmentTitle));
      head.appendChild(textNode("span", "tag", segmentKindLabel(result.matches[m].segmentKind)));
      item.appendChild(head);

      var match = result.matches[m];
      if (match.view === "not_applicable") {
        item.appendChild(textNode("p", "why",
          "这一段按设计不参与真题匹配 —— 写作模板与方法讲解本来就不对应单一道真题。"));
        item.appendChild(textNode("p", "fix",
          "怎么办：不需要做任何事。没有链接是这类材料的正常状态，不是缺陷。"));
      } else if (match.view === "unmatched") {
        item.appendChild(textNode("p", "why",
          (match.unmatchedNote || "当前真题库里没有可比的对象。") +
          "（机器比较了 " + match.candidatesConsidered + " 个对象）"));
        item.appendChild(textNode("p", "fix",
          "怎么办：未匹配是合法状态 —— 它不表示这份材料有问题，只表示现有题库无法有把握地识别它。" +
          "若真题库不完整，请先修好读不出来的卷子再重新检查。"));
      } else if (match.view === "ambiguous") {
        item.appendChild(textNode("p", "why", match.ambiguityNote || "前两名建议的分数过于接近。"));
        item.appendChild(textNode("p", "fix",
          "怎么办：机器不会替你在接近的候选之间选一个。请对照下面的逐项证据判断 —— " +
          "而人工裁决属于后续步骤，本页不会保存任何结论。"));
      } else {
        item.appendChild(textNode("p", "why", "下面是机器给出的全部候选（按证据强弱排序），它们都只是建议。"));
      }

      item.appendChild(renderSuggestionList(match.suggestions));
      host.appendChild(item);
    }
  }

  function renderAdvanced(result) {
    var host = el("advanced");
    if (!host) return;
    host.textContent = "";
    var lines = [
      "源目录标签（只有目录名）：" + result.sourceRootLabel,
      "检查时刻：" + result.inspectedAt,
      "选中文件数：" + result.counts.selected + " · 未选中：" + result.counts.excluded,
      "源内容摘要前 16 位：" + String(result.sourceDigest).slice(0, 16),
      "目录结构摘要前 16 位：" + String(result.structureDigest).slice(0, 16),
      "真题库摘要前 16 位：" + String(result.canonicalLibrary.digest).slice(0, 16)
    ];
    for (var index = 0; index < lines.length; index += 1) {
      host.appendChild(textNode("div", "mono", lines[index]));
    }
  }

  function showStep(step) {
    var panels = ["step1", "step2", "step3", "step4"];
    for (var index = 0; index < panels.length; index += 1) {
      var panel = el(panels[index]);
      if (!panel) continue;
      var number = index + 1;
      var available = number === 1 || lastResult !== null;
      panel.hidden = !(number === step) || !available;
    }
    for (var b = 1; b <= 4; b += 1) {
      var button = el("stepBtn" + b);
      if (!button) continue;
      button.disabled = b !== 1 && lastResult === null;
      if (b === step) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    say("已切换到第 " + step + " 步。");
  }

  /* ── 动作 ── */
  function loadState() {
    setBusy(true, "正在确认工作台状态…");
    return request(ENDPOINTS.state).then(function (result) {
      setBusy(false);
      if (!result.ok || !result.body || result.body.ok !== true) {
        var message = result.status === 403
          ? "这个页面的会话凭据无效或已过期。"
          : describeFailure(result, "没能和本机服务建立连接。");
        setNotice("globalNotice", "err", message,
          result.status === 403
            ? "请回到启动工作台的那个终端窗口，重新打开它打印出来的完整网址（网址里 # 之后带着本次会话的凭据）。"
            : "请确认启动工作台的终端窗口仍然开着，然后刷新这一页。");
        var pickButton = el("pick");
        if (pickButton) pickButton.disabled = true;
        return;
      }
      state = result.body;
      if (state.hasSource) {
        el("pickState").textContent = "已选择：" + state.sourceLabel + "（本机目录，只读检查）";
        el("treeWrap").hidden = false;
      } else {
        el("pickState").textContent = "还没有选择文件夹。";
      }
      refreshControls();
      return null;
    }).catch(function () {
      setBusy(false);
      setNotice("globalNotice", "err", "和本机服务的连接中断了。",
        "请确认工作台仍在运行，然后刷新这一页重试。");
    });
  }

  function pickFolder() {
    setNotice("globalNotice", "", "");
    setBusy(true, "等待你在弹出的窗口里选择文件夹…");
    el("pickState").textContent = "已经打开系统文件夹选择窗口 —— 请在弹出的窗口里选择一个文件夹。";
    return request(ENDPOINTS.pick, { method: "POST", body: {} }).then(function (result) {
      setBusy(false);
      var body = result.body || {};
      var fact = el("pickerFact");
      if (fact) {
        /*
         * 运行时事实：宿主是否真的关掉了"新建文件夹"。
         *
         * Microsoft 文档写明 .NET Core 3.1+ 会**无视** ShowNewFolderButton。
         * 与其假设它成立，不如把读回的值如实显示 —— 它不是"已隐藏"时，
         * 人就知道这个宿主没兑现"绝不在课程目录里建东西"这条约束。
         */
        if (body.newFolderButtonHidden === true) {
          fact.hidden = false;
          fact.textContent = "已确认：文件夹窗口里的「新建文件夹」按钮已关闭（本工具不会在课程目录里建任何东西）。";
        } else if (body.newFolderButtonHidden === false) {
          fact.hidden = false;
          fact.textContent = "注意：这个宿主没有关掉文件夹窗口里的「新建文件夹」按钮。请不要用它新建文件夹 —— 本工具自身绝不创建任何东西。";
        } else {
          fact.hidden = true;
          fact.textContent = "";
        }
      }

      if (body.outcome === "selected") {
        setNotice("globalNotice", "ok", "已选择文件夹：" + (body.sourceLabel || "（已选择）"), null);
        el("pickState").textContent = "已选择：" + (body.sourceLabel || "（已选择）") + "（本机目录，只读检查）";
        el("treeWrap").hidden = false;
        selectedDirs = { "": true };
        excludedFiles = {};
        showStep(1);
        return loadTreeFromInspection();
      }
      if (body.outcome === "cancelled") {
        setNotice("globalNotice", "info", "没有选择文件夹（已取消）。", "想继续时再点一次「选择课程文件夹…」。");
        el("pickState").textContent = state.hasSource
          ? "已选择：" + state.sourceLabel + "（本机目录，只读检查）"
          : "还没有选择文件夹。";
        return;
      }
      if (body.outcome === "unsupported_platform") {
        setNotice("globalNotice", "err", "这台机器上不支持打开系统文件夹选择窗口。",
          "本工具目前只在 Windows 上提供原生文件夹选择窗口。");
        return;
      }
      if (body.outcome === "timeout") {
        setNotice("globalNotice", "warn", body.detail || "选择窗口长时间没有回应。",
          "再点一次「选择课程文件夹…」重试即可。");
        return;
      }
      setNotice("globalNotice", "err", body.detail || "文件夹选择窗口没能打开。",
        "可以再点一次重试；若一直打不开，请确认当前是正常的桌面登录会话（远程/无桌面会话下系统对话框无法显示）。");
    }).catch(function () {
      setBusy(false);
      setNotice("globalNotice", "err", "和本机服务的连接中断了。",
        "请确认工作台仍在运行，然后刷新这一页重试。");
    });
  }

  function rescan() {
    setNotice("globalNotice", "", "");
    lastResult = null;
    showStep(1);
    return loadTreeFromInspection();
  }

  function runInspection() {
    if (selectedCount() === 0) {
      setNotice("globalNotice", "warn", "还没有选择任何文件。",
        "请至少勾选一个文件或一个文件夹，再点「检查所选材料」。");
      return;
    }
    setNotice("globalNotice", "", "");
    el("inspect").disabled = true;
    setBusy(true, "正在检查所选材料…（文件多时需要一会儿）");

    var includeDirs = Object.keys(selectedDirs);
    var excludeFiles = Object.keys(excludedFiles);

    return request(ENDPOINTS.inspect, {
      method: "POST",
      body: { includeDirectories: includeDirs, excludeFiles: excludeFiles }
    }).then(function (result) {
      setBusy(false);
      if (!result.ok || !result.body || result.body.ok !== true) {
        setNotice("globalNotice", "err", describeFailure(result, "这次检查没有完成。"),
          "已经得到的结果仍然可用 —— 请修掉上面的问题后重新点一次「检查所选材料」。");
        el("inspect").disabled = false;
        return;
      }
      lastResult = result.body.result;
      renderCards(lastResult);
      /*
       * 冲突与警告按**步骤**分派，而不是全部堆在一步里。
       *
       * 判据是"这条信息在哪一步才能被行动"：清点类问题（空文件、解析失败）
       * 属于第 2 步；分组与分段类问题属于第 3 步；匹配类问题属于第 4 步。
       * 把它们全堆在第 2 步会让 使用者 在第 2 步就看到"歧义需要裁决"，
       * 而它对应的材料这时还没显示出来。
       */
      var stage2Codes = {
        rejected_path: 1, empty_file: 1, extraction_failed: 1, page_without_text_layer: 1,
        duplicate_content: 1, same_name_different_bytes: 1, unsupported_type: 1,
        text_extraction_deferred: 1, canonical_library_incomplete: 1
      };
      var stage3Codes = {
        grouping_invariant_violated: 1, material_grouping_requires_review: 1, no_segments_extracted: 1
      };
      var stage4Codes = { match_ambiguous: 1 };

      renderIssues("stage2Issues", lastResult.issues.filter(function (issue) {
        return stage2Codes[issue.code] === 1;
      }));
      renderIssues("stage3Issues", lastResult.issues.filter(function (issue) {
        return stage3Codes[issue.code] === 1;
      }));
      renderIssues("stage4Issues", lastResult.issues.filter(function (issue) {
        return stage4Codes[issue.code] === 1;
      }));
      renderMaterials(lastResult);
      renderMatches(lastResult);
      renderAdvanced(lastResult);
      showStep(2);
      setNotice("globalNotice", "ok",
        "检查完成：这次阅读了 " + lastResult.counts.selected + " 个文件，过程中没有修改任何文件。", null);
      say("检查完成。可以查看第 2 到第 4 步的结果。");
    }).catch(function () {
      setBusy(false);
      el("inspect").disabled = false;
      setNotice("globalNotice", "err", "和本机服务的连接中断了。",
        "请确认工作台仍在运行，然后重试。");
    });
  }

  function changeDir() {
    setNotice("globalNotice", "", "");
    state.hasSource = false;
    tree = null;
    lastResult = null;
    selectedDirs = {};
    excludedFiles = {};
    el("treeWrap").hidden = true;
    el("pickerFact").hidden = true;
    el("pickState").textContent = "请选择一个新的文件夹。";
    refreshControls();
    showStep(1);
    return pickFolder();
  }

  /* ── 目录内容：**只读元数据**（不解析任何文件）── */
  function loadTreeFromInspection() {
    /*
     * 目录树来自 GET /api/intake/browse，**不是**一次全选检查。
     *
     * 差别是具体的：一次"全选检查"会把范围内每一个 PDF 都解析一遍
     * （几十 MB 的讲义要几秒），而用户此刻还没有选择任何东西。
     * browse 走只读元数据路径：只 readdir + stat，**绝不打开文件句柄**。
     * 因此首屏很快，且它的安全性由与内容清点同一份遍历实现保证。
     */
    setBusy(true, "正在列出文件夹内容…");
    return request(ENDPOINTS.browse).then(function (result) {
      setBusy(false);
      if (!result.ok || !result.body || result.body.ok !== true || !result.body.metadata) {
        setNotice("globalNotice", "err", describeFailure(result, "没能列出这个文件夹的内容。"),
          "请确认这个文件夹仍然存在且可读，然后点「换一个文件夹」重试。");
        return null;
      }
      tree = result.body.metadata;
      selectedDirs = { "": true };
      excludedFiles = {};
      /*
       * ── 默认**展开**目录，而不是折叠 ──
       *
       * 折叠的目录树让首屏**一个文件都看不到**（只有几个目录名），
       * 于是"这个文件夹里有什么"这个问题没有被回答 —— 而那正是第 1 步
       * 存在的理由。实测形态：只有顶层目录可见，任何 file-* 复选框
       * 都不在 DOM 里，用户必须先逐个点开才知道里面有什么。
       *
       * 课程目录的规模是几十到几百个文件，全展开是可用的；
       * 需要收起来时「折叠全部」就在旁边。
       */
      expanded = {};
      for (var directoryIndex = 0; directoryIndex < tree.directories.length; directoryIndex += 1) {
        expanded[tree.directories[directoryIndex]] = true;
      }
      renderTree();
      updateSelectionSummary();
      if (tree.rejected && tree.rejected.length > 0) {
        renderIssues("treeIssues", tree.rejected.map(function (entry) {
          return {
            code: "rejected_path",
            severity: "blocking",
            where: entry.relativePath,
            detail: entry.reason,
            recovery: "确认它是否真的属于这门课；若它是软链接指向别处，请把内容复制进课程目录后重新检查。"
          };
        }));
      }
      return null;
    }).catch(function () {
      setBusy(false);
      setNotice("globalNotice", "err", "和本机服务的连接中断了。",
        "请确认工作台仍在运行，然后刷新这一页重试。");
      return null;
    });
  }

  /* ── 事件接线 ── */
  function wire() {
    var pickBtn = el("pick");
    if (pickBtn) pickBtn.addEventListener("click", function () { pickFolder(); });

    var change = el("changeDir");
    if (change) change.addEventListener("click", function () { changeDir(); });

    var rescanBtn = el("rescan");
    if (rescanBtn) rescanBtn.addEventListener("click", function () {
      rescan();
    });

    var inspect = el("inspect");
    if (inspect) inspect.addEventListener("click", function () { runInspection(); });

    var selectAll = el("selectAll");
    if (selectAll) selectAll.addEventListener("click", function () {
      selectedDirs = { "": true };
      excludedFiles = {};
      renderTree();
      updateSelectionSummary();
      say("已选择全部文件。");
    });

    var selectNone = el("selectNone");
    if (selectNone) selectNone.addEventListener("click", function () {
      selectedDirs = {};
      excludedFiles = {};
      renderTree();
      updateSelectionSummary();
      say("已排除全部文件。");
    });

    var expandAll = el("expandAll");
    if (expandAll) expandAll.addEventListener("click", function () {
      if (!tree) return;
      for (var index = 0; index < tree.directories.length; index += 1) {
        expanded[tree.directories[index]] = true;
      }
      renderTree();
    });

    var collapseAll = el("collapseAll");
    if (collapseAll) collapseAll.addEventListener("click", function () {
      expanded = { "": true };
      renderTree();
    });

    var help = el("help");
    if (help) help.addEventListener("click", function () {
      setNotice("globalNotice", "info",
        "这一页用来在导入之前先看清本机课程文件夹里有什么：文件清单、材料分组、课程段，以及可能对应的真题。" +
        "它**只读** —— 不会修改、保存或导入任何东西，也不会建立任何链接。",
        "按 ① 到 ④ 的顺序看即可。任何时候都可以直接关掉这一页，不会有任何副作用。");
      say("已显示说明。");
    });

    for (var step = 1; step <= 4; step += 1) {
      (function (number) {
        var button = el("stepBtn" + number);
        if (button) button.addEventListener("click", function () { showStep(number); });
      })(step);
    }
  }

  function boot() {
    wire();
    if (!token) {
      setNotice("globalNotice", "err", "这个页面缺少会话凭据，因此不能读取任何内容。",
        "请回到启动工作台的终端窗口，打开它打印出来的完整网址（# 之后那一段必须完整复制）。");
      var pickBtn = el("pick");
      if (pickBtn) pickBtn.disabled = true;
      return;
    }
    loadState().then(function () {
      if (state.hasSource) return loadTreeFromInspection();
      return null;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
`;
