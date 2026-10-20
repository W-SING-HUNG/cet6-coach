/**
 * A3 受控课程接入工作台 · HTML 静态外壳。
 *
 * ── 架构原则（与 A1 / A2 完全相同）──
 * 静态外壳可匿名取得，零内联私有内容，token 经 fragment 传递并立刻清除。
 * 因此 `renderA3Shell()` 必须是**零参数**函数 —— 签名本身就是
 * "它不含任何随会话变化的东西"的结构守卫。
 *
 * ── 这个界面要回答的问题（任务书 Product UX 一节逐条）──
 *
 * 1. 当前步骤与完成进度；
 * 2. 明确的待确认状态；
 * 3. Loading / Success / Error / Empty / Stale；
 * 4. 不可执行操作的原因；
 * 5. 执行前的变化清单与单独确认；
 * 6. 中断后重新打开的状态恢复；
 * 7. 重复点击和并发写入保护；
 * 8. 键盘可操作、响应式布局；
 * 9. 明确显示某一步已成功、下一步尚未执行。
 *
 * ── 三个独立执行边界的界面形态 ──
 *
 * 每张卡都是「将发生的变化清单 + 一个确认按钮」，且**只有**当预演结论为
 * `PROMOTABLE`（A3-a）/ 备份就绪（A3-b）/ 核验通过（A3-c）时可点。
 * 刻意**不**提供"全部完成"按钮。
 */

import { A3_CLIENT_SCRIPT } from "./a3-client-script";

