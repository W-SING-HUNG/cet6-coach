/**
 * 本地标注页面的 **HTML 外壳**（单文件、零外部资源、**不含任何私有数据**）。
 *
 * ── 这个文件与 `segment-client-script.ts` 的分工（F1 + F4）──
 *
 * | 模块 | 内容 | 转义边界 |
 * | --- | --- | --- |
 * | 本模块 | 静态 HTML + CSS + 把客户端脚本**原样内联** | **零插值**：除了那一处脚本，没有任何 `${…}` |
 * | `segment-client-script.ts` | 客户端 JS 原文（`String.raw`） | 只有 JS 自己的那一层 |
 *
 * ── 为什么外壳里**一个插值都没有**（这是 F4 的核心）──
 *
 * `GET /` **不需要凭据**（浏览器导航无法带自定义请求头，因此它必须是
 * 可匿名取得的）。既然它可匿名取得，它就**绝不能**含：
 *
 * - 抽取出的课程正文；
 * - 计划内容；
 * - 会话 token；
 * - 源绝对路径。
 *
 * 否则本机任意进程只要 `GET /` 就能拿到私有材料**以及写计划的能力** ——
 * 那正是被复评证明的缺陷（旧实现把正文与 token 都塞进了这个页面）。
 *
 * 因此现在这个页面是**纯静态外壳**：同样的字节对任何请求者都成立，
 * 不含任何随会话变化的东西。私有引导数据经 `GET /api/bootstrap`
 * （要求 token 请求头）取得。
 *
 * ── XSS ──
 *
 * 正文根本不进入这个文档（也不进入可执行代码）—— 它经认证 JSON 取回后
 * 用 `textContent` 写进 DOM。因此"把教材文本当代码执行"在结构上不可能。
 * CSP 继续收紧为 `default-src 'none'` 且无外部资源。
 *
 * ── 这一版改的是**给 使用者 看的语言与流程**，不是数据模型 ──
 *
 * 页面里的每一个可见词都必须是**产品语言**，不是内部枚举名：
 * `source` → 「中文原文」、`reference_translation` → 「课程参考译文」、
 * `notes` → 「老师讲解 / 语言点」、`ignored_furniture` → 「页眉页脚（忽略）」。
 * 内部通道名仍然原样出现在 `data-channel` 属性与提交给服务端的 JSON 里
 * —— 属性不可见，因此那不属于"暴露内部概念"。
 *
 * 同样地：源摘要、资产键、计划校验和、行坐标这些**证据**继续存在，
 * 但它们只住在收起的「高级信息」里，不占正常视线。
 */

import { ANNOTATION_CLIENT_SCRIPT } from "./segment-client-script";

/**
 * 渲染标注页面的**静态外壳**。
 *
 * 刻意**不接受任何参数** —— 一旦它开始接收会话数据，就会重新出现
 * "未认证页面携带私有内容"的可能。签名本身就是这条边界的守卫。
 */
