/**
 * A2 人工审核与裁决工作台 · 客户端脚本（原始字符串内联）。
 *
 * ── 为什么单独成文件 ──
 * 保持与 A1 的严格零写入隔离：A1 文件纯只读，A2 具有结构化审核、草稿编辑、冲突提示、
 * 校验和对比与保存裁决的能力。
 */

export const ADJUDICATION_CLIENT_SCRIPT = String.raw`
"use strict";
(function () {
  var TOKEN_HEADER = "x-cet6-session-token";
  var ENDPOINTS = {
    state: "/api/intake/state",
    browse: "/api/intake/browse",
    pick: "/api/intake/pick",
    inspect: "/api/intake/inspect",
    loadDraft: "/api/intake/draft",
    binding: "/api/intake/binding",
    validateDraft: "/api/intake/validate-draft",
    saveDraft: "/api/intake/save-draft",
    savePlan: "/api/intake/save-plan",
    previewCandidate: "/api/intake/preview-candidate",
    generateCandidate: "/api/intake/generate-candidate"
  };

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

  var token = null;
  var state = { hasSource: false, sourceLabel: null };
  var tree = null;
  var selectedDirs = {};
  var excludedFiles = {};
  var lastResult = null;
  var busy = false;
  var expanded = {};

  var draftState = {
    reviewer: "",
    courseId: "",
    materialGroupings: {},
    segments: {},
    matches: {}
  };
  /** 已保存的快照（用于"未保存的更改"提示）。 */
  var savedSnapshot = null;
  /** 服务端现场重算出的绑定身份（校验/保存成功后由响应带回）。 */
  var binding = { candidateChecksum: null, canonicalLibraryDigest: null, candidateMissing: false };
  /** 当前加载的分段计划（若存在）。 */
  var currentPlan = null;

  function shortDigest(value) {
    if (typeof value !== "string" || value.length < 12) return String(value || "（未知）");
    return value.slice(0, 12) + "…";
  }

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
    catch (error) {}
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
    return fallback;
  }

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

  function isExpanded(path) { return expanded[path] === true; }

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
        repList.appendChild(textNode("li", null,
          rep.label + "（" + (KIND_LABELS[rep.kind] || rep.kind) +
          (rep.pages !== null ? " · " + rep.pages + " 页" : "") +
          (rep.bytes !== null ? " · " + formatBytes(rep.bytes) : "") + "）"));
      }
      item.appendChild(repList);

      if (material.segments && material.segments.length > 0) {
        var segTable = document.createElement("table");
        segTable.style.marginTop = "8px";
        var thead = document.createElement("thead");
        var tr = document.createElement("tr");
        tr.appendChild(textNode("th", null, "段落"));
        tr.appendChild(textNode("th", null, "种类"));
        tr.appendChild(textNode("th", null, "页码"));
        thead.appendChild(tr);
        segTable.appendChild(thead);

        var tbody = document.createElement("tbody");
        for (var s = 0; s < material.segments.length; s += 1) {
          var seg = material.segments[s];
          var str = document.createElement("tr");
          str.appendChild(textNode("td", null, seg.title));
          str.appendChild(textNode("td", null, segmentKindLabel(seg.kind)));
          str.appendChild(textNode("td", null, pageRange(seg.pageStart, seg.pageEnd)));
          tbody.appendChild(str);
        }
        segTable.appendChild(tbody);
        item.appendChild(segTable);
      }
      host.appendChild(item);
    }
  }

  function renderMatches(result) {
    var host = el("matches");
    if (!host) return;
    host.textContent = "";

    var summary = el("matchSummary");
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
      if (match.suggestions && match.suggestions.length > 0) {
        var ul = document.createElement("ul");
        ul.className = "plain";
        for (var si = 0; si < match.suggestions.length; si += 1) {
          var sug = match.suggestions[si];
          ul.appendChild(textNode("li", null,
            sug.paperId + " · " + sug.label + "（得分 " + sug.score.toFixed(4) + " · " + matchLabelLabel(sug.matchLabel) + "）"));
        }
        item.appendChild(ul);
      } else {
        item.appendChild(textNode("p", "why", "当前没有真题匹配建议。"));
      }
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
      "真题库摘要前 16 位：" + String(result.canonicalLibrary.digest).slice(0, 16)
    ];
    for (var index = 0; index < lines.length; index += 1) {
      host.appendChild(textNode("div", "mono", lines[index]));
    }
  }

  /* ── A2 人工裁决视图与草稿逻辑 ── */
  function initAdjudicationView() {
    if (!lastResult) return;
    if (!draftState.courseId && state.sourceLabel) {
      draftState.courseId = String(state.sourceLabel).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      var cidInput = el("courseIdInput");
      if (cidInput) cidInput.value = draftState.courseId;
    }
    renderAdjudicationSections();
    updateDirtyHint();
    loadBinding();
  }

  /**
   * 从服务端取**当前**绑定身份（只读）。
   *
   * 这一步让绑定面板在用户还没点"校验"时就显示真相，包括
   * "候选不存在 ⇒ 先运行 course:extract"这种关键提示。
   */
  function loadBinding() {
    var courseId = (el("courseIdInput") && el("courseIdInput").value.trim()) || draftState.courseId;
    if (!courseId) return;
    return request(ENDPOINTS.binding + "?courseId=" + encodeURIComponent(courseId)).then(function(res) {
      var b = res.body && res.body.binding;
      if (!b) return;
      binding.candidateMissing = b.candidateExists !== true;
      if (b.rebound) {
        binding.candidateChecksum = b.rebound.candidateChecksum;
        binding.canonicalLibraryDigest = b.rebound.canonicalLibraryDigest;
      } else {
        binding.candidateChecksum = null;
        binding.canonicalLibraryDigest = null;
      }
      binding.reason = b.reason || null;
      renderBindingPanel();
    }).catch(function() {
      /* 绑定查询失败不阻塞界面；保存时仍会校验 */
    });
  }

  /**
   * 绑定面板：明确告诉用户"这份审核绑的是哪一份候选、哪一版真题库"。
   *
   * 界面**不**显示绝对路径，只显示课程标识与摘要缩略（P0-F1 的验收点之一）。
   */
  function renderBindingPanel() {
    var scope = el("bindingScope");
    if (scope) {
      scope.textContent =
        "材料范围：" + (state.sourceLabel || "（未选择）") +
        " · 本次检查 " + (lastResult ? lastResult.counts.selected : 0) + " 个文件" +
        " · 课程段 " + (lastResult ? lastResult.matches.length : 0) + " 个";
    }
    var cand = el("bindingCandidate");
    if (cand) {
      cand.textContent = binding.candidateChecksum
        ? "将绑定的候选校验和：" + shortDigest(binding.candidateChecksum) + "（服务端现场重算）"
        : "候选校验和：尚未验证（请先点「校验当前审核决定」）";
    }
    var lib = el("bindingLibrary");
    if (lib) {
      lib.textContent = binding.canonicalLibraryDigest
        ? "真题库摘要：" + shortDigest(binding.canonicalLibraryDigest) + "（服务端现场重算）"
        : "真题库摘要：尚未验证";
    }
    var stale = el("bindingStale");
    if (stale) {
      if (binding.candidateMissing === true) {
        stale.textContent =
          (binding.reason || "候选不存在或已失效") +
          " —— 请先运行 pnpm course:extract 生成本课程的候选，再回到本页保存审核。";
      } else {
        stale.textContent = "";
      }
    }
  }

  function renderAdjudicationSections() {
    renderAdjudicationGroupings();
    renderAdjudicationSegments();
    renderAdjudicationMatches();
  }

  /** 未保存更改提示（与已保存快照对比）。 */
  function updateDirtyHint() {
    var hint = el("dirtyHint");
    if (!hint) return;
    if (!savedSnapshot) {
      hint.textContent = "当前审核尚未保存。";
      return;
    }
    var current = collectDraftPayload();
    var same =
      JSON.stringify(current.materialGroupings) === JSON.stringify(savedSnapshot.materialGroupings) &&
      JSON.stringify(current.segments) === JSON.stringify(savedSnapshot.segments) &&
      JSON.stringify(current.matches) === JSON.stringify(savedSnapshot.matches) &&
      current.reviewer === savedSnapshot.reviewer &&
      current.courseId === savedSnapshot.courseId;
    hint.textContent = same
      ? "已保存的版本与当前一致。"
      : "有未保存的更改（与已保存版本不同）。";
  }

  function renderAdjudicationGroupings() {
    var host = el("adjudicationGroupings");
    if (!host || !lastResult) return;
    host.textContent = "";

    if (!lastResult.materials || lastResult.materials.length === 0) {
      host.appendChild(textNode("div", "empty", "暂无材料分组提案需要审核。"));
      return;
    }

    for (var i = 0; i < lastResult.materials.length; i += 1) {
      var mat = lastResult.materials[i];
      var proposalId = mat.id;
      var card = document.createElement("div");
      card.className = "item";
      card.id = "grouping-card-" + proposalId;

      var head = document.createElement("div");
      head.className = "head";
      head.appendChild(textNode("span", "t", "材料提案: " + mat.title));
      head.appendChild(textNode("span", "tag", "材料"));
      card.appendChild(head);

      var desc = document.createElement("p");
      desc.className = "why";
      desc.textContent = "包含 " + mat.representations.length + " 个表示文件（" +
        mat.representations.map(function(r) { return r.label; }).join("、") + "）。";
      card.appendChild(desc);

      var cur = draftState.materialGroupings[proposalId] || { decision: "", evidence: "" };

      var ctrlRow = document.createElement("div");
      ctrlRow.className = "row";
      ctrlRow.appendChild(textNode("b", null, "裁决："));

      var select = document.createElement("select");
      select.id = "grouping-decision-" + proposalId;
      select.style.padding = "4px 8px";
      select.style.borderRadius = "5px";
      select.style.border = "1px solid var(--edge-strong)";

      var optEmpty = document.createElement("option");
      optEmpty.value = "";
      optEmpty.textContent = "-- 请选择裁决（不自动批准）--";
      select.appendChild(optEmpty);

      var optAccept = document.createElement("option");
      optAccept.value = "accepted";
      optAccept.textContent = "接受分组建议 (accepted)";
      select.appendChild(optAccept);

      var optReject = document.createElement("option");
      optReject.value = "rejected";
      optReject.textContent = "拒绝分组建议 (rejected)";
      select.appendChild(optReject);

      select.value = cur.decision;
      (function(pid, sel) {
        sel.addEventListener("change", function() {
          if (!draftState.materialGroupings[pid]) draftState.materialGroupings[pid] = { decision: "", evidence: "" };
          draftState.materialGroupings[pid].decision = sel.value;
          updateDirtyHint();
        });
      })(proposalId, select);
      ctrlRow.appendChild(select);
      card.appendChild(ctrlRow);

      var evRow = document.createElement("div");
      evRow.className = "stack";
      evRow.appendChild(textNode("label", null, "审核依据（≥10 个字符）："));
      var evInput = document.createElement("input");
      evInput.type = "text";
      evInput.id = "grouping-evidence-" + proposalId;
      evInput.placeholder = "请填写具体核查事实与理由（至少 10 字符）";
      evInput.style.padding = "4px 8px";
      evInput.style.borderRadius = "5px";
      evInput.style.border = "1px solid var(--edge-strong)";
      evInput.value = cur.evidence;
      (function(pid, inp) {
        inp.addEventListener("input", function() {
          if (!draftState.materialGroupings[pid]) draftState.materialGroupings[pid] = { decision: "", evidence: "" };
          draftState.materialGroupings[pid].evidence = inp.value;
          updateDirtyHint();
        });
      })(proposalId, evInput);
      evRow.appendChild(evInput);
      card.appendChild(evRow);

      host.appendChild(card);
    }
  }

  function renderAdjudicationSegments() {
    var host = el("adjudicationSegments");
    if (!host || !lastResult) return;
    host.textContent = "";

    var allSegments = [];
    if (lastResult.materials) {
      for (var m = 0; m < lastResult.materials.length; m += 1) {
        var mat = lastResult.materials[m];
        if (mat.segments) {
          for (var s = 0; s < mat.segments.length; s += 1) {
            allSegments.push(mat.segments[s]);
          }
        }
      }
    }

    if (allSegments.length === 0) {
      host.appendChild(textNode("div", "empty", "暂无分段建议需要审核。"));
      return;
    }

    for (var i = 0; i < allSegments.length; i += 1) {
      var seg = allSegments[i];
      var segId = seg.id;
      var card = document.createElement("div");
      card.className = "item";
      card.id = "segment-card-" + segId;

      var head = document.createElement("div");
      head.className = "head";
      head.appendChild(textNode("span", "t", "分段: " + seg.title));
      head.appendChild(textNode("span", "tag", segmentKindLabel(seg.kind)));
      card.appendChild(head);

      var cur = draftState.segments[segId] || { decision: "", evidence: "" };

      var ctrlRow = document.createElement("div");
      ctrlRow.className = "row";
      ctrlRow.appendChild(textNode("b", null, "裁决："));

      var select = document.createElement("select");
      select.id = "segment-decision-" + segId;
      select.style.padding = "4px 8px";
      select.style.borderRadius = "5px";
      select.style.border = "1px solid var(--edge-strong)";

      var optEmpty = document.createElement("option");
      optEmpty.value = "";
      optEmpty.textContent = "-- 请选择裁决（不自动批准）--";
      select.appendChild(optEmpty);

      var optAccept = document.createElement("option");
      optAccept.value = "accepted";
      optAccept.textContent = "接受分段建议 (accepted)";
      select.appendChild(optAccept);

      var optReject = document.createElement("option");
      optReject.value = "excluded";
      optReject.textContent = "排除该段 (excluded)";
      select.appendChild(optReject);

      select.value = cur.decision;
      (function(sid, sel) {
        sel.addEventListener("change", function() {
          if (!draftState.segments[sid]) draftState.segments[sid] = { decision: "", evidence: "" };
          draftState.segments[sid].decision = sel.value;
          updateDirtyHint();
        });
      })(segId, select);
      ctrlRow.appendChild(select);
      card.appendChild(ctrlRow);

      var evRow = document.createElement("div");
      evRow.className = "stack";
      evRow.appendChild(textNode("label", null, "审核依据（≥10 个字符）："));
      var evInput = document.createElement("input");
      evInput.type = "text";
      evInput.id = "segment-evidence-" + segId;
      evInput.placeholder = "请填写具体分段核对依据（至少 10 字符）";
      evInput.style.padding = "4px 8px";
      evInput.style.borderRadius = "5px";
      evInput.style.border = "1px solid var(--edge-strong)";
      evInput.value = cur.evidence;
      (function(sid, inp) {
        inp.addEventListener("input", function() {
          if (!draftState.segments[sid]) draftState.segments[sid] = { decision: "", evidence: "" };
          draftState.segments[sid].evidence = inp.value;
          updateDirtyHint();
        });
      })(segId, evInput);
      evRow.appendChild(evInput);
      card.appendChild(evRow);

      host.appendChild(card);
    }
  }

  function renderAdjudicationMatches() {
    var host = el("adjudicationMatches");
    if (!host || !lastResult) return;
    host.textContent = "";

    if (!lastResult.matches || lastResult.matches.length === 0) {
      host.appendChild(textNode("div", "empty", "暂无匹配建议需要审核。"));
      return;
    }

    for (var i = 0; i < lastResult.matches.length; i += 1) {
      var match = lastResult.matches[i];
      var segId = match.segmentId;
      var card = document.createElement("div");
      card.className = "item";
      card.id = "match-card-" + segId;

      var head = document.createElement("div");
      head.className = "head";
      head.appendChild(textNode("span", "t", "段真题匹配: " + match.segmentTitle));
      head.appendChild(textNode("span", "tag", match.view));
      card.appendChild(head);

      var cur = draftState.matches[segId] || {
        disposition: "",
        evidence: "",
        paperId: null,
        targetScope: null,
        sectionId: null
      };

      var topSug = (match.suggestions && match.suggestions.length > 0) ? match.suggestions[0] : null;

      var ctrlRow = document.createElement("div");
      ctrlRow.className = "row";
      ctrlRow.appendChild(textNode("b", null, "匹配裁决："));

      var select = document.createElement("select");
      select.id = "match-disposition-" + segId;
      select.style.padding = "4px 8px";
      select.style.borderRadius = "5px";
      select.style.border = "1px solid var(--edge-strong)";

      var optEmpty = document.createElement("option");
      optEmpty.value = "";
      optEmpty.textContent = "-- 请选择裁决（不自动批准）--";
      select.appendChild(optEmpty);

      var optAccept = document.createElement("option");
      optAccept.value = "accepted_suggestion";
      optAccept.textContent = "接受机器建议 (accepted_suggestion)";
      if (!topSug) optAccept.disabled = true;
      select.appendChild(optAccept);

      var optReject = document.createElement("option");
      optReject.value = "rejected_suggestion";
      optReject.textContent = "否决机器建议 (rejected_suggestion)";
      if (!topSug) optReject.disabled = true;
      select.appendChild(optReject);

      var optUnmatched = document.createElement("option");
      optUnmatched.value = "intentionally_unmatched";
      optUnmatched.textContent = "标记有意不匹配 (intentionally_unmatched)";
      select.appendChild(optUnmatched);

      select.value = cur.disposition;
      (function(sid, sel, sug) {
        sel.addEventListener("change", function() {
          if (!draftState.matches[sid]) {
            draftState.matches[sid] = {
              disposition: "", evidence: "", paperId: null, targetScope: null, sectionId: null,
              groupId: null, questionId: null
            };
          }
          var val = sel.value;
          draftState.matches[sid].disposition = val;
          if (val === "accepted_suggestion" || val === "rejected_suggestion") {
            if (sug) {
              /*
               * ── 粒度必须按**建议的实际形状**推导，不能写死 ──
               *
               * 缺陷形态（实测抓到）：这里曾经写死
               *   targetScope = "section"
               * 同时又把 sug.groupId 抄进去 —— 于是产生
               *   { targetScope: "section", groupId: "reading.careful_reading#g1" }
               * 这个组合**自相矛盾**：大题粒度不应带题组。
               *
               * 后果不是"保存被拒"（形状校验会发现），而是**整条建链路径
               * 走不通**：核验里的 assertScopeShape 会拒绝它，而人看到的是
               * "核验失败" —— 明明他选的正是机器提出的那条建议。
               *
               * 因此粒度由建议的字段推导：有 questionId 则 question，
               * 有 groupId 则 group，否则 section。这与服务端
               * buildLinkPlan 与复核契约的约定完全一致。
               *
               * 注意：本文件是 String.raw 原文，注释里**不得出现反引号** ——
               * 它会提前结束模板字符串（F1 缺陷形态）。由
               * tests/course-a3-workbench.test.ts 的源码级门禁守护。
               */
              var scope = sug.questionId ? "question" : (sug.groupId ? "group" : "section");
              draftState.matches[sid].paperId = sug.paperId;
              draftState.matches[sid].targetScope = scope;
              draftState.matches[sid].sectionId = sug.sectionId || "section_main";
              draftState.matches[sid].groupId = scope === "section" ? null : (sug.groupId || null);
              draftState.matches[sid].questionId = scope === "question" ? (sug.questionId || null) : null;
            }
          } else {
            draftState.matches[sid].paperId = null;
            draftState.matches[sid].targetScope = null;
            draftState.matches[sid].sectionId = null;
            draftState.matches[sid].groupId = null;
            draftState.matches[sid].questionId = null;
          }
          updateDirtyHint();
        });
      })(segId, select, topSug);
      ctrlRow.appendChild(select);
      card.appendChild(ctrlRow);

      if (topSug) {
        var sugInfo = document.createElement("p");
        sugInfo.className = "mono";
        sugInfo.textContent = "参考机器建议：" + topSug.paperId + " · " + topSug.label + " (得分: " + topSug.score.toFixed(4) + ")";
        card.appendChild(sugInfo);
      }

      var evRow = document.createElement("div");
      evRow.className = "stack";
      evRow.appendChild(textNode("label", null, "裁决依据（≥10 个字符）："));
      var evInput = document.createElement("input");
      evInput.type = "text";
      evInput.id = "match-evidence-" + segId;
      evInput.placeholder = "请填写匹配判断依据（至少 10 字符）";
      evInput.style.padding = "4px 8px";
      evInput.style.borderRadius = "5px";
      evInput.style.border = "1px solid var(--edge-strong)";
      evInput.value = cur.evidence;
      (function(sid, inp) {
        inp.addEventListener("input", function() {
          if (!draftState.matches[sid]) {
            draftState.matches[sid] = { disposition: "", evidence: "", paperId: null, targetScope: null, sectionId: null, groupId: null, questionId: null };
          }
          draftState.matches[sid].evidence = inp.value;
          updateDirtyHint();
        });
      })(segId, evInput);
      evRow.appendChild(evInput);
      card.appendChild(evRow);

      host.appendChild(card);
    }
  }

  /**
   * 收集当前草稿载荷。
   *
   * ── 绑定摘要**不在这里兜底**（P0-F1 修复的核心）──
   *
   * candidateChecksum / canonicalLibraryDigest 必须来自服务端现场重算的
   * 真实值。若还没取得（没通过校验 / 没加载草稿），就留空字符串 ——
   * 服务端会以"摘要形态不合法"拒绝，而不是让全零串蒙混过关。
   */
  function collectDraftPayload() {
    var reviewer = (el("reviewerInput") && el("reviewerInput").value.trim()) || draftState.reviewer;
    var courseId = (el("courseIdInput") && el("courseIdInput").value.trim()) || draftState.courseId;
    var now = new Date();
    var yyyy = now.getFullYear();
    var mm = String(now.getMonth() + 1).padStart(2, "0");
    var dd = String(now.getDate()).padStart(2, "0");
    var today = yyyy + "-" + mm + "-" + dd;

    var mgList = [];
    var mgKeys = Object.keys(draftState.materialGroupings);
    for (var i = 0; i < mgKeys.length; i += 1) {
      var item = draftState.materialGroupings[mgKeys[i]];
      if (item.decision) {
        mgList.push({
          proposalId: mgKeys[i],
          decision: item.decision,
          evidence: item.evidence || ""
        });
      }
    }

    var segList = [];
    var sKeys = Object.keys(draftState.segments);
    for (var j = 0; j < sKeys.length; j += 1) {
      var sItem = draftState.segments[sKeys[j]];
      if (sItem.decision) {
        segList.push({
          segmentId: sKeys[j],
          decision: sItem.decision,
          evidence: sItem.evidence || ""
        });
      }
    }

    var matchList = [];
    var mKeys = Object.keys(draftState.matches);
    for (var k = 0; k < mKeys.length; k += 1) {
      var mItem = draftState.matches[mKeys[k]];
      if (mItem.disposition) {
        matchList.push({
          segmentId: mKeys[k],
          disposition: mItem.disposition,
          evidence: mItem.evidence || "",
          paperId: mItem.paperId,
          targetScope: mItem.targetScope,
          sectionId: mItem.sectionId,
          groupId: mItem.groupId || null,
          questionId: mItem.questionId || null
        });
      }
    }

    return {
      courseId: courseId,
      reviewer: reviewer,
      reviewedAt: today,
      // 只有服务端重算出的真实值才会被填在这里；否则留空让服务端拒绝
      candidateChecksum: binding.candidateChecksum || "",
      canonicalLibraryDigest: binding.canonicalLibraryDigest || "",
      sourceDigest: (lastResult && lastResult.sourceDigest) || "",
      verifiedScope: ["materials", "segments", "canonical_matches"],
      notVerified: [],
      materialGroupings: mgList,
      segments: segList,
      matches: matchList
    };
  }

  function handleValidateDraft() {
    var payload = collectDraftPayload();
    setNotice("adjudicationNotice", "info", "正在校验当前审核草稿…", null);

    // 前端即时校验（快速反馈给用户）
    var localErrors = [];
    if (!payload.reviewer) localErrors.push("审核人姓名缺失");
    if (!payload.courseId) localErrors.push("课程标识缺失");
    for (var i = 0; i < payload.materialGroupings.length; i += 1) {
      var mg = payload.materialGroupings[i];
      if (!mg.evidence || mg.evidence.trim().length < 10) {
        localErrors.push("材料分组审核依据不足 10 个字符");
        break;
      }
    }
    for (var j = 0; j < payload.segments.length; j += 1) {
      var seg = payload.segments[j];
      if (!seg.evidence || seg.evidence.trim().length < 10) {
        localErrors.push("课程分段审核依据不足 10 个字符");
        break;
      }
    }
    for (var k = 0; k < payload.matches.length; k += 1) {
      var m = payload.matches[k];
      if (!m.evidence || m.evidence.trim().length < 10) {
        localErrors.push("真题匹配审核依据不足 10 个字符");
        break;
      }
    }
    if (localErrors.length > 0) {
      setNotice("adjudicationNotice", "err", "审核草稿校验未通过：" + localErrors.join("；"),
        "请核实审核人、每条裁决的选择及至少 10 字符的审核依据。");
      return Promise.resolve();
    }

    return request(ENDPOINTS.validateDraft, {
      method: "POST",
      body: payload
    }).then(function(res) {
      if (!res.ok || !res.body || !res.body.ok) {
        var errs = (res.body && res.body.validation && res.body.validation.errors) ||
          [(res.body && res.body.error) || "校验失败"];
        binding.candidateMissing = res.body && res.body.candidateMissing === true;
        renderBindingPanel();
        setNotice("adjudicationNotice", "err", "审核草稿校验未通过：" + errs.join("；"),
          errs.some(function (e) { return String(e).indexOf("候选") >= 0; })
            ? "请先运行 pnpm course:extract 生成本课程的候选，再回到本页。"
            : "请核实审核人、每条裁决的选择及至少 10 字符的审核依据。");
        return;
      }
      // 服务端回传**现场重算**的绑定身份 —— 之后保存都基于它
      if (res.body.rebound) {
        binding.candidateChecksum = res.body.rebound.candidateChecksum;
        binding.canonicalLibraryDigest = res.body.rebound.canonicalLibraryDigest;
      }
      binding.candidateMissing = res.body.candidateExists === false;
      renderBindingPanel();
      setNotice("adjudicationNotice", "ok",
        "审核草稿校验通过！已确认绑定的候选校验和与真题库摘要（服务端现场重算），可以保存。", null);
    }).catch(function(err) {
      setNotice("adjudicationNotice", "err", "校验请求失败：" + (err.message || String(err)), "请重试");
    });
  }

  function handleSaveDraft() {
    var payload = collectDraftPayload();
    var stateSpan = el("saveDraftState");
    if (stateSpan) stateSpan.textContent = "正在安全保存…";
    setNotice("adjudicationNotice", "info", "正在写入复核记录与备份…", null);

    return request(ENDPOINTS.saveDraft, {
      method: "POST",
      body: payload
    }).then(function(res) {
      if (!res.ok || !res.body || !res.body.ok) {
        var msg = (res.body && res.body.errors && res.body.errors.join("；")) ||
          (res.body && res.body.error) || "保存失败";
        setNotice("adjudicationNotice", "err", "保存未通过：" + msg,
          String(msg).indexOf("候选") >= 0
            ? "请先运行 pnpm course:extract 生成本课程的候选，再回到本页。"
            : "请修正后重新保存");
        if (stateSpan) stateSpan.textContent = "保存失败";
        return;
      }
      var backupNote = res.body.hasBackup ? "（旧版已自动备份）" : "";
      // 只显示**相对标签**，绝不显示绝对路径
      setNotice("adjudicationNotice", "ok",
        "人工审核记录已原子安全保存 " + backupNote + "。位置：" + (res.body.fileLabel || "（本机私有目录）"), null);
      if (stateSpan) stateSpan.textContent = "已成功保存";
      savedSnapshot = payload;
      updateDirtyHint();
      say("已成功安全保存人工审核记录。");
    }).catch(function(err) {
      setNotice("adjudicationNotice", "err", "保存请求中断：" + (err.message || String(err)), "请重试");
      if (stateSpan) stateSpan.textContent = "保存异常";
    });
  }

  function handleLoadDraft() {
    var courseId = (el("courseIdInput") && el("courseIdInput").value.trim()) || draftState.courseId;
    if (!courseId) {
      setNotice("adjudicationNotice", "warn", "请先填写课程标识 (courseId)。", null);
      return;
    }
    setNotice("adjudicationNotice", "info", "正在读取已有审核草稿…", null);
    return request(ENDPOINTS.loadDraft + "?courseId=" + encodeURIComponent(courseId)).then(function(res) {
      // 形状：{ ok, draft: { review: {exists, raw, validation}, plan: {exists, raw, issues} } }
      var review = res.body && res.body.draft && res.body.draft.review;
      if (!res.ok || !res.body || !res.body.ok || !review || !review.exists) {
        setNotice("adjudicationNotice", "info", "未发现已存在的 review.json 审核草稿。", null);
        return;
      }
      var raw = review.raw;
      if (raw) {
        if (raw.reviewer && el("reviewerInput")) el("reviewerInput").value = raw.reviewer;
        // 已保存草稿携带的绑定摘要作为当前绑定（保存时仍由服务端核对）
        if (/^[0-9a-f]{64}$/.test(raw.candidateChecksum || "")) {
          binding.candidateChecksum = raw.candidateChecksum;
        }
        if (/^[0-9a-f]{64}$/.test(raw.canonicalLibraryDigest || "")) {
          binding.canonicalLibraryDigest = raw.canonicalLibraryDigest;
        }
        if (raw.materialGroupings) {
          for (var i = 0; i < raw.materialGroupings.length; i += 1) {
            var g = raw.materialGroupings[i];
            draftState.materialGroupings[g.proposalId] = { decision: g.decision, evidence: g.evidence };
          }
        }
        if (raw.segments) {
          for (var j = 0; j < raw.segments.length; j += 1) {
            var s = raw.segments[j];
            draftState.segments[s.segmentId] = { decision: s.decision, evidence: s.evidence };
          }
        }
        if (raw.matches) {
          for (var k = 0; k < raw.matches.length; k += 1) {
            var m = raw.matches[k];
            draftState.matches[m.segmentId] = {
              disposition: m.disposition,
              evidence: m.evidence,
              paperId: m.paperId,
              targetScope: m.targetScope,
              sectionId: m.sectionId,
              groupId: m.groupId || null,
              questionId: m.questionId || null
            };
          }
        }
        savedSnapshot = collectDraftPayload();
        renderBindingPanel();
        renderAdjudicationSections();
        updateDirtyHint();
        setNotice("adjudicationNotice", "ok",
          "成功加载已有草稿（审核人: " + raw.reviewer + "，审核日期: " + raw.reviewedAt + "）。", null);
      }
    }).catch(function(err) {
      setNotice("adjudicationNotice", "err", "加载草稿失败：" + (err.message || String(err)), null);
    });
  }

  /** 加载既有分段计划（只读展示；修改结构请用 course:segment）。 */
  function handleLoadPlan() {
    var courseId = (el("courseIdInput") && el("courseIdInput").value.trim()) || draftState.courseId;
    if (!courseId) {
      setNotice("planNotice", "warn", "请先填写课程标识 (courseId)。", null);
      return;
    }
    setNotice("planNotice", "info", "正在读取已有分段计划…", null);
    return request(ENDPOINTS.loadDraft + "?courseId=" + encodeURIComponent(courseId)).then(function(res) {
      var plan = res.body && res.body.draft && res.body.draft.plan;
      if (!res.ok || !res.body || !res.body.ok || !plan || !plan.exists) {
        setNotice("planNotice", "info", "未发现已存在的分段计划。", null);
        currentPlan = null;
        renderPlanSummary();
        return;
      }
      currentPlan = plan.raw;
      renderPlanSummary();
      setNotice("planNotice", "ok",
        "已加载分段计划：" + (plan.raw && plan.raw.units ? plan.raw.units.length + " 个单元" : "（计划不可读）"), null);
    }).catch(function(err) {
      setNotice("planNotice", "err", "加载分段计划失败：" + (err.message || String(err)), null);
    });
  }

  function renderPlanSummary() {
    var host = el("planSummary");
    if (!host) return;
    host.textContent = "";
    if (!currentPlan) {
      host.appendChild(textNode("div", null, "（没有加载分段计划）"));
      return;
    }
    var lines = [
      "作者：" + (currentPlan.author || "（未记录）"),
      "单元数：" + (currentPlan.units ? currentPlan.units.length : 0),
      "源摘要：" + shortDigest(currentPlan.binding ? currentPlan.binding.sourceDigest : ""),
      "说明：" + (currentPlan.reason || "（未填写）")
    ];
    for (var i = 0; i < lines.length; i += 1) {
      host.appendChild(textNode("div", null, lines[i]));
    }
  }

  /**
   * 保存人工分段计划。
   *
   * 载荷**只含结构**（author / reason / units），binding 由服务端现算。
   * 若当前没有已加载计划，则明确拒绝 —— 本界面不发明结构。
   */
  function handleSavePlan() {
    if (!currentPlan) {
      setNotice("planNotice", "warn",
        "还没有可保存的分段计划。请先点「加载已有分段计划」，或用 pnpm course:segment 生成。", null);
      return;
    }
    var courseId = (el("courseIdInput") && el("courseIdInput").value.trim()) || draftState.courseId;
    var stateSpan = el("savePlanState");
    if (stateSpan) stateSpan.textContent = "正在保存分段计划…";
    setNotice("planNotice", "info", "正在写入分段计划并计算绑定…", null);

    return request(ENDPOINTS.savePlan, {
      method: "POST",
      body: {
        courseId: courseId,
        author: currentPlan.author || "unknown",
        reason: currentPlan.reason || "",
        units: (currentPlan.units || []).map(function (unit) {
          return {
            title: unit.title,
            kind: unit.kind,
            assignments: (unit.assignments || []).map(function (a) {
              return {
                channel: a.channel,
                assetKey: a.range ? a.range.assetKey : "",
                page: a.range ? a.range.page : 0,
                lineStart: a.range ? a.range.lineStart : 0,
                lineEnd: a.range ? a.range.lineEnd : 0,
                note: a.note || null
              };
            })
          };
        })
      }
    }).then(function(res) {
      if (!res.ok || !res.body || !res.body.ok) {
        var msg = (res.body && res.body.errors && res.body.errors.join("；")) ||
          (res.body && res.body.error) || "保存失败";
        setNotice("planNotice", "err", "分段计划保存未通过：" + msg, "请修正后重试");
        if (stateSpan) stateSpan.textContent = "保存失败";
        return;
      }
      setNotice("planNotice", "ok",
        (res.body.message || "分段计划已保存。") +
        " 位置：" + (res.body.fileLabel || "（本机私有目录）") +
        (res.body.hasBackup ? "（旧版已自动备份）" : ""), null);
      if (stateSpan) stateSpan.textContent = "已成功保存";
      say("已成功保存人工分段计划。");
    }).catch(function(err) {
      setNotice("planNotice", "err", "保存请求中断：" + (err.message || String(err)), "请重试");
      if (stateSpan) stateSpan.textContent = "保存异常";
    });
  }

  function showStep(step) {
    var panels = ["step1", "step2", "step3", "step4", "step5"];
    for (var index = 0; index < panels.length; index += 1) {
      var panel = el(panels[index]);
      if (!panel) continue;
      var number = index + 1;
      var available = number === 1 || lastResult !== null;
      panel.hidden = !(number === step) || !available;
    }
    for (var b = 1; b <= 5; b += 1) {
      var button = el("stepBtn" + b);
      if (!button) continue;
      button.disabled = b !== 1 && lastResult === null;
      if (b === step) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    if (step === 5) {
      initAdjudicationView();
    }
    say("已切换到第 " + step + " 步。");
  }

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
        el("pickState").textContent = "已选择：" + state.sourceLabel + "（本机目录）";
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
      if (body.outcome === "selected") {
        setNotice("globalNotice", "ok", "已选择文件夹：" + (body.sourceLabel || "（已选择）"), null);
        el("pickState").textContent = "已选择：" + (body.sourceLabel || "（已选择）");
        el("treeWrap").hidden = false;
        selectedDirs = { "": true };
        excludedFiles = {};
        showStep(1);
        return loadTreeFromInspection();
      }
      if (body.outcome === "cancelled") {
        setNotice("globalNotice", "info", "没有选择文件夹（已取消）。", "想继续时再点一次「选择课程文件夹…」。");
        el("pickState").textContent = state.hasSource
          ? "已选择：" + state.sourceLabel
          : "还没有选择文件夹。";
        return;
      }
      setNotice("globalNotice", "err", body.detail || "文件夹选择窗口没能打开。", "请重试。");
    }).catch(function () {
      setBusy(false);
      setNotice("globalNotice", "err", "和本机服务的连接中断了。", "请重试。");
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
      setNotice("globalNotice", "warn", "还没有选择任何文件。", "请至少勾选一个文件再点检查。");
      return;
    }
    setNotice("globalNotice", "", "");
    el("inspect").disabled = true;
    setBusy(true, "正在检查所选材料…");

    var includeDirs = Object.keys(selectedDirs);
    var excludeFiles = Object.keys(excludedFiles);

    return request(ENDPOINTS.inspect, {
      method: "POST",
      body: { includeDirectories: includeDirs, excludeFiles: excludeFiles }
    }).then(function (result) {
      setBusy(false);
      if (!result.ok || !result.body || result.body.ok !== true) {
        setNotice("globalNotice", "err", describeFailure(result, "这次检查没有完成。"), "请重试。");
        el("inspect").disabled = false;
        return;
      }
      lastResult = result.body.result;
      renderCards(lastResult);
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
      setNotice("globalNotice", "ok", "检查完成：已清点 " + lastResult.counts.selected + " 个文件，已进入可审核状态。", null);
      say("检查完成。可以进入人工裁决与审核流程。");
    }).catch(function (err) {
      /*
       * ── 网络失败与渲染失败必须分开报告 ──
       *
       * 两者都在这个 catch 里落地，但处置完全不同：网络失败要人重试，
       * 渲染失败是缺陷（页面无法呈现已取得的真实结果）。把渲染错误
       * 说成"检查请求中断"会让人反复重试一个其实已经成功的检查。
       */
      setBusy(false);
      el("inspect").disabled = false;
      var message = err && err.message ? String(err.message) : "";
      if (message.indexOf("Failed to fetch") >= 0 || message.indexOf("NetworkError") >= 0 || message === "") {
        setNotice("globalNotice", "err", "和本机服务的连接中断了。", "请确认工作台仍在运行，然后重试。");
      } else {
        setNotice("globalNotice", "err",
          "检查已完成，但页面渲染结果时出错：" + message,
          "这是一处界面缺陷（结果本身已取得）。请刷新页面重试，并把这条信息反馈给维护者。");
      }
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
    el("pickState").textContent = "请选择一个新的文件夹。";
    refreshControls();
    showStep(1);
    return pickFolder();
  }

  function loadTreeFromInspection() {
    setBusy(true, "正在列出文件夹内容…");
    return request(ENDPOINTS.browse).then(function (result) {
      setBusy(false);
      if (!result.ok || !result.body || result.body.ok !== true || !result.body.metadata) {
        setNotice("globalNotice", "err", describeFailure(result, "没能列出这个文件夹的内容。"), "请重试。");
        return null;
      }
      tree = result.body.metadata;
      selectedDirs = { "": true };
      excludedFiles = {};
      expanded = {};
      for (var directoryIndex = 0; directoryIndex < tree.directories.length; directoryIndex += 1) {
        expanded[tree.directories[directoryIndex]] = true;
      }
      renderTree();
      updateSelectionSummary();
      return null;
    }).catch(function () {
      setBusy(false);
      setNotice("globalNotice", "err", "和本机服务的连接中断了。", "请重试。");
      return null;
    });
  }

  function wire() {
    var pickBtn = el("pick");
    if (pickBtn) pickBtn.addEventListener("click", function () { pickFolder(); });
    var change = el("changeDir");
    if (change) change.addEventListener("click", function () { changeDir(); });
    var rescanBtn = el("rescan");
    if (rescanBtn) rescanBtn.addEventListener("click", function () { rescan(); });
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
        "A2 工作台提供材料分组、课程分段与真题匹配的人工审核及原子安全保存能力。不会自动替用户批准任何建议。",
        "按步骤检查后可在第 ⑤ 步保存人工裁决并备份。");
      say("已显示说明。");
    });

    var btnVal = el("validateDraftBtn");
    if (btnVal) btnVal.addEventListener("click", function() { handleValidateDraft(); });

    var btnSave = el("saveDraftBtn");
    if (btnSave) btnSave.addEventListener("click", function() { handleSaveDraft(); });

    var btnLoad = el("loadExistingDraftBtn");
    if (btnLoad) btnLoad.addEventListener("click", function() { handleLoadDraft(); });

    var btnLoadPlan = el("loadExistingPlanBtn");
    if (btnLoadPlan) btnLoadPlan.addEventListener("click", function() { handleLoadPlan(); });

    var btnSavePlan = el("savePlanBtn");
    if (btnSavePlan) btnSavePlan.addEventListener("click", function() { handleSavePlan(); });

    var btnPreviewCandidate = el("previewCandidateBtn");
    if (btnPreviewCandidate) btnPreviewCandidate.addEventListener("click", function() { handlePreviewCandidate(); });

    var btnGenerateCandidate = el("generateCandidateBtn");
    if (btnGenerateCandidate) btnGenerateCandidate.addEventListener("click", function() { handleGenerateCandidate(); });

    var reviewerInput = el("reviewerInput");
    if (reviewerInput) reviewerInput.addEventListener("input", function() { updateDirtyHint(); });
    var courseIdInput = el("courseIdInput");
    if (courseIdInput) {
      courseIdInput.addEventListener("input", function() {
        draftState.courseId = courseIdInput.value.trim();
        updateDirtyHint();
        loadBinding();
      });
    }

    for (var step = 1; step <= 5; step += 1) {
      (function (number) {
        var button = el("stepBtn" + number);
        if (button) button.addEventListener("click", function () { showStep(number); });
      })(step);
    }
  }

  // ── A1 → A2 断点：生成课程候选 ──
  //
  // ── 为什么是**两步**（预演 → 授权）而不是一个按钮 ──
  //
  // 生成候选会替换已有候选目录（旧候选备份为 .prev-*），从而让已签署的
  // 审核记录**立即失效**。因此必须在授权前让人看到：
  // 会生成多少个段、有没有阻断级事项、旧候选会不会被替换。
  // 一个按钮做不到这件事 —— 它把人推进一个未知后果。
  var candidatePreview = null;

  /**
   * 把当前**检查范围**导出成可提交的选择范围。
   *
   * ── 为什么候选生成必须带上它 ──
   *
   * 界面从第 ① 步就在收集"勾了哪些目录、去掉了哪些文件"，而 A1 的检查
   * 用这份数据做排除。若候选生成不带它，产物就会读整棵源根 ——
   * 于是"我在界面上排除了一个文件"与"候选里仍然包含它"悄悄分叉，
   * 而两边都看起来正常（独立评审指出的正是这一点）。
   *
   * 契约与 A1 的检查负载**逐字段相同**（includeDirectories / excludeFiles），
   * 因此两条入口表达同一个语义，不存在第二套选择判据。
   */
  function selectionPayload() {
    return {
      includeDirectories: Object.keys(selectedDirs),
      excludeFiles: Object.keys(excludedFiles)
    };
  }

  function candidatePayload() {
    var title = el("candTitle") ? String(el("candTitle").value || "").trim() : "";
    var provider = el("candProvider") ? String(el("candProvider").value || "").trim() : "";
    var versionRaw = el("candVersion") ? Number(el("candVersion").value) : 1;
    var version = Number.isInteger(versionRaw) && versionRaw >= 1 ? versionRaw : 1;
    var selection = selectionPayload();
    /*
     * ── 没有有效选择时**不提交** selection ──
     *
     * 一个空的 includeDirectories 在服务端的语义是"不检查任何内容"
     * （buildSourceSelection 会排除掉所有文件）。若界面还没进入第 ② 步
     * （用户没勾任何东西），提交空选择会让候选变成**空包**。
     *
     * 因此这里的判据是"用户是否真的已经做过一次检查"：
     * - 做过 ⇒ 带上选择（哪怕只勾了部分目录）；
     * - 没做过 ⇒ 不带（保持整根语义，与 CLI 一致），并在界面明确提示。
     */
    var hasSelection = selection.includeDirectories.length > 0;
    return {
      courseId: draftState.courseId,
      title: title,
      provider: provider,
      contentVersion: version,
      selection: hasSelection ? selection : null
    };
  }

  function renderCandidatePreview(preview) {
    var host = el("candidatePreview");
    if (!host) return;
    host.textContent = "";
    if (!preview) return;

    var box = document.createElement("div");
    box.className = "notice info";
    box.appendChild(textNode("div", null,
      "将生成：材料 " + preview.materialCount + " 份 · 课程段 " + preview.segmentCount +
      " 个 · 资产 " + preview.assetCount + " 个；阻断级复核事项 " + preview.blockingReviewCount + " 条。"));
    box.appendChild(textNode("div", "mono",
      "新候选校验和：" + shortDigest(preview.newCandidateChecksum)));

    /*
     * ── 显式列出**有效选择范围** ──
     *
     * 这是本修复的界面验收点：人必须能亲眼确认"候选只覆盖我勾的那部分"，
     * 而不是事后从候选内容里反推。刻意显示"排除了几个文件"的**计数**，
     * 因为那正是最容易与真实产物分叉的数字。
     */
    if (preview.selection) {
      var scopeBox = document.createElement("div");
      scopeBox.className = "why";
      scopeBox.setAttribute("data-selection-scope", "active");
      scopeBox.textContent =
        "本次候选**只覆盖你勾选的范围**：勾选 " + preview.selection.includeDirectoryCount +
        " 个目录、排除 " + preview.selection.excludeFileCount + " 个文件。" +
        "被排除的内容不会进入候选、不会影响源摘要，也不会参与真题匹配。";
      box.appendChild(scopeBox);
    } else {
      var wholeRoot = document.createElement("div");
      wholeRoot.className = "notice warn";
      wholeRoot.setAttribute("data-selection-scope", "whole-root");
      wholeRoot.textContent =
        "注意：这次预演**没有**带上检查范围 —— 候选将读取整棵源文件夹。" +
        "若你在第 ② 步去掉过某些文件，请先回到第 ① 步重新检查一次。";
      box.appendChild(wholeRoot);
    }

    if (preview.willReplaceExisting) {
      var warn = document.createElement("div");
      warn.className = "fix";
      warn.textContent = "注意：同名候选已存在 —— 生成会把旧候选备份为 .prev-*，" +
        "新候选的校验和与旧的不同 ⇒ **已签署的审核记录会立即失效**，必须重新审核。";
      box.appendChild(warn);
    }
    if (preview.blockingReviewCount > 0) {
      var b = document.createElement("div");
      b.className = "why";
      b.textContent = "阻断级事项（需要你在第 ⑤ 步逐条处置）：";
      box.appendChild(b);
      var ul = document.createElement("ul");
      ul.className = "plain";
      for (var i = 0; i < preview.blockingReviewItems.length && i < 8; i += 1) {
        var li = document.createElement("li");
        li.textContent = preview.blockingReviewItems[i].code + "@" + preview.blockingReviewItems[i].where +
          " —— " + preview.blockingReviewItems[i].detail;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    if (preview.canonicalFailures && preview.canonicalFailures.length > 0) {
      box.appendChild(textNode("div", "why",
        preview.canonicalFailures.length + " 份真题包读取失败 —— 匹配是在不完整的库上做的，" +
        "因此「未匹配」与「最高分建议」都不可全信。"));
    }
    host.appendChild(box);
  }

  function refreshCandidateControls() {
    var btn = el("generateCandidateBtn");
    if (!btn) return;
    var hasPreview = candidatePreview !== null;
    var hasCourseId = Boolean(draftState.courseId);
    btn.disabled = busy || !hasPreview || !hasCourseId;
  }

  function handlePreviewCandidate() {
    if (!draftState.courseId) {
      setNotice("candidateNotice", "err", "请先填写「课程标识」（它会成为候选目录名）。");
      return;
    }
    setBusy(true, "正在预演生成候选（不写入）…");
    request(ENDPOINTS.previewCandidate, { method: "POST", body: candidatePayload() })
      .then(function (res) {
        if (!res.body || res.body.ok !== true) {
          setNotice("candidateNotice", "err",
            "预演失败：" + ((res.body && res.body.error) || res.raw));
          return;
        }
        candidatePreview = res.body.preview;
        setNotice("candidateNotice", "ok",
          "预演完成（**没有写任何文件**）。核对下面的数量后，点「确认生成候选」才会真正写入。");
        renderCandidatePreview(candidatePreview);
        refreshCandidateControls();
      })
      .catch(function (error) {
        setNotice("candidateNotice", "err", "预演失败：" + error.message);
      })
      .then(function () { setBusy(false); refreshCandidateControls(); });
  }

  function handleGenerateCandidate() {
    if (!candidatePreview) {
      setNotice("candidateNotice", "err", "请先预演一次 —— 授权前必须看清会生成什么。");
      return;
    }
    setBusy(true, "正在生成候选…");
    var payload = candidatePayload();
    // **显式授权**：服务端会拒绝没有这个字段的请求
    payload.confirmed = true;
    request(ENDPOINTS.generateCandidate, { method: "POST", body: payload })
      .then(function (res) {
        if (!res.body || res.body.ok !== true) {
          setNotice("candidateNotice", "err",
            "生成失败：" + ((res.body && res.body.errors ? res.body.errors.join("；") : res.body && res.body.error) || res.raw));
          return;
        }
        var body = res.body;
        var text = body.message || "候选已生成。";
        if (body.reviewInvalidated) {
          text += " 旧审核已失效，请在下面重新逐条裁决。";
        }
        setNotice("candidateNotice", "ok", text);
        candidatePreview = null;
        var host = el("candidatePreview");
        if (host) host.textContent = "";
        refreshCandidateControls();
        // 候选已变 ⇒ 绑定身份随之变化，必须刷新
        loadBinding();
      })
      .catch(function (error) {
        setNotice("candidateNotice", "err", "生成失败：" + error.message);
      })
      .then(function () { setBusy(false); refreshCandidateControls(); });
  }

  function boot() {
    wire();
    if (!token) {
      setNotice("globalNotice", "err", "这个页面缺少会话凭据，因此不能读取任何内容。", "请复制完整网址重试。");
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