export function renderA3Shell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<title>课程正式接入工作台 (A3)</title>
<style>
  :root { color-scheme: light; --edge:#ddd8ce; --edge-strong:#c4bdb0; --ink:#1b1a17; --muted:#6b655c;
          --surface:#faf8f4; --card:#fff; --ok:#15803d; --warn:#a16207; --bad:#b91c1c; --accent:#1d4ed8; }
  * { box-sizing: border-box; }
  html, body { max-width: 100%; }
  body { margin:0; font:14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background:var(--surface); color:var(--ink); overflow-wrap:anywhere; }
  h1 { font-size:16px; margin:0; font-weight:650; }
  h2 { font-size:15px; margin:0 0 8px; font-weight:650; }
  h3 { font-size:13px; margin:16px 0 6px; font-weight:650; }
  a { color:var(--accent); }

  header { position:sticky; top:0; z-index:20; background:#fff; border-bottom:1px solid var(--edge);
           padding:10px 16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .grow { margin-left:auto; }
  .badge { display:inline-block; padding:2px 9px; border-radius:10px; font-size:11.5px; font-weight:650;
           background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }

  main { max-width:1080px; margin:0 auto; padding:16px 16px 64px; }
  @media (max-width: 720px) { main { padding:12px 10px 48px; } }

  .panel { border:1px solid var(--edge); border-radius:9px; background:var(--card); padding:15px;
           margin-bottom:14px; min-width:0; }
  .panel > .lead { color:#4a453d; margin:0 0 12px; font-size:13.5px; }
  .row { display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin:9px 0; }
  .stack { display:grid; gap:10px; }

  button { font:inherit; padding:7px 12px; border:1px solid var(--edge-strong); background:#fff;
           border-radius:7px; cursor:pointer; }
  button:hover:not(:disabled) { background:#f4f2ec; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:#1b1a17; color:#fff; border-color:#1b1a17; font-weight:650; }
  button.primary:hover:not(:disabled) { background:#33302b; }
  button.danger { background:#b91c1c; color:#fff; border-color:#b91c1c; font-weight:650; }
  button.danger:hover:not(:disabled) { background:#991b1b; }
  button.small { padding:3px 9px; font-size:12px; }
  :focus-visible { outline:3px solid #1d4ed8; outline-offset:2px; }

  input[type=text] { padding:5px 8px; border:1px solid var(--edge-strong); border-radius:5px; font:inherit; }

  .status { min-height:1.4em; font-size:13px; }
  .notice { padding:10px 12px; border-radius:7px; margin:10px 0; font-size:13px; }
  .notice.err { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; }
  .notice.ok { background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; }
  .notice.info { background:#f5f2ec; border:1px solid var(--edge); color:#4a453d; }
  .notice.warn { background:#fffbeb; border:1px solid #fde68a; color:#854d0e; }

  /* 步骤条：明确显示"某一步已成功、下一步尚未执行" */
  ol.steps { list-style:none; margin:0 0 14px; padding:0; display:grid; gap:8px; }
  ol.steps li { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--edge);
                border-radius:8px; background:#fff; min-width:0; }
  ol.steps li .dot { flex:0 0 auto; width:22px; height:22px; border-radius:50%; display:grid;
                     place-items:center; font-size:12px; font-weight:700; border:1px solid var(--edge-strong);
                     color:var(--muted); background:#faf8f4; }
  ol.steps li[data-state="done"] .dot { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
  ol.steps li[data-state="done"] { border-color:#bbf7d0; }
  ol.steps li[data-state="current"] { border-color:#1b1a17; }
  ol.steps li[data-state="current"] .dot { background:#1b1a17; color:#fff; border-color:#1b1a17; }
  ol.steps li[data-state="blocked"] .dot { background:#fef2f2; border-color:#fecaca; color:#991b1b; }
  ol.steps li .t { font-weight:650; }
  ol.steps li .d { color:var(--muted); font-size:12.5px; }

  /* 执行卡：每张都是独立授权 */
  .card { border:1px solid var(--edge); border-radius:9px; background:#fff; padding:14px; margin-bottom:12px; }
  .card.irreversible { border-left:4px solid #b91c1c; }
  .card .head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; margin-bottom:6px; }
  .card .head .t { font-weight:700; font-size:14px; }
  .tag { display:inline-block; padding:1px 7px; border-radius:9px; font-size:11px; font-weight:650;
         border:1px solid var(--edge-strong); color:#4a453d; background:#faf8f4; }
  .tag.ok { border-color:#bbf7d0; background:#f0fdf4; color:#166534; }
  .tag.warn { border-color:#fde68a; background:#fffbeb; color:#854d0e; }
  .tag.bad { border-color:#fecaca; background:#fef2f2; color:#991b1b; }
  .tag.info { border-color:#c7d2fe; background:#eef3ff; color:#1e40af; }

  ul.changes { margin:6px 0 0; padding-left:20px; font-size:12.5px; color:#3f3a33; }
  ul.changes li { margin-bottom:3px; }
  .mono { font-variant-numeric:tabular-nums; font-size:11.5px; color:var(--muted); word-break:break-all; }
  code.cmd { display:block; background:#f5f2ec; border:1px solid var(--edge); border-radius:6px;
             padding:7px 9px; font-size:11.5px; margin:5px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
  .why { color:#4a453d; font-size:12.5px; margin:6px 0 0; }
  .fix { color:#166534; font-size:12.5px; margin:4px 0 0; }
  .sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden;
        clip:rect(0 0 0 0); white-space:nowrap; border:0; }
  .empty { border:1px dashed var(--edge-strong); border-radius:8px; padding:18px; text-align:center;
           color:var(--muted); background:#fffdf9; font-size:13px; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  th, td { border-bottom:1px solid #efeadf; padding:6px 7px; text-align:left; vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:11.5px; }
  details.adv { margin-top:10px; border-top:1px solid var(--edge); padding-top:8px; }
  details.adv summary { cursor:pointer; font-size:12.5px; color:var(--muted); }
</style>
</head>
<body>

<header>
  <h1>课程正式接入 (A3)</h1>
  <span class="badge">A3 · 不可逆操作 · 三项各自单独确认</span>
  <span class="grow"></span>
  <button id="help" class="small">这是什么？</button>
</header>

<main>
  <p id="live" class="sr" role="status" aria-live="polite"></p>
  <div id="globalNotice"></div>

  <!-- ── 课程标识与进度 ── -->
  <section class="panel" aria-labelledby="courseTitle">
    <h2 id="courseTitle">当前课程</h2>
    <div class="row">
      <label for="courseIdInput"><b>课程标识：</b></label>
      <input type="text" id="courseIdInput" placeholder="例如：rsvp-reading-2024"
             style="min-width:220px;">
      <button id="loadProgressBtn" class="small">读取接入进度</button>
    </div>
    <div id="progressNotice"></div>
    <ol class="steps" id="stepList" aria-label="接入步骤与进度"></ol>
  </section>

  <!-- ── 只读预演 ── -->
  <section class="panel" aria-labelledby="previewTitle">
    <h2 id="previewTitle">预演（不写任何东西）</h2>
    <p class="lead">先看清门禁结论、冲突与每一步将写到哪里。<b>预演不写文件、不写数据库、不执行迁移。</b></p>
    <div class="row">
      <button id="previewBtn" class="primary">重新预演</button>
      <span id="previewState" class="status"></span>
    </div>
    <div id="previewNotice"></div>
    <div id="previewBody"></div>
  </section>

  <!-- ── 三个独立执行边界 ── -->
  <section aria-labelledby="execTitle">
    <h2 id="execTitle">三个各自独立的执行动作</h2>
    <p class="lead" style="color:#991b1b;">
      完成其中一项<b>绝不</b>代表批准另外两项。没有「全部完成」按钮 ——
      那是刻意的：三项的风险性质不同，必须分开确认、分开验证、分开放弃。
    </p>

    <!-- A3-a 晋升 -->
    <div class="card irreversible" id="promoteCard">
      <div class="head">
        <span class="t">① 把候选晋升为正式课程包</span>
        <span class="tag bad" id="promoteTag">不可逆</span>
      </div>
      <p class="why">写入位置：<code>private-content/courses/&lt;课程标识&gt;/</code>。
         只复制 <code>course.json</code> 与 <code>assets/</code>；候选与复核元数据<b>不</b>进入运行时目录。
         目标已存在时<b>拒绝覆盖</b>。</p>
      <ul class="changes" id="promoteChanges"></ul>
      <div id="promoteBlocked" class="notice warn" hidden></div>
      <div class="row" style="margin-top:10px;">
        <button id="promoteBtn" class="danger">确认晋升（单独授权）</button>
        <span id="promoteResult" class="status"></span>
      </div>
    </div>

    <!-- A3-b 导入索引 -->
    <div class="card irreversible" id="importCard">
      <div class="head">
        <span class="t">② 把课程包写入课程索引</span>
        <span class="tag bad" id="importTag">不可逆</span>
      </div>
      <p class="why">写入位置：本机 SQLite 数据库（<code>course_package</code> 表）。
         <b>首次写入会执行 v8 → v9 增量迁移</b>（新增三张课程层表，不改动任何既有表）。
         执行前会先取得一份一致性快照并<b>验证它可以被恢复</b>；整批在一个事务内，
         任一条目失败即整批回滚。</p>
      <div id="importBackupNotice" class="notice info"></div>
      <ul class="changes" id="importChanges"></ul>
      <div id="importBlocked" class="notice warn" hidden></div>
      <div class="row" style="margin-top:10px;">
        <button id="importBtn" class="danger">确认导入（单独授权）</button>
        <span id="importResult" class="status"></span>
      </div>
    </div>

    <!-- A3-c 建立真题链接 -->
    <div class="card irreversible" id="linkCard">
      <div class="head">
        <span class="t">③ 为已核验的段建立真题链接</span>
        <span class="tag bad" id="linkTag">不可逆</span>
      </div>
      <p class="why">写入位置：数据库 <code>course_canonical_link</code> 表。
         <b>复核行只追加，不能改也不能删</b>（UPDATE/DELETE 被数据库触发器阻断）——
         修正只能追加新行，旧行保留为历史。因此这一步比它看起来更重，
         默认只做预演，保存须再次明确确认。</p>
      <ul class="changes" id="linkChanges"></ul>
      <div id="linkBlocked" class="notice warn" hidden></div>
      <div class="row" style="margin-top:10px;">
        <button id="linkPreviewBtn">预演建链（不写入）</button>
        <button id="linkCommitBtn" class="danger">确认写入（再次单独授权）</button>
        <span id="linkResult" class="status"></span>
      </div>
      <div id="linkNotice"></div>
    </div>
  </section>

  <!-- ── 完成后 ── -->
  <section class="panel" id="donePanel" aria-labelledby="doneTitle" hidden>
    <h2 id="doneTitle">全部完成</h2>
    <p class="lead">三项都已成功。现在可以到课程伴随界面真实使用这份课程。</p>
    <div class="row">
      <a id="companionLink" href="/practice/courses" class="btn"
         style="display:inline-block;padding:7px 12px;border:1px solid #1b1a17;border-radius:7px;
                background:#1b1a17;color:#fff;font-weight:650;text-decoration:none;">
        打开课程伴随界面
      </a>
    </div>
    <p class="why">在那里你能核对：材料层级、段标题、页码来源、可用链接、阅读揭示保护与模考保留规则。</p>
  </section>

  <details class="adv">
    <summary>高级信息（给排查问题用）</summary>
    <div id="advanced"></div>
  </details>
</main>

<script>
${A3_CLIENT_SCRIPT}
</script>
</body>
</html>`;
}