export function renderAnnotationShell(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>把讲义分成一份份翻译练习</title>
<style>
  :root { color-scheme: light; --edge:#ddd8ce; --edge-strong:#c4bdb0; --ink:#1b1a17; --muted:#6b655c;
          --surface:#faf8f4; --card:#fff;
          --source:#1d4ed8; --source-soft:#eef3ff;
          --ref:#0f766e; --ref-soft:#e7f6f2;
          --notes:#a16207; --notes-soft:#fdf5e4;
          --furniture:#6b7280; --furniture-soft:#f2f3f5; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background:var(--surface); color:var(--ink); }

  /* ── 首次打开：一个简短的三步说明，不是一个教程墙 ── */
  .onboarding { position:fixed; inset:0; z-index:50; background:rgba(27,26,23,.55);
                display:flex; align-items:center; justify-content:center; padding:20px; }
  body:not(.onboarding-open) .onboarding { display:none; }
  body.onboarding-open main { display:none; }
  .onboarding-card { background:var(--card); border-radius:10px; max-width:520px; width:100%;
                     padding:26px 26px 22px; box-shadow:0 12px 40px rgba(0,0,0,.28); }
  .onboarding-card h2 { margin:0 0 10px; font-size:20px; line-height:1.4; }
  .onboarding-lead { margin:0 0 16px; color:#4a453d; font-size:14px; }
  .onboarding-steps { margin:0 0 20px; padding:0; list-style:none; }
  .onboarding-steps li { padding:9px 12px; margin-bottom:8px; border-radius:7px;
                         background:#f5f2ec; font-size:15px; font-weight:550; }
  button.cta { font:inherit; font-size:16px; font-weight:650; width:100%; padding:12px 16px;
               border:1px solid #1b1a17; background:#1b1a17; color:#fff; border-radius:8px; cursor:pointer; }
  button.cta:hover { background:#33302b; }

  header { position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid var(--edge);
           padding:10px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:650; }
  .meta { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
  #saveState { margin-left:auto; }
  main { display:grid; grid-template-columns: minmax(0,1fr) 400px; gap:0; height:calc(100vh - 53px); }
  @media (max-width: 1100px) { main { grid-template-columns:1fr; height:auto; } }
  #doc { overflow:auto; padding:16px; }
  aside { border-left:1px solid var(--edge); background:#fff; overflow:auto; padding:16px; }
  @media (max-width: 1100px) { aside { border-left:0; border-top:1px solid var(--edge); } }

  .page { margin-bottom:22px; border:1px solid var(--edge); border-radius:6px; background:#fff; }
  .page-head { padding:6px 10px; background:#f2f0ea; border-bottom:1px solid var(--edge);
               font-size:12px; color:var(--muted); display:flex; justify-content:space-between; }
  .page.no-text { background:repeating-linear-gradient(45deg,#fdf6f6,#fdf6f6 8px,#f8ecec 8px,#f8ecec 16px); }
  .line { display:flex; gap:8px; padding:2px 8px; cursor:pointer; align-items:flex-start;
          border-left:3px solid transparent; }
  .line:hover { background:#f0f4ff; }
  .line .no { flex:0 0 42px; text-align:right; color:#a8a29a; font-size:11px;
              font-variant-numeric:tabular-nums; user-select:none; padding-top:3px; }
  .line .tx { white-space:pre-wrap; word-break:break-word; flex:1 1 auto; }
  /* ── 四类的底色不同，但**不只是颜色**：每一类还有自己的左边框样式与文字标签 ── */
  .line.source { background:var(--source-soft); border-left-color:var(--source); border-left-style:solid; }
  .line.reference_translation { background:var(--ref-soft); border-left-color:var(--ref); border-left-style:double; border-left-width:4px; }
  .line.notes { background:var(--notes-soft); border-left-color:var(--notes); border-left-style:dashed; }
  .line.ignored_furniture { background:var(--furniture-soft); color:#8b8f96;
                            border-left-color:var(--furniture); border-left-style:dotted; }
  .line.overlap { outline:2px solid #dc2626; outline-offset:-2px; }
  /*
   * ── 「还没处理」用中性底色，**不用告警红** ──
   *
   * 早先这里用的是 #fff1f2（告警粉）。实测截图证明那是个理解缺陷：
   * 使用者 **刚打开页面、什么都还没做**时，整篇讲义都是粉的 ——
   * 看起来像"出了大错"，而实际上那只是"待处理"。
   *
   * 红色留给**真的有冲突**的地方（见 .line.overlap 规则）。
   * 「还剩多少行」由旁边的进度区用人话说，不需要每行都喊一次。
   */
  .line.unassigned { background:#fffdf7; }
  .line.picked { outline:2px solid #1b1a17; outline-offset:-2px; }
  .line.anchor { outline:2px dashed #1b1a17; outline-offset:-2px; }
  /* 每一段范围**自带文字标签** —— 颜色之外的第二条编码通道 */
  .mark { display:none; flex:0 0 auto; align-self:flex-start; margin-top:1px; padding:0 6px;
          border-radius:9px; font-size:11px; font-weight:650; color:#fff; white-space:nowrap; }
  .line.marked .mark { display:inline-block; }
  .mark.source { background:var(--source); }
  .mark.reference_translation { background:var(--ref); }
  .mark.notes { background:var(--notes); }
  .mark.ignored_furniture { background:var(--furniture); }

  button { font:inherit; padding:6px 11px; border:1px solid var(--edge-strong); background:#fff;
           border-radius:6px; cursor:pointer; }
  button:hover:not(:disabled) { background:#f4f2ec; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:#1b1a17; color:#fff; border-color:#1b1a17; font-weight:600; }
  button.primary:hover:not(:disabled) { background:#33302b; }
  button.small { padding:2px 8px; font-size:12px; }
  button.danger { color:#b91c1c; border-color:#f0c9c9; }
  button.danger:hover:not(:disabled) { background:#fef2f2; }

  /* ── 四类大按钮：名字 + 一句解释 ── */
  .cats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .cat { display:flex; flex-direction:column; gap:2px; align-items:flex-start; text-align:left;
         padding:9px 11px; border-radius:8px; border:1px solid var(--edge-strong); }
  .cat .cat-name { font-size:14px; font-weight:650; }
  .cat .cat-help { font-size:11px; color:var(--muted); line-height:1.4; }
  .cat[data-on="1"] { box-shadow:0 0 0 2px #1b1a17 inset; border-color:#1b1a17; }
  .cat[data-channel="source"][data-on="1"] { background:var(--source-soft); }
  .cat[data-channel="reference_translation"][data-on="1"] { background:var(--ref-soft); }
  .cat[data-channel="notes"][data-on="1"] { background:var(--notes-soft); }
  .cat[data-channel="ignored_furniture"][data-on="1"] { background:var(--furniture-soft); }

  /* ── 「当前要做什么」始终只有一句 ── */
  .guide { border:1px solid #1b1a17; border-radius:8px; padding:11px 12px; margin-bottom:12px;
           background:#fffdf6; }
  .guide-where { font-size:12px; color:var(--muted); margin-bottom:4px; }
  .guide-action { font-size:15px; font-weight:650; line-height:1.5; }

  h3.sec { font-size:13px; margin:16px 0 8px; }
  .row { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
  .unit { border:1px solid var(--edge); border-radius:7px; padding:10px; margin-bottom:10px; background:#fff; }
  .unit.armed { border-color:#1b1a17; box-shadow:0 0 0 2px #1b1a1715; }
  .unit h4 { margin:0 0 7px; font-size:13px; }
  .unit input[type=text] { width:100%; padding:4px 6px; border:1px solid var(--edge); border-radius:5px; font:inherit; }
  .assign { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums;
            display:flex; justify-content:space-between; gap:8px; align-items:center; padding:3px 0;
            border-top:1px solid #f2efe9; }
  .assign.picked { background:#fffdf6; }
  .chip { display:inline-block; padding:1px 7px; border-radius:9px; font-size:11px; color:#fff; font-weight:650; }
  .chip.source { background:var(--source); } .chip.reference_translation { background:var(--ref); }
  .chip.notes { background:var(--notes); } .chip.ignored_furniture { background:var(--furniture); }

  .progress-bar { height:8px; border-radius:5px; background:#eeeae2; overflow:hidden; margin:6px 0 8px; }
  .progress-bar > span { display:block; height:100%; background:#15803d; width:0; }
  .progress-line { font-size:14px; font-weight:600; }
  .progress-sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .progress-line.good { color:#15803d; }
  .progress-line.bad { color:#b91c1c; }
  .issue { color:#b91c1c; font-size:12.5px; padding:4px 0; }
  .hint { color:var(--muted); font-size:12px; }
  .banner { padding:9px 11px; border-radius:6px; margin-bottom:10px; font-size:13px; }
  .banner.err { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; }
  .banner.ok { background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; }
  .banner.info { background:#f5f2ec; border:1px solid var(--edge); color:#4a453d; }

  /* ── 成功之后：只留一句"可以关页面了" ── */
  .done { border:1px solid #86efac; background:#f0fdf4; border-radius:9px; padding:16px; margin-bottom:12px; }
  .done-title { font-size:19px; font-weight:700; color:#15803d; margin-bottom:8px; }
  .done-close { font-size:15px; font-weight:650; margin-bottom:8px; }
  .done-next { font-size:13.5px; color:#166534; }

  details.advanced { margin-top:16px; border-top:1px solid var(--edge); padding-top:10px; }
  /* ── 页内确认：一次只问一个决定，且可被真实点击 ── */
  .confirm { border:1px solid #e0b34d; background:#fffbeb; border-radius:7px;
             padding:11px 12px; margin-bottom:10px; }
  .confirm-line { font-size:13.5px; white-space:pre-wrap; margin-bottom:8px; }  details.advanced summary { cursor:pointer; font-size:12.5px; color:var(--muted); }
  .adv-row { font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums;
             word-break:break-all; padding:2px 0; }
  label.inline { display:block; font-size:12px; color:var(--muted); margin:8px 0 0; }
  label.inline input { width:100%; margin-top:3px; padding:4px 6px; border:1px solid var(--edge);
                       border-radius:5px; font:inherit; font-size:12.5px; }
</style>
</head>
<body class="onboarding-open">

<div class="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
  <div class="onboarding-card">
    <h2 id="onboardingTitle">把这份讲义分成一份份翻译练习</h2>
    <p class="onboarding-lead">你不需要修改内容，只需要告诉系统每一段属于什么。</p>
    <ol class="onboarding-steps">
      <li>① 新建一份练习</li>
      <li>② 标出原文、参考译文和老师讲解</li>
      <li>③ 全部处理完后检查并保存</li>
    </ol>
    <button id="startAnnotating" class="cta">开始标注</button>
  </div>
</div>

<header>
  <h1>把讲义分成一份份翻译练习</h1>
  <span class="meta" id="loadState"></span>
  <span class="meta" id="saveState"></span>
  <button id="help" class="small">怎么用？</button>
</header>

<main>
  <div id="doc" aria-label="这份讲义的内容"></div>

  <aside>
    <div id="banner"></div>
    <div id="done" class="done" hidden></div>
    <div id="confirmBox" class="confirm" hidden></div>

    <div class="guide">
      <div class="guide-where" id="guideWhere">当前：还没有翻译练习</div>
      <div class="guide-action" id="guideAction">请先点下面的「+ 新建一份翻译练习」。</div>
    </div>

    <div class="row">
      <button id="newUnit" class="primary" disabled>+ 新建一份翻译练习</button>
      <button id="nextUnit" disabled>完成这份练习，开始下一份</button>
    </div>

    <h3 class="sec">这一段属于什么？</h3>
    <div class="cats" id="channelBtns" role="group" aria-label="这一段属于什么">
      <button class="cat" data-channel="source" disabled>
        <span class="cat-name">中文原文</span>
        <span class="cat-help">这份讲义里要翻译的中文段落</span>
      </button>
      <button class="cat" data-channel="reference_translation" disabled>
        <span class="cat-name">课程参考译文</span>
        <span class="cat-help">课程给出的英文参考译文，没有可以跳过</span>
      </button>
      <button class="cat" data-channel="notes" disabled>
        <span class="cat-name">老师讲解 / 语言点</span>
        <span class="cat-help">老师的讲解、词汇与语法说明</span>
      </button>
      <button class="cat" data-channel="ignored_furniture" disabled>
        <span class="cat-name">页眉页脚（忽略）</span>
        <span class="cat-help">每页重复出现、不是课程正文的内容</span>
      </button>
    </div>

    <div class="row">
      <button id="undo" disabled>撤销上一步</button>
      <button id="cancelPick" disabled>取消当前选择</button>
      <button id="unmark" class="danger" disabled>取消这个标记</button>
    </div>

    <h3 class="sec">进度</h3>
    <div id="progress"></div>
    <div id="issues"></div>

    <h3 class="sec">这份练习里已经标好的内容</h3>
    <div id="units"></div>

    <div class="row">
      <button id="save" class="primary" disabled>检查并保存</button>
    </div>
    <p class="hint" id="saveHint">把每一行都标好之后，点这里保存。</p>

    <details class="advanced">
      <summary>高级信息</summary>
      <div id="advancedBody"></div>
      <div class="adv-row" id="planDigest"></div>
      <label class="inline">标注者 <input type="text" id="author" value="owner"></label>
      <label class="inline">为什么需要人工分段
        <input type="text" id="reason" placeholder="可留空：例如源件没有可靠的结构边界">
      </label>
      <p class="hint" style="margin-top:8px">保存后计划写入本机私人目录，不进 Git。
        之后重新运行抽取命令即可用这份计划生成候选段。</p>
    </details>
  </aside>
</main>

<script>
${ANNOTATION_CLIENT_SCRIPT}
</script>
</body>
</html>`;
}
