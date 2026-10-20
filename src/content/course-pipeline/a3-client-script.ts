/**
 * A3 受控课程接入工作台 · 客户端脚本（原始字符串内联）。
 *
 * ── 铁律（与 A1 / A2 相同，且由测试守护）──
 *
 * 1. 本文件导出的是 `String.raw` 原文，工具链逐字节照发；
 * 2. **禁止任何插值** —— 两层转义会让 `\n` 在外层被消费，
 *    发给浏览器的 JS 字符串字面量被换行截断，整页交互全死
 *    而 HTTP 仍 200（既有 F1 缺陷形态）；
 * 3. 正文只经 `textContent` 进入 DOM，不用 `innerHTML`。
 *
 * ── 并发写入保护 ──
 *
 * 三个写操作各自带一个 `inFlight` 标志：进行中时**所有**写按钮禁用。
 * 这不是"防止用户连点两次"的体验优化，而是防止两次并发写入
 * 把备份目录名撞成同一份（那会覆盖唯一的恢复点）。
 */

export const A3_CLIENT_SCRIPT = String.raw`
"use strict";
(function () {
  var TOKEN_HEADER = "x-cet6-session-token";
  var ENDPOINTS = {
    previewPromotion: "/api/intake/preview-promotion",
    promote: "/api/intake/promote",
    importIndex: "/api/intake/import-index",
    link: "/api/intake/link",
    progress: "/api/intake/progress"
  };

  var STATUS_LABELS = {
    PROMOTABLE: "可以晋升",
    REVIEW_REQUIRED: "还缺人工决定",
    BLOCKED: "当前不可晋升"
  };

  var token = null;
  var busy = false;
  var inFlight = { promote: false, import: false, link: false };
  var preview = null;
  var progress = null;
  var linkPreview = null;

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

  function shortDigest(value) {
    if (typeof value !== "string" || value.length < 12) return String(value || "（未知）");
    return value.slice(0, 12) + "…";
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
      return response.text().then(function (text) {
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
        return { status: response.status, body: parsed, raw: text };
      });
    });
  }

  function currentCourseId() {
    var input = el("courseIdInput");
    return input ? String(input.value || "").trim() : "";
  }

  function setBusy(next, message) {
    busy = next;
    if (next && message) say(message);
    refreshControls();
  }

  // ── 步骤条：明确显示"某一步已成功、下一步尚未执行" ──
  //
  // ── 为什么把"步骤名"与"进度字段名"分开映射 ──
  //
  // 进度对象来自服务端的 A3Progress，它的字段是**过去分词**
  // （promoted / imported / linked），而步骤名是动词。
  // 曾经这里直接按步骤名取字段 —— 于是 progress["promote"] 永远是
  // undefined，读取它的 .at 立刻抛异常（Cannot read properties of
  // undefined）。
  //
  // 后果不是"显示不对"，而是**整条晋升路径在浏览器里走不通**：
  // 服务端其实已经完全成功，界面却在渲染进度时崩掉，用户看到的是
  // "晋升失败"。这类"服务端对、界面说失败"的缺陷只有真实浏览器能发现 ——
  // 服务层测试里 promoteCourseCandidate 一直是绿的。
  //
  // 注意：本文件是 String.raw 原文，**反引号会提前结束模板字符串**。
  // 因此注释里一律不用反引号 —— 那正是既有 F1 缺陷（两层转义把脚本
  // 截断，整页交互全死而 HTTP 仍 200）的同一形态。
  function progressFieldOf(stepKey) {
    if (stepKey === "promote") return "promoted";
    if (stepKey === "import") return "imported";
    return "linked";
  }

  function progressEntryFor(stepKey) {
    if (!progress) return null;
    var field = progressFieldOf(stepKey);
    var entry = progress[field];
    return entry && typeof entry === "object" ? entry : null;
  }

  function renderSteps() {
    var host = el("stepList");
    if (!host) return;
    host.textContent = "";

    var steps = [
      { key: "promote", label: "晋升为正式课程包", detail: "写入 courses/" + (currentCourseId() || "<课程标识>") },
      { key: "import", label: "写入课程索引", detail: "写入数据库；首次触发 v8 → v9 迁移" },
      { key: "link", label: "建立真题链接", detail: "写入不可变的人工复核行" }
    ];

    var done = {};
    for (var d = 0; d < steps.length; d += 1) {
      var entry = progressEntryFor(steps[d].key);
      done[steps[d].key] = Boolean(entry && entry.done === true);
    }

    var firstPending = null;
    for (var index = 0; index < steps.length; index += 1) {
      if (!done[steps[index].key] && firstPending === null) firstPending = steps[index].key;
    }

    for (var i = 0; i < steps.length; i += 1) {
      var step = steps[i];
      var state = done[step.key] ? "done" : (step.key === firstPending ? "current" : "blocked");
      var li = document.createElement("li");
      li.setAttribute("data-state", state);
      li.setAttribute("data-step", step.key);

      var dot = textNode("span", "dot", done[step.key] ? "✓" : (step.key === firstPending ? String(i + 1) : "·"));
      li.appendChild(dot);

      var body = document.createElement("div");
      body.appendChild(textNode("div", "t", step.label));
      var own = progressEntryFor(step.key);
      var detail = done[step.key]
        ? "已成功" + (own && own.at ? "（" + String(own.at) + "）" : "") + (own && own.detail ? "——" + String(own.detail) : "")
        : step.detail;
      body.appendChild(textNode("div", "d", detail));
      li.appendChild(body);
      host.appendChild(li);
    }

    var donePanel = el("donePanel");
    if (donePanel) donePanel.hidden = !(done.promote && done.import && done.link);
  }

  // ── 预演渲染 ──
  function renderPreview() {
    var body = el("previewBody");
    if (!body) return;
    body.textContent = "";
    if (!preview) {
      body.appendChild(textNode("div", "empty", "还没有预演结果。点上面的「重新预演」。"));
      return;
    }

    // 状态行
    var statusBox = document.createElement("div");
    var gatePassed = preview.gatePassed === true;
    statusBox.className = "notice " + (gatePassed ? "ok" : "warn");
    var statusText = "门禁结论：" + (STATUS_LABELS[preview.status] || preview.status);
    if (gatePassed && !preview.promotable) {
      statusText += " —— 复核可信；晋升无需再执行（目标已存在），请继续第 ② / ③ 步。";
    } else if (gatePassed) {
      statusText += " —— 可以执行下面三项。";
    } else {
      statusText += " —— 三项都不可执行（复核不可信）。";
    }
    statusBox.appendChild(textNode("div", null, statusText));
    body.appendChild(statusBox);

    // 候选摘要
    var summary = document.createElement("div");
    summary.className = "notice info";
    var candidate = preview.candidate || {};
    summary.appendChild(textNode("div", null,
      "候选：段 " + (candidate.segmentCount || 0) + " 个 · 材料 " + (candidate.materialCount || 0) +
      " 份 · 资产 " + (candidate.assetCount || 0) + " 个；阻断级复核事项 " +
      (candidate.blockingReviewItems || 0) + " 条。"));
    if (candidate.review) {
      summary.appendChild(textNode("div", "mono",
        "复核：" + candidate.review.reviewer + "（" + candidate.review.reviewedAt + "）"));
    }
    if (preview.alreadyImported) {
      summary.appendChild(textNode("div", null,
        "注意：这门课已经在索引里（v" + preview.alreadyImported.contentVersion +
        "，段 " + preview.alreadyImported.segmentCount + " 个）—— 导入这一步将是空操作。"));
    }
    body.appendChild(summary);

    // 门禁逐项
    var checks = document.createElement("div");
    checks.appendChild(textNode("h3", null, "晋升门禁逐项结果"));
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var trh = document.createElement("tr");
    trh.appendChild(textNode("th", null, "结果"));
    trh.appendChild(textNode("th", null, "检查项"));
    trh.appendChild(textNode("th", null, "说明"));
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    var checksList = preview.checks || [];
    for (var c = 0; c < checksList.length; c += 1) {
      var check = checksList[c];
      var tr = document.createElement("tr");
      tr.appendChild(textNode("td", null, check.passed ? "✓ 通过" : "✗ 未通过"));
      tr.appendChild(textNode("td", null, check.name));
      tr.appendChild(textNode("td", null, check.detail));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    checks.appendChild(table);
    body.appendChild(checks);

    // 冲突与恢复建议
    var conflicts = preview.conflicts || [];
    if (conflicts.length > 0) {
      var conflictBox = document.createElement("div");
      conflictBox.appendChild(textNode("h3", null, "冲突、陈旧与已有目标（共 " + conflicts.length + " 项）"));
      for (var k = 0; k < conflicts.length; k += 1) {
        var item = document.createElement("div");
        item.className = "notice err";
        item.appendChild(textNode("div", null, conflicts[k].detail));
        if (conflicts[k].recovery) {
          item.appendChild(textNode("div", "fix", "怎么办：" + conflicts[k].recovery));
        }
        conflictBox.appendChild(item);
      }
      body.appendChild(conflictBox);
    }

    // 链接交接计划（只展示，绝不执行）
    var plan = preview.linkPlan || {};
    var planBox = document.createElement("div");
    planBox.appendChild(textNode("h3", null, "已复核的建链计划（只展示，不会自动执行）"));
    if (!plan.allowed) {
      planBox.appendChild(textNode("div", "notice warn", plan.reason || "门禁未通过，因此没有待建链接。"));
    } else if (!plan.entries || plan.entries.length === 0) {
      planBox.appendChild(textNode("div", "notice info",
        "没有任何「接受建议」的匹配裁决 —— 因此没有待建链接。课程包可以完全未匹配地存在，那是合法状态。"));
    } else {
      var intro = textNode("p", "why", "共 " + plan.entries.length + " 条已接受的候选映射。");
      planBox.appendChild(intro);
      for (var e = 0; e < plan.entries.length; e += 1) {
        var entry = plan.entries[e];
        var wrap = document.createElement("div");
        wrap.appendChild(textNode("div", null, entry.segmentId + " · " + entry.segmentTitle + " → " + entry.targetLabel));
        var cmd = textNode("code", "cmd", entry.command);
        wrap.appendChild(cmd);
        planBox.appendChild(wrap);
      }
      planBox.appendChild(textNode("div", "notice warn",
        "这些命令只是**建议**，本界面不会执行它们。把它变成运行时真相需要你在下面第 ③ 步单独确认。"));
    }
    body.appendChild(planBox);

    // 读不到的东西
    var errors = preview.errors || [];
    if (errors.length > 0) {
      var errBox = document.createElement("div");
      for (var x = 0; x < errors.length; x += 1) {
        errBox.appendChild(textNode("div", "notice err", errors[x]));
      }
      body.appendChild(errBox);
    }
  }

  // ── 变化清单 ──
  function renderChanges() {
    var promoteChanges = el("promoteChanges");
    if (promoteChanges) {
      promoteChanges.textContent = "";
      var p = document.createElement("li");
      p.textContent = "在 private-content/courses/<课程标识>/ 下创建 course.json 与 assets/";
      promoteChanges.appendChild(p);
      var p2 = document.createElement("li");
      p2.textContent = "不会复制 candidate.json 与 review.json（候选/复核元数据不进运行时目录）";
      promoteChanges.appendChild(p2);
      var p3 = document.createElement("li");
      p3.textContent = "不会创建任何 canonical 链接、不会写数据库、不会改 planner / 模考保留";
      promoteChanges.appendChild(p3);
    }

    var importChanges = el("importChanges");
    if (importChanges) {
      importChanges.textContent = "";
      var i1 = document.createElement("li");
      i1.textContent = "先取一份数据库一致性快照，并验证它能被读回来（失败则不写入）";
      importChanges.appendChild(i1);
      var i2 = document.createElement("li");
      i2.textContent = "再备份 courses/ 目录（索引事实之外的内容）";
      importChanges.appendChild(i2);
      var i3 = document.createElement("li");
      i3.textContent = "最后写入 course_package 索引行；首次写入会执行 v8 → v9 增量迁移";
      importChanges.appendChild(i3);
      var i4 = document.createElement("li");
      i4.textContent = "整批在一个事务内，任一条目失败即整批回滚";
      importChanges.appendChild(i4);
    }

    var linkChanges = el("linkChanges");
    if (linkChanges) {
      linkChanges.textContent = "";
      var l1 = document.createElement("li");
      l1.textContent = "为每一条「接受建议」的匹配裁决追加一行不可变复核记录";
      linkChanges.appendChild(l1);
      var l2 = document.createElement("li");
      l2.textContent = "同一份主张重复写入是幂等的（不产生新行）；改出处/注解会追加新行";
      linkChanges.appendChild(l2);
      var l3 = document.createElement("li");
      l3.textContent = "写下之后不能改、不能删 —— 修正只能追加新行，旧行保留为历史";
      linkChanges.appendChild(l3);
    }
  }

  // ── 控件可用性：把"为什么不能点"如实显示出来 ──
  function refreshControls() {
    var courseId = currentCourseId();
    /*
     * 两个不同的判据，对应两个不同的问题：
     * - promotable：现在能不能**执行晋升**（门禁通过，且目标尚不存在）
     * - gatePassed：这份复核**可信吗**（可以据此建链吗）
     *
     * 晋升成功之后 promotable 会变 false，而建链仍然必须可执行 ——
     * 否则人会看到"做完第 ① 步，第 ③ 步反而变灰了"。
     */
    var promotable = Boolean(preview && preview.promotable);
    var gatePassed = Boolean(preview && preview.gatePassed);
    var promoteDone = Boolean(progressEntryFor("promote") && progressEntryFor("promote").done);
    var importDone = Boolean(progressEntryFor("import") && progressEntryFor("import").done);
    var linkDone = Boolean(progressEntryFor("link") && progressEntryFor("link").done);
    var backupReady = gatePassed && promoteDone;

    var promoteBtn = el("promoteBtn");
    if (promoteBtn) {
      promoteBtn.disabled = busy || inFlight.promote || !courseId || !promotable || promoteDone;
    }
    var importBtn = el("importBtn");
    if (importBtn) {
      importBtn.disabled = busy || inFlight.import || !courseId || !backupReady || importDone;
    }
    var linkPreviewBtn = el("linkPreviewBtn");
    if (linkPreviewBtn) {
      linkPreviewBtn.disabled = busy || inFlight.link || !courseId || !gatePassed || linkDone;
    }
    var linkCommitBtn = el("linkCommitBtn");
    if (linkCommitBtn) {
      // 默认禁用：只有**预演通过之后**才允许点"确认写入"
      linkCommitBtn.disabled =
        busy || inFlight.link || !courseId || !gatePassed || !linkPreview || !linkPreview.allowed || linkDone;
    }

    // 每个不可执行的操作都要给出原因
    var promoteBlocked = el("promoteBlocked");
    if (promoteBlocked) {
      if (promoteDone) {
        promoteBlocked.hidden = false;
        promoteBlocked.textContent = "";
        promoteBlocked.appendChild(
          textNode("div", null, "这一步已经成功完成，不需要（也不能）重复执行。请继续第 ② 步。"),
        );
      } else if (!promotable) {
        promoteBlocked.hidden = false;
        promoteBlocked.textContent = "";
        var reasons = (preview && preview.blockedReasons) || [];
        promoteBlocked.appendChild(
          textNode(
            "div",
            null,
            reasons.length > 0
              ? "晋升不可执行：" + reasons[0]
              : "晋升不可执行：门禁结论不是「可以晋升」。请先看上面的逐项结果。",
          ),
        );
      } else {
        promoteBlocked.hidden = true;
      }
    }

    var importBlocked = el("importBlocked");
    if (importBlocked) {
      if (!backupReady && !importDone) {
        importBlocked.hidden = false;
        importBlocked.textContent = "";
        importBlocked.appendChild(
          textNode(
            "div",
            null,
            "导入需要先完成第 ① 步（晋升）—— 索引只能指向一份已经落在 courses/ 里的包。",
          ),
        );
      } else {
        importBlocked.hidden = true;
      }
    }

    var linkBlocked = el("linkBlocked");
    if (linkBlocked) {
      if (linkPreview && !linkPreview.allowed) {
        linkBlocked.hidden = false;
        linkBlocked.textContent = "";
        linkBlocked.appendChild(textNode("div", null, linkPreview.reason || "建链预演未通过。"));
      } else {
        linkBlocked.hidden = true;
      }
    }
  }

  // ── 动作 ──
  function loadProgress() {
    var courseId = currentCourseId();
    if (!courseId) {
      setNotice("progressNotice", "err", "请先填课程标识。");
      return;
    }
    setBusy(true, "正在读取接入进度…");
    request(ENDPOINTS.progress + "?courseId=" + encodeURIComponent(courseId))
      .then(function (res) {
        if (res.status !== 200 || !res.body || res.body.ok !== true) {
          setNotice("progressNotice", "err", "读取进度失败：" + (res.body && res.body.error ? res.body.error : res.raw));
          return;
        }
        progress = res.body.progress;
        setNotice("progressNotice", "ok", "已读取接入进度。");
        renderSteps();
        refreshControls();
      })
      .catch(function (error) {
        setNotice("progressNotice", "err", "读取进度失败：" + error.message);
      })
      .then(function () { setBusy(false); });
  }

  function loadPreview() {
    var courseId = currentCourseId();
    if (!courseId) {
      setNotice("previewNotice", "err", "请先填课程标识。");
      return;
    }
    setBusy(true, "正在预演…");
    request(ENDPOINTS.previewPromotion + "?courseId=" + encodeURIComponent(courseId))
      .then(function (res) {
        if (res.status !== 200 || !res.body || res.body.ok !== true) {
          setNotice("previewNotice", "err",
            "预演失败：" + (res.body && res.body.error ? res.body.error : res.raw));
          return;
        }
        preview = res.body.preview;
        setNotice(
          "previewNotice",
          preview.gatePassed ? "ok" : "warn",
          preview.gatePassed
            ? "预演完成：复核可信，可以执行下面三项（仍须各自单独确认）。"
            : "预演完成：当前不可执行，请按上面的原因处理。",
        );
        renderPreview();
        refreshControls();
      })
      .catch(function (error) {
        setNotice("previewNotice", "err", "预演失败：" + error.message);
      })
      .then(function () { setBusy(false); });
  }

  function promote() {
    var courseId = currentCourseId();
    if (!courseId) return;
    inFlight.promote = true;
    refreshControls();
    say("正在晋升…");
    request(ENDPOINTS.promote, {
      method: "POST",
      body: { courseId: courseId, confirmed: true }
    }).then(function (res) {
      if (res.body && res.body.ok) {
        el("promoteResult").textContent = "已晋升";
        setNotice("globalNotice", "ok", res.body.message || "已晋升为正式课程包。");
        progress = res.body.progress || progress;
      } else {
        el("promoteResult").textContent = "失败";
        setNotice("globalNotice", "err",
          "晋升失败：" + ((res.body && res.body.error) || res.raw) +
          "。已成功的步骤不受影响，可以安全重试本步。");
      }
      renderSteps();
      refreshControls();
    }).catch(function (error) {
      el("promoteResult").textContent = "失败";
      setNotice("globalNotice", "err", "晋升失败：" + error.message);
    }).then(function () {
      inFlight.promote = false;
      refreshControls();
    });
  }

  function importIndex() {
    var courseId = currentCourseId();
    if (!courseId) return;
    inFlight.import = true;
    refreshControls();
    say("正在备份并导入…");
    request(ENDPOINTS.importIndex, {
      method: "POST",
      body: { courseId: courseId, confirmed: true }
    }).then(function (res) {
      if (res.body && res.body.ok) {
        el("importResult").textContent = "已导入";
        var detail = res.body.message || "已写入课程索引。";
        if (res.body.backup && res.body.backup.path) {
          detail += " 恢复点：" + res.body.backup.path;
        }
        setNotice("globalNotice", "ok", detail);
        progress = res.body.progress || progress;
      } else {
        el("importResult").textContent = "失败";
        setNotice("globalNotice", "err",
          "导入失败：" + ((res.body && res.body.error) || res.raw) +
          "。数据库已在同一事务内回滚；可以安全重试本步。");
      }
      renderSteps();
      refreshControls();
    }).catch(function (error) {
      el("importResult").textContent = "失败";
      setNotice("globalNotice", "err", "导入失败：" + error.message);
    }).then(function () {
      inFlight.import = false;
      refreshControls();
    });
  }

  function linkPreviewRun() {
    var courseId = currentCourseId();
    if (!courseId) return;
    inFlight.link = true;
    refreshControls();
    say("正在预演建链…");
    request(ENDPOINTS.link, {
      method: "POST",
      body: { courseId: courseId, commit: false }
    }).then(function (res) {
      var body = res.body || {};
      linkPreview = body;
      if (body.allowed) {
        setNotice("linkNotice", "ok",
          "建链预演通过：" + (body.results ? body.results.length : 0) + " 条链接校验通过。" +
          "现在「确认写入」才可点 —— 它需要你再次单独授权。");
      } else {
        setNotice("linkNotice", "err", "建链预演未通过：" + (body.error || body.reason || res.raw));
      }
      refreshControls();
    }).catch(function (error) {
      setNotice("linkNotice", "err", "建链预演失败：" + error.message);
    }).then(function () {
      inFlight.link = false;
      refreshControls();
    });
  }

  function linkCommit() {
    var courseId = currentCourseId();
    if (!courseId) return;
    inFlight.link = true;
    refreshControls();
    say("正在写入复核记录…");
    request(ENDPOINTS.link, {
      method: "POST",
      body: { courseId: courseId, commit: true }
    }).then(function (res) {
      var body = res.body || {};
      if (body.ok) {
        setNotice("globalNotice", "ok",
          (body.message || "已写入不可变复核记录。") +
          " 提醒：这些行不能改也不能删；修正只能追加新行。");
        progress = body.progress || progress;
      } else {
        setNotice("globalNotice", "err",
          "建链失败：" + (body.error || res.raw) + "。未写入任何数据（fail closed）。");
      }
      renderSteps();
      refreshControls();
    }).catch(function (error) {
      setNotice("globalNotice", "err", "建链失败：" + error.message);
    }).then(function () {
      inFlight.link = false;
      refreshControls();
    });
  }

  function showHelp() {
    setNotice("globalNotice", "info",
      "这个工作台把候选课程包正式接入产品。三个动作各自独立、都不可逆：" +
      "① 写 courses/；② 写数据库（首次触发 v8 → v9 迁移）；③ 写不可变的真题链接记录。" +
      "完成其中一项不代表批准另外两项。执行前会先取得可验证的备份快照。");
  }

  // ── 接线 ──
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

  el("loadProgressBtn").addEventListener("click", loadProgress);
  el("previewBtn").addEventListener("click", loadPreview);
  el("promoteBtn").addEventListener("click", promote);
  el("importBtn").addEventListener("click", importIndex);
  el("linkPreviewBtn").addEventListener("click", linkPreviewRun);
  el("linkCommitBtn").addEventListener("click", linkCommit);
  el("help").addEventListener("click", showHelp);
  el("courseIdInput").addEventListener("input", function () { renderSteps(); refreshControls(); });

  renderChanges();
  renderSteps();
  refreshControls();
})();
`;
