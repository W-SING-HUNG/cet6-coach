/**
 * A2 人工审核与保存工作台 · HTML 静态外壳。
 *
 * ── 架构原则 ──
 * 与 A1 相同：静态外壳可匿名取得，零内联私有内容，token 经 fragment 传递并立刻清除。
 * 外壳提供从 A1 清点检查平滑进入 A2 人工裁决与草稿编辑、校验、保存的完整产品交互界面。
 */

import { ADJUDICATION_CLIENT_SCRIPT } from "./adjudication-client-script";

export function renderAdjudicationShell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<title>课程材料人工审核与裁决保存工作台 (A2)</title>
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
           background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0; }

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
</style>
</head>
<body>

<header>
  <h1>课程材料人工审核与裁决保存 (A2)</h1>
  <span class="badge">A2 · 支持人工审核与安全原子保存</span>
  <span class="grow"></span>
  <button id="help" class="small">这是什么？</button>
</header>

<main>
  <p id="live" class="sr" role="status" aria-live="polite"></p>
  <div id="globalNotice"></div>

  <nav class="steps" aria-label="检查与审核步骤">
    <button id="stepBtn1" data-step="1" aria-current="step">① 选择材料</button>
    <button id="stepBtn2" data-step="2">② 清点结果</button>
    <button id="stepBtn3" data-step="3">③ 材料与分段</button>
    <button id="stepBtn4" data-step="4">④ 真题候选</button>
    <button id="stepBtn5" data-step="5">⑤ 人工裁决与保存</button>
  </nav>

  <!-- ── 第 1 步：选择目录与范围 ── -->
  <section id="step1" class="panel" aria-labelledby="step1Title">
    <h2 id="step1Title">① 选择要检查的课程材料</h2>
    <p class="lead">先选一个本机课程文件夹，再勾选要检查的材料范围。</p>

    <div class="row">
      <button id="pick" class="primary">选择课程文件夹…</button>
      <button id="rescan" disabled>刷新目录内容</button>
      <button id="changeDir" disabled>换一个文件夹</button>
    </div>
    <p id="pickState" class="status">还没有选择文件夹。</p>

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

      <div class="row">
        <button id="inspect" class="primary" disabled>检查所选材料</button>
        <span id="inspectHint" class="status">请先选择至少一个文件。</span>
      </div>
    </div>
  </section>

  <!-- ── 第 2 步：清点结果 ── -->
  <section id="step2" class="panel" aria-labelledby="step2Title" hidden>
    <h2 id="step2Title">② 清点结果</h2>
    <p class="lead">检查只读源文件，如实报告清点结果。</p>
    <div id="cards" class="cards"></div>
    <div id="crossFacts"></div>
    <div id="stage2Issues"></div>
  </section>

  <!-- ── 第 3 步：材料与分段 ── -->
  <section id="step3" class="panel" aria-labelledby="step3Title" hidden>
    <h2 id="step3Title">③ 材料与分段</h2>
    <p class="lead">材料分组表示与初步分段建议。</p>
    <div id="stage3Issues"></div>
    <div id="materials" class="stack"></div>
  </section>

  <!-- ── 第 4 步：真题候选 ── -->
  <section id="step4" class="panel" aria-labelledby="step4Title" hidden>
    <h2 id="step4Title">④ 真题候选与逐项证据</h2>
    <p class="lead">机器给出的真题候选建议与打分证据。</p>
    <div id="matchSummary" class="notice info"></div>
    <div id="stage4Issues"></div>
    <div id="matches" class="stack"></div>
  </section>

  <!-- ── 第 5 步：人工裁决与保存 (A2) ── -->
  <section id="step5" class="panel" aria-labelledby="step5Title" hidden>
    <h2 id="step5Title">⑤ 人工审核与决定保存</h2>
    <p class="lead">对材料分组、分段及真题候选进行人工裁决。系统<b>不自动替用户批准任何建议</b>。
      保存前将校验绑定校验和、真题库版本与源新鲜度，并原子安全写入本机私有目录。</p>

    <!-- ── A1 → A2 断点：生成课程候选 ──
         这一段存在的唯一理由：候选生成此前只有命令行入口，
         而「候选不存在」会让第 ⑤ 步的保存**必然失败**（绑定校验和对不上）。
         因此界面必须能自己走完这条路：先预演（零写入）→ 明确授权 → 生成。 -->
    <div id="candidatePanel" class="notice info">
      <div><b>第一步 · 生成课程候选</b></div>
      <div class="why">人工裁决必须绑定到一份<b>具体</b>的候选。若候选还没有生成，
        保存会因「候选不存在」而失败 —— 这是设计，不是缺陷（系统绝不兜底伪装成功）。</div>
      <div class="row">
        <label for="candTitle"><b>课程标题：</b></label>
        <input type="text" id="candTitle" placeholder="例如：阅读精讲 2024 秋"
               style="padding:4px 8px; border:1px solid var(--edge-strong); border-radius:5px;">
        <label for="candProvider"><b>提供方：</b></label>
        <input type="text" id="candProvider" placeholder="可留空"
               style="padding:4px 8px; border:1px solid var(--edge-strong); border-radius:5px;">
        <label for="candVersion"><b>内容版本：</b></label>
        <input type="number" id="candVersion" value="1" min="1"
               style="width:72px; padding:4px 8px; border:1px solid var(--edge-strong); border-radius:5px;">
      </div>
      <div class="row">
        <button id="previewCandidateBtn">预演生成（不写入）</button>
        <button id="generateCandidateBtn" disabled>确认生成候选（单独授权）</button>
        <span id="candidateState" class="status"></span>
      </div>
      <div id="candidateNotice"></div>
      <div id="candidatePreview"></div>
    </div>

    <div id="bindingPanel" class="notice info">
      <div><b>当前审核范围</b></div>
      <div id="bindingScope">（先完成检查，再进入本步）</div>
      <div id="bindingCandidate" class="mono"></div>
      <div id="bindingLibrary" class="mono"></div>
      <div id="bindingStale" class="fix"></div>
    </div>

    <div class="row">
      <label for="reviewerInput"><b>审核人：</b></label>
      <input type="text" id="reviewerInput" placeholder="例如：姓名或角色" style="padding:4px 8px; border:1px solid var(--edge-strong); border-radius:5px;">
      <label for="courseIdInput"><b>课程标识：</b></label>
      <input type="text" id="courseIdInput" placeholder="例如：rsvp-reading-2024" style="padding:4px 8px; border:1px solid var(--edge-strong); border-radius:5px;">
      <button id="loadExistingDraftBtn" class="small">加载已有审核草稿</button>
    </div>

    <div id="adjudicationNotice"></div>
    <div id="dirtyHint" class="status"></div>

    <h3>1. 材料分组审核（Material Groupings）</h3>
    <div id="adjudicationGroupings" class="stack"></div>

    <h3>2. 课程分段审核（Segments）</h3>
    <div id="adjudicationSegments" class="stack"></div>

    <h3>3. 真题匹配审核（Canonical Matches）</h3>
    <div id="adjudicationMatches" class="stack"></div>

    <h3>4. 人工分段计划（Segmentation Plan，可选）</h3>
    <p class="lead">分段计划是<b>生成候选的结构输入</b>，与上面的审核记录是两件事。
      保存计划后必须重新生成候选；已签署的审核会因候选校验和变化而自动失效
      （系统绝不把旧决定套到新结构上）。本界面目前只支持对既有段做裁决，
      <b>不能</b>在这里重新划分段边界 —— 那是 <code>pnpm course:segment</code> 标注工具的职责。</p>
    <div class="row">
      <button id="loadExistingPlanBtn" class="small">加载已有分段计划</button>
      <button id="savePlanBtn">保存人工分段计划</button>
      <span id="savePlanState" class="status"></span>
    </div>
    <div id="planNotice"></div>
    <div id="planSummary" class="mono"></div>

    <div class="row" style="margin-top:18px;">
      <button id="validateDraftBtn">校验当前审核决定</button>
      <button id="saveDraftBtn" class="primary">安全保存人工审核记录</button>
      <span id="saveDraftState" class="status"></span>
    </div>

    <p class="why" style="margin-top:12px;">
      注意：保存 review.json <b>不等于</b>课程已导入 CET6 Coach。导入、晋升与建链
      是后续各自独立的批准动作，需要单独确认。
    </p>
  </section>

  <details class="adv">
    <summary>高级信息（给排查问题用）</summary>
    <div id="advanced"></div>
  </details>
</main>

<script>
${ADJUDICATION_CLIENT_SCRIPT}
</script>
</body>
</html>`;
}
