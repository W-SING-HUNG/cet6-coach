/**
 * A1 只读检查工作台 · **HTML 外壳**（单文件、零外部资源、**不含任何私有数据**）。
 *
 * ── 与 `segment-page.ts` 一字不差的两条纪律 ──
 *
 * 1. **零参数渲染。** 签名本身就是"它不需要会话数据"这条边界的结构守卫。
 *    一旦它开始接收参数，就会重新出现"未认证页面携带私有内容"的可能
 *    （那正是 F4 被复评证明的缺陷）。
 * 2. **零插值。** 除了内联那段客户端脚本，`${…}` 在本文档里**不得出现**
 *    （由 `tests/course-segment-tool.test.ts` 的同源门禁守护）。
 *
 * 因此 `GET /intake` 是**静态外壳**：同样的字节对任何请求者都成立，
 * 不含课程正文、不含计划、不含 token、不含源路径。
 * 认证后的私有引导数据走 `GET /api/intake/state`。
 *
 * ── 产品语言（面向不懂这套架构的 使用者）──
 *
 * 内部概念（`inventory` / `grouping` / `segmentation` / `projectionExact` /
 * `bodyJaccard` / `canonical`）**不得出现在正常可见文字里**。
 * 所有者看到的是：「课程材料」「材料分组」「课程段」「真题候选」
 * 「逐项证据」。技术细节收进折叠区。
 *
 * ── 它**没有**什么（这是 A1 的定义，不是待办）──
 *
 * 没有保存按钮、没有导入按钮、没有建链按钮、没有"生成候选"按钮。
 * A1 是只读的：它只回答"我现在有什么"，不改变任何东西。
 */

import { INTAKE_CLIENT_SCRIPT } from "./intake-client-script";

/**
 * 渲染 A1 工作台的**静态外壳**。
 *
 * 刻意**不接受任何参数**（同 `renderAnnotationShell`）。
 */
export function renderIntakeShell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<title>检查本机课程材料（只读）</title>
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
           background:#eef3ff; color:#1e40af; border:1px solid #c7d2fe; }

  main { max-width:1180px; margin:0 auto; padding:16px 16px 64px; }
  @media (max-width: 720px) { main { padding:12px 10px 48px; } }

  nav.steps { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
  nav.steps button { font:inherit; padding:6px 11px; border:1px solid var(--edge-strong); background:#fff;
                     border-radius:999px; cursor:pointer; font-size:12.5px; }
  nav.steps button[aria-current="step"] { background:#1b1a17; color:#fff; border-color:#1b1a17; font-weight:650; }

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
  button.small { padding:3px 9px; font-size:12px; }
  :focus-visible { outline:3px solid #1d4ed8; outline-offset:2px; }

  .status { min-height:1.4em; font-size:13px; }
  .notice { padding:10px 12px; border-radius:7px; margin:10px 0; font-size:13px; }
  .notice.err { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; }
  .notice.ok { background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; }
  .notice.info { background:#f5f2ec; border:1px solid var(--edge); color:#4a453d; }
  .notice.warn { background:#fffbeb; border:1px solid #fde68a; color:#854d0e; }

  /* ── 目录树 ── */
  .tree { border:1px solid var(--edge); border-radius:8px; max-height:52vh; overflow:auto; padding:8px;
          background:#fff; min-width:0; }
  .tree ul { list-style:none; margin:0; padding-left:18px; }
  .tree > ul { padding-left:0; }
  .tree li { min-width:0; }
  .node { display:flex; gap:7px; align-items:flex-start; padding:2px 4px; border-radius:5px; min-width:0; }
  .node:hover { background:#f7f5f0; }
  .node label { display:flex; gap:7px; align-items:flex-start; cursor:pointer; min-width:0; flex:1 1 auto; }
  .node input[type=checkbox] { margin:3px 0 0; flex:0 0 auto; width:15px; height:15px; }
  .nm { min-width:0; }
  .nm .base { font-weight:550; }
  .nm .meta { color:var(--muted); font-size:11.5px; }
  .kids { margin-left:2px; }
  .toggle { border:0; background:transparent; padding:0 4px; font-size:11px; color:var(--muted); cursor:pointer; }
  .hidden { display:none; }

  .counts { font-size:13px; color:#3f3a33; }
  .counts b { font-variant-numeric:tabular-nums; }

  /* ── 四张卡片 ── */
  .cards { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
  @media (max-width: 900px) { .cards { grid-template-columns:repeat(2, minmax(0,1fr)); } }
  @media (max-width: 480px) { .cards { grid-template-columns:1fr; } }
  .card { border:1px solid var(--edge); border-radius:8px; padding:11px; background:#fff; min-width:0; }
  .card .n { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
  .card .t { font-size:12.5px; color:var(--muted); }

  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  th, td { border-bottom:1px solid #efeadf; padding:6px 7px; text-align:left; vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:11.5px; }

  .item { border:1px solid var(--edge); border-radius:8px; padding:11px; background:#fff; margin-bottom:10px; min-width:0; }
  .item .head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .item .head .t { font-weight:650; }
  .tag { display:inline-block; padding:1px 7px; border-radius:9px; font-size:11px; font-weight:650;
         border:1px solid var(--edge-strong); color:#4a453d; background:#faf8f4; }
  .tag.ok { border-color:#bbf7d0; background:#f0fdf4; color:#166534; }
  .tag.warn { border-color:#fde68a; background:#fffbeb; color:#854d0e; }
  .tag.bad { border-color:#fecaca; background:#fef2f2; color:#991b1b; }
  .tag.info { border-color:#c7d2fe; background:#eef3ff; color:#1e40af; }
  .why { color:#4a453d; font-size:12.5px; margin:6px 0 0; }
  .fix { color:#166534; font-size:12.5px; margin:4px 0 0; }
  ul.plain { margin:5px 0 0; padding-left:18px; font-size:12.5px; color:#4a453d; }
  ul.plain li { margin-bottom:3px; }

  details.adv { margin-top:10px; border-top:1px solid var(--edge); padding-top:8px; }
  details.adv summary { cursor:pointer; font-size:12.5px; color:var(--muted); }
  .mono { font-variant-numeric:tabular-nums; font-size:11.5px; color:var(--muted); word-break:break-all; }

  .bar { height:7px; border-radius:4px; background:#eeeae2; overflow:hidden; margin:7px 0; }
  .bar > span { display:block; height:100%; background:#1b1a17; width:0; transition:width .18s ease; }

  .empty { border:1px dashed var(--edge-strong); border-radius:8px; padding:18px; text-align:center;
           color:var(--muted); background:#fffdf9; font-size:13px; }
  .sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden;
        clip:rect(0 0 0 0); white-space:nowrap; border:0; }
  .more { display:flex; gap:8px; align-items:center; justify-content:space-between; margin-top:6px; font-size:12.5px; }
  li.target-row { padding:4px 0; border-top:1px solid #f2efe9; }
  li.target-row .base { font-weight:550; }
</style>
</head>
<body>

<header>
  <h1>检查本机课程材料</h1>
  <span class="badge">只读 · 不会修改或保存任何东西</span>
  <span class="grow"></span>
  <button id="help" class="small">这是什么？</button>
</header>

<main>
  <!-- 全局状态播报（键盘与读屏用户据此知道发生了什么） -->
  <p id="live" class="sr" role="status" aria-live="polite"></p>
  <div id="globalNotice"></div>

  <nav class="steps" aria-label="检查步骤">
    <button id="stepBtn1" data-step="1" aria-current="step">① 选择材料</button>
    <button id="stepBtn2" data-step="2">② 清点结果</button>
    <button id="stepBtn3" data-step="3">③ 材料与分段</button>
    <button id="stepBtn4" data-step="4">④ 真题候选</button>
  </nav>

  <!-- ── 第 1 步：选择目录与范围 ── -->
  <section id="step1" class="panel" aria-labelledby="step1Title">
    <h2 id="step1Title">① 选择要检查的课程材料</h2>
    <p class="lead">先选一个本机课程文件夹，再勾选这次要检查的部分。选择只决定<b>检查范围</b>，
      不表示要把它们导入系统。</p>

    <div class="row">
      <button id="pick" class="primary">选择课程文件夹…</button>
      <button id="rescan" disabled>刷新目录内容</button>
      <button id="changeDir" disabled>换一个文件夹</button>
    </div>
    <p id="pickState" class="status">还没有选择文件夹。</p>
    <p id="pickerFact" class="mono" hidden></p>

    <div id="treeWrap" hidden>
      <div class="row">
        <button id="selectAll" class="small">全选</button>
        <button id="selectNone" class="small">全不选</button>
        <button id="expandAll" class="small">展开全部</button>
        <button id="collapseAll" class="small">折叠全部</button>
      </div>
      <div class="bar" role="progressbar" id="selBar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
           aria-label="已选文件比例"><span id="selBarFill"></span></div>
      <p id="selCounts" class="counts">已选 <b>0</b> 个文件 · 已排除 <b>0</b> 个</p>

      <div id="tree" class="tree" role="group" aria-label="课程文件夹内容"></div>
      <div id="treeIssues"></div>

      <div class="row">
        <button id="inspect" class="primary" disabled>检查所选材料</button>
        <span id="inspectHint" class="status">请先选择至少一个文件。</span>
      </div>
    </div>
  </section>

  <!-- ── 第 2 步：清点结果 ── -->
  <section id="step2" class="panel" aria-labelledby="step2Title" hidden>
    <h2 id="step2Title">② 清点结果</h2>
    <p class="lead">这条检查只读文件、不改动它们。下面四类覆盖了这次范围内的全部文件 ——
      没有任何一个失败会被静默忽略。</p>
    <div id="cards" class="cards"></div>
    <div id="crossFacts"></div>
    <div id="stage2Issues"></div>
  </section>

  <!-- ── 第 3 步：材料与分段 ── -->
  <section id="step3" class="panel" aria-labelledby="step3Title" hidden>
    <h2 id="step3Title">③ 材料与分段</h2>
    <p class="lead">「材料」是一份逻辑内容（例如同一份讲义），「表示」是它的具体文件
      （PDF 版、DOCX 版、音频）。「课程段」是这份材料里的一段内容。</p>
    <div id="stage3Issues"></div>
    <div id="materials" class="stack"></div>
  </section>

  <!-- ── 第 4 步：真题候选 ── -->
  <section id="step4" class="panel" aria-labelledby="step4Title" hidden>
    <h2 id="step4Title">④ 真题候选与逐项证据</h2>
    <p class="lead"><b>这些只是机器的建议，不是核验结果。</b>它们不会建立任何链接，也不会改变任何内容。
      每一段都可以没有候选 —— 那是合法状态。</p>
    <div id="matchSummary" class="notice info"></div>
    <div id="stage4Issues"></div>
    <div id="matches" class="stack"></div>
  </section>

  <details class="adv">
    <summary>高级信息（给排查问题用）</summary>
    <div id="advanced"></div>
  </details>
</main>

<script>
${INTAKE_CLIENT_SCRIPT}
</script>
</body>
</html>`;
}
