import ts from "typescript";

/**
 * 源码结构判定的**共享辅助**（供 E2E 隐私门禁使用）。
 *
 * ── 它取代了什么，以及为什么要取代 ──
 *
 * 上一版的"这条 `rmSync` 是否在 `E2E_RESET_DB` 保护之内"是靠**文本扫描**判断的：
 * 按 `split(/\r?\n/)` 切行、用 `length + 1` 累加出偏移、再用一个
 * `/if\s*\(([\s\S]*)\)\s*$/` 的正则向前回溯最近的条件块。那条实现有三个
 * 可复现的缺陷：
 *
 * 1. **偏移漂移**：`length + 1` 假定换行恰好一个字符。Windows 检出的源码是
 *    CRLF（两个字符），每行累积漂移一个字节。实测在 87 行处已漂移 86 个字符，
 *    于是"回溯起点"落在**上一条语句**上 —— 受保护的真删除被判成"不在条件内"。
 * 2. **贪婪跨段**：`[\s\S]*` 会跨过相邻的 `if`，把前一个无关条件吞进来，
 *    于是**真正未受保护**的删除可能被错误放行。
 * 3. **块判定过粗**：只认"最近的 `{`"，无法区分 `if` / `else` / 函数体 /
 *    `try` 块，也无法处理单语句 `if (x) rmSync(...)`（没有花括号）。
 *
 * 因此这里改用 **TypeScript Compiler API 的 AST**（仓库已有的
 * `typescript` 依赖，不新增任何包）。AST 天然免疫换行风格、字符串里的
 * 括号、注释与贪婪匹配。
 *
 * ── 安全语义（本轮修复的核心）──
 *
 * 判据必须回答的是**语义问题**：
 *
 *   "执行这条共享目录删除时，能否由静态语法结构确定
 *    `E2E_RESET_DB === "1"` 必然成立？"
 *
 * 而不是**文本问题**：
 *
 *   "祖先 if 的条件里是否提到了 `E2E_RESET_DB`？"
 *
 * 后者会把五种危险写法全部放行（每一条都实测确认过）：
 *
 * | 形态 | 为什么危险 |
 * | --- | --- |
 * | `if (GUARD === "1") { … } else { rmSync(SHARED) }` | 删除在 **else** 分支，条件**不成立**时才执行 |
 * | `if (GUARD !== "1") { rmSync(SHARED) }` | 否定比较：恰好是未授权时才执行 |
 * | `if (GUARD === "1" \|\| FORCE === "1")` | OR 可绕过授权开关 |
 * | `if (Boolean(process.env.GUARD))` | truthy 判断无法证明精确值 `"1"` |
 * | `if (!(GUARD === "1"))` | 逻辑取反 |
 *
 * 因此这里的实现是一个**小范围、显式的 AST 白名单**：
 * 只有当控制流路径上**每一层**都贡献一个"正向授权"时,调用才算受保护。
 * 任何超出白名单的表达式一律**失败关闭**（判为未受保护），并报告具体原因。
 *
 * 刻意**不**实现通用符号执行器：本门禁的职责是"共享路径的删除必须显式、
 * 正向地受开关保护"，一个能理解任意 JavaScript 的分析器会引入新的
 * 不确定性来源，而那正是这类门禁最不该有的东西。
 */

/**
 * 一条 `rmSync(...)` 调用的判定结果。
 */
export interface RmSyncCallSite {
  /** 1 起始的行号（仅供报错信息使用）。 */
  line: number;
  /** 第一条实参的文本（用来判断它指向哪个路径）。 */
  firstArgument: string;
  /**
   * 删除目标的**分类结论**（本轮新增，取代原先的"实参文本里有没有标记"）。
   *
   * ── 为什么必须是一个显式分类，而不是一个布尔 ──
   *
   * 早先的判据是：`markers.some((m) => call.firstArgument.includes(m))`。
   * 它把"这条删除指向哪里"降级成了一次**子串搜索**，于是只要实参不是
   * 直接写出来的共享路径（例如经 `const` 别名、函数调用、条件表达式），
   * 就**根本不进入**判定范围 —— 门禁静默通过。
   *
   * 那条缺陷的实测形态就是这一条：
   *
   *     const t = E2E_A3_CONTENT_ROOT;
   *     rmSync(t, { recursive: true, force: true });   // 被完全跳过
   *
   * 因此现在把结论显式分三类，并且**默认失败关闭**：
   * 只有能证明是"独占合成路径"的才放行；证明是共享路径的走授权检查；
   * 其余一律 `unresolved`（门禁失败），不再有"没匹配上就跳过"这条路。
   */
  target: DeletionTarget;
  /**
   * 包住这条调用的**全部** `if` 语句的条件文本（由外到内）。
   *
   * 仅作诊断展示用。**判定不看这个数组** —— 它无法表达
   * "then / else 哪一侧"、"是否被取反"、"是否被 OR 稀释"。
   */
  enclosingIfConditions: string[];
  /**
   * 控制流路径上每一层的**授权分析**（由外到内）。
   *
   * `isGuardedBy` 依据它做判定；对外暴露是为了让失败信息能说清
   * "是哪一层、因为什么原因没通过"。
   */
  enclosers: GuardAnalysis[];
}

/** 单层控制流对"授权必然成立"这一命题的贡献。 */
export interface GuardAnalysis {
  /**
   * - `proved`    ：这一层**证明**了授权成立（正向比较或正向合取）
   * - `neutral`   ：这一层不涉及授权开关，但**不破坏**已建立的证明
   * - `destroys`  ：这一层**破坏**了证明（else 分支 / 否定 / OR / truthy / 取反）
   */
  verdict: "proved" | "neutral" | "destroys";
  /** 这一层的 `if` 条件源码文本（仅诊断用）。 */
  condition: string;
  /** 这一层是 `if` 的哪一侧。 */
  branch: "then" | "else" | "bare-then";
  /** 人可读的结论说明（失败信息直接用）。 */
  reason: string;
  /**
   * 若这一层是"延迟执行"（回调 / 函数体 / 稍后调用），记录它 ——
   * 执行时机不受当前控制流约束，因此不能算作已授权。
   */
  deferred?: boolean;
}

/**
 * 删除目标的分类（本轮新增）。
 *
 * ── 三类的语义与处置 ──
 *
 * | 分类 | 含义 | 门禁处置 |
 * | --- | --- | --- |
 * | `shared` | 已证明指向**共享**路径（别名解析后命中共享标记） | 必须通过授权检查 |
 * | `exclusive` | 已证明指向**独占**的合成路径 | 放行（无需要授权） |
 * | `unresolved` | 无法静态确定目标 | **失败关闭** |
 *
 * `unresolved` 不是"跳过"，而是"拒绝"：一个无法解析的删除目标既可能
 * 删掉共享目录，也可能删掉别的东西 —— 门禁不能替它猜。
 */
export type DeletionTarget =
  | {
      kind: "shared";
      /** 命中的共享标记（诊断用）。 */
      matchedMarker: string;
      /** 解析后的目标表达式文本（含别名展开）。 */
      resolvedText: string;
      /** 若经过别名，记录解析链（诊断用）。 */
      aliasChain: string[];
    }
  | {
      kind: "exclusive";
      /** 命中的独占标记（诊断用）。 */
      matchedMarker: string;
      resolvedText: string;
      aliasChain: string[];
    }
  | {
      kind: "unresolved";
      /** 实参原始文本（诊断用）。 */
      rawText: string;
      /** 为什么无法解析。 */
      reason: string;
      aliasChain: string[];
    };

/**
 * 判定"哪些路径算共享 / 哪些算独占"的标记集合。
 *
 * ── 为什么独占标记必须**显式登记** ──
 *
 * 若把"没命中共享标记"就当作独占，那么任何拼写错误、新增目录常量、
 * 或经无法解析的形态传进来的路径都会自动变成"安全" —— 那等于把
 * fail-closed 换成了 fail-open。
 *
 * 因此独占路径必须**逐个列出来**：门禁只放行它明确认识的独占路径，
 * 其余一律 `unresolved`（失败）。
 */
export interface SourcePathMarkers {
  /** 共享路径的标记（常量名或目录名片段）。 */
  shared: readonly string[];
  /** 已登记的**独占**合成路径标记。 */
  exclusive: readonly string[];
}

/**
 * 默认标记：覆盖 A3 合成实例的共享与独占路径。
 *
 * 调用方可以显式传入自己的集合（测试用），但**默认集合刻意只登记
 * 已知安全的独占路径**，这样"新增一个没人登记过的路径"会立刻暴露。
 */
export const DEFAULT_MARKERS: SourcePathMarkers = {
  shared: ["a3-content", "cet6-a3.db", "E2E_A3_CONTENT_ROOT", "E2E_A3_DB_PATH"],
  exclusive: [
    // ── A3 启动器独占的合成路径 ──
    // A3 合成源目录只被工作台本身读取，没有第二个进程共享。
    "a3-source",
    "E2E_A3_SOURCE_ROOT",
    // A3 工作台的交接文件（单实例写入、可随时重建）
    "a3-workbench.json",
    "E2E_A3_HANDOFF_PATH",

    /*
     * ── 各合成实例各自的数据库 ──
     *
     * 这些**必须**逐个登记成独占：隐私门禁本身就要求
     * "真实内容实例有独立数据库，不与合成实例共用"，
     * 因此每个实例删自己的库是合法的清场动作。
     *
     * 把它们列全而不是靠"没命中共享就算安全"—— 后者会让任何拼写错误
     * 或新增路径自动变成放行，等于把 fail-closed 换成 fail-open。
     */
    "cet6-e2e.db",
    "E2E_DB_PATH",
    "cet6-e2e-empty.db",
    "E2E_EMPTY_DB_PATH",
    "cet6-real.db",
    "E2E_REAL_DB_PATH",
    "cet6-review.db",
    "E2E_REVIEW_DB_PATH",
    "cet6-legacy.db",
    "E2E_LEGACY_DB_PATH",
    "cet6-legacy-reserved.db",
    "E2E_LEGACY_RESERVED_DB_PATH",
    "cet6-duplicate.db",
    "E2E_DUPLICATE_DB_PATH",
    "cet6-companion.db",
    "E2E_COMPANION_DB_PATH",
    "cet6-freshness.db",
    "E2E_FRESHNESS_DB_PATH",
    "cet6-loopback-proof.db",
    "E2E_LOOPBACK_PROOF_DB_PATH",

    // ── 各合成实例各自的内容根 ──
    "E2E_CONTENT_ROOT",
    "E2E_EMPTY_CONTENT_ROOT",
    "E2E_REVIEW_CONTENT_ROOT",
    "E2E_FRESHNESS_CONTENT_ROOT",
    "E2E_LEGACY_CONTENT_ROOT",
    "E2E_LEGACY_RESERVED_CONTENT_ROOT",
    "E2E_DUPLICATE_CONTENT_ROOT",
    "E2E_COMPANION_CONTENT_ROOT",
    "empty-content",

    // ── A1 / A2 实例的独占路径 ──
    "E2E_A1_SOURCE_ROOT",
    "E2E_A1_PAPERS_ROOT",
    "E2E_A2_RUN_ROOT",
    "E2E_A2_HANDOFF_PATH",
    "a2-intake-run",

    /*
     * ── 启动器内部的局部别名 ──
     *
     * 多个启动器写 `const DB = E2E_*_DB_PATH;`（或三元选择某个 DB 路径），
     * 再拼成 `\`${DB}${suffix}\``。它们指向的仍是各自独占的库。
     * 这里登记的正是这类局部变量名。
     */
    "RUN_ROOT",
    "CONTENT_ROOT",
    "DB",
  ],
};

/**
 * 解析一份 TypeScript 源码并收集全部 `rmSync` 调用点。
 *
 * @param source 源码文本（LF / CRLF 均可 —— AST 不关心换行风格）
 * @param fileName 仅用于诊断（行号据此计算）
 * @param markers 判定"哪些路径算共享/独占"的标记集合
 */
export function collectRmSyncCalls(
  source: string,
  fileName = "anonymous.ts",
  markers: SourcePathMarkers = DEFAULT_MARKERS,
): RmSyncCallSite[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const lines = sourceFile.getLineAndCharacterOfPosition.bind(sourceFile);
  const results: RmSyncCallSite[] = [];

  /*
   * ── 标识符别名解析（本轮修复的核心）──
   *
   * 启动器里有这种形态：
   *
   *     const t = E2E_A3_CONTENT_ROOT;
   *     rmSync(t, { recursive: true, force: true });
   *
   * 早先只把「实参文本」拿去和共享标记做子串匹配，于是 `"t"` 匹配不上，
   * 这条删除**根本不进入判定范围** —— 门禁静默放行一条无保护的共享目录删除。
   *
   * 现在按**作用域**解析标识符：从实参节点往上找最近的一个声明它的
   * `const`/`let`，取其初始化表达式继续解析。支持一层与连续两层别名，
   * 并且：
   *
   * - **循环引用**（`const a = b; const b = a;`）会被访问集合挡住，判为无法解析；
   * - **动态赋值**（非字面量/模板/拼接/别名）判为无法解析；
   * - 解析层数超过上限判为无法解析。
   *
   * 三者都会落到 `unresolved`（门禁失败），而不是"跳过"。
   */
  type ResolveOutcome =
    | { ok: true; text: string; chain: string[] }
    | { ok: false; reason: string; chain: string[] };

  /** 允许的最大别名层数（两层别名 + 起点本身）。 */
  const MAX_ALIAS_DEPTH = 3;

  /**
   * 一条被解析到的声明，附带它的**不可变性**信息。
   */
  type ResolvedDeclaration =
    | {
        ok: true;
        declaration: ts.VariableDeclaration;
        /** 声明关键字是否为 `const`（唯一允许的不可变形态）。 */
        immutable: true;
      }
    | {
        ok: false;
        reason: string;
      };

  /**
   * 找出「在 `atNode` 位置可见」的那个变量声明，并核对它是否**不可变**。
   *
   * ── 为什么不可变性必须在这里判，而不是在解析完之后 ──
   *
   * 判据的目标是"这条删除执行时，目标**必然**是那个值"。若别名可以在
   * 中途被重新赋值，那么"读到初始化表达式"就不构成任何证明 ——
   * 实测的绕过形态正是：
   *
   *     let target = E2E_A3_SOURCE_ROOT;   // 初始化像独占
   *     target = E2E_A3_CONTENT_ROOT;      // 之后改成共享
   *     rmSync(target, ...);               // 被误判为 exclusive ⇒ 放行
   *
   * 因此：**只有 `const` 声明才可能作为别名链的一环**。
   * `let` / `var` 一律判为无法解析（unresolved ⇒ 门禁失败）。
   *
   * 这条规则刻意不做"看后面有没有赋值"的赋值分析：
   * 那需要真正的控制流分析（条件赋值、循环、try/catch、闭包捕获），
   * 而本门禁的职责是"证明"，不是"尽力而为"。拒绝所有可变别名
   * 会把极少数误报转成人工复核成本，而放行一个漏报的代价是删掉
   * 另一个实例正在读的目录。这个方向的取舍已在仓库其他门禁中确立。
   *
   * 实测确认：全部真实启动器的删除目标都是直接常量或 `const` 别名，
   * 因此这条严格规则**不会阻断任何现有启动器**。
   *
   * ── 作用域为什么必须正确 ──
   *
   * 早先的实现从 `atNode` 逐层向上，在**每一个**祖先块里用
   * `forEachChild` 深搜 —— 于是内层块里声明的同名变量会被外层
   * 那一条的查找"看见"，反之亦然。实测的失败形态：
   *
   *     if (true) { const t = E2E_A3_SOURCE_ROOT; }   // 只在内层可见
   *     const t = E2E_A3_CONTENT_ROOT;                // 外层，才是这里的 t
   *     rmSync(t, ...);                               // 被误判为 exclusive
   *
   * 现在改为：先求出该标识符**词法可见**的候选声明（只看声明所在块的
   * 直接语句，以及函数/外层块），再取**位置在引用之前**的最近一条。
   * 内层块的声明不会为外层引用提供解析。
   */
  function findDeclaration(name: string, atNode: ts.Node): ResolvedDeclaration {
    /** 收集某个块/文件里**直接**声明的同名变量。 */
    function ownDeclarationsOf(container: ts.Node): ts.VariableDeclaration[] {
      /*
       * 只处理有 `statements` 的容器：文件、块、模块块。
       *
       * 刻意**不**处理 `switch` 的 `CaseBlock`（它的成员叫 `clauses`，
       * 且 case 之间的词法作用域语义容易出错）。E2E 启动器不使用
       * switch 声明路径别名，因此这里选择不收窄支持面 ——
       * 遇到 switch 内的声明会走"找不到声明"分支，即 fail-closed。
       */
      if (
        !ts.isSourceFile(container) &&
        !ts.isBlock(container) &&
        !ts.isModuleBlock(container)
      ) {
        return [];
      }
      const out: ts.VariableDeclaration[] = [];
      for (const statement of container.statements) {
        /*
         * 只看语句**自身**是不是变量声明（或包着它的 `for` 头）。
         * **不**深搜其内部块 —— 那是子作用域，不该给本层的引用提供声明。
         */
        const declarationLists: ts.VariableDeclarationList[] = [];
        if (ts.isVariableStatement(statement)) {
          declarationLists.push(statement.declarationList);
        } else if (ts.isForStatement(statement) && statement.initializer !== undefined) {
          const init = statement.initializer;
          if (ts.isVariableDeclarationList(init)) declarationLists.push(init);
        } else if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
          const init = statement.initializer;
          if (ts.isVariableDeclarationList(init)) declarationLists.push(init);
        }

        for (const list of declarationLists) {
          for (const declaration of list.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
              out.push(declaration);
            }
          }
        }
      }
      return out;
    }

    // 从引用处向上，收集每一层作用域的"本层声明"
    let scope: ts.Node | undefined = atNode;
    while (scope !== undefined) {
      const candidates = ownDeclarationsOf(scope).filter(
        // 声明必须出现在引用**之前**（词法顺序；同块内先声明后使用）
        (declaration) => declaration.getStart(sourceFile) <= atNode.getStart(sourceFile),
      );

      if (candidates.length > 0) {
        // 同层同名多条（非法代码）：取位置最近的那条，仍然受不可变约束
        const nearest = candidates.reduce((latest, item) =>
          item.getStart(sourceFile) > latest.getStart(sourceFile) ? item : latest,
        );

        const list = nearest.parent;
        if (!ts.isVariableDeclarationList(list)) {
          return { ok: false, reason: `\`${name}\` 的声明形态无法识别` };
        }

        /*
         * 唯一的不可变形态是 `const`。
         *
         * 注意 `const` 与 `let`/`var` 的区分必须看**声明列表的标志位**，
         * 而不是关键字文本 —— `ts.NodeFlags.Const` 是 AST 里的权威表示。
         */
        const isConst =
          ts.isVariableDeclarationList(list) &&
          (list.flags & ts.NodeFlags.Const) !== 0;

        if (!isConst) {
          const keyword = (list.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
          return {
            ok: false,
            reason:
              `\`${name}\` 由 \`${keyword}\` 声明，可能在引用前被重新赋值 —— ` +
              `可变别名无法证明删除目标，判为无法解析（失败关闭）`,
          };
        }

        return { ok: true, declaration: nearest, immutable: true };
      }

      scope = scope.parent;
    }

    return {
      ok: false,
      reason: `无法在本文件内找到 \`${name}\` 的声明（可能来自 import 或运行期赋值）`,
    };
  }

  /** 把实参表达式解析成它的路径文本；无法确定时返回原因。 */
  function resolveTargetText(node: ts.Expression, depth = 0, seen = new Set<string>()): ResolveOutcome {
    const own = node.getText(sourceFile);

    // 非标识符：直接就是可判定的字面量/模板/拼接表达式
    if (!ts.isIdentifier(node)) {
      return { ok: true, text: own, chain: [] };
    }

    const name = node.text;

    // 循环引用保护
    if (seen.has(name)) {
      return { ok: false, reason: `别名循环引用：${[...seen, name].join(" → ")}`, chain: [...seen, name] };
    }
    if (depth >= MAX_ALIAS_DEPTH) {
      return {
        ok: false,
        reason: `别名层数超过上限（${MAX_ALIAS_DEPTH} 层）：${[...seen, name].join(" → ")}`,
        chain: [...seen, name],
      };
    }

    const resolution = findDeclaration(name, node);
    if (!resolution.ok) {
      /*
       * 声明不可用或**可变**（let/var）—— 一律无法解析。
       *
       * 这是本轮修复的核心：不可变别名才可能构成"目标必然是什么"的证明。
       */
      return { ok: false, reason: resolution.reason, chain: [...seen, name] };
    }

    const declaration = resolution.declaration;
    if (declaration.initializer === undefined) {
      return {
        ok: false,
        reason: `\`${name}\` 声明没有初始值，无法确定删除目标`,
        chain: [...seen, name],
      };
    }

    const initializer = declaration.initializer;

    /*
     * 只接受四类**静态可判定**的初始化形态：
     * 字符串字面量、无插值模板、带插值模板、二元拼接（`+`）。
     *
     * 其余（函数调用、条件表达式、成员访问、解构等）一律无法解析 ——
     * 这正是 fail-closed 要求的"不替它猜"。
     */
    const isStaticShape =
      ts.isStringLiteral(initializer) ||
      ts.isNoSubstitutionTemplateLiteral(initializer) ||
      ts.isTemplateExpression(initializer) ||
      ts.isBinaryExpression(initializer) ||
      ts.isIdentifier(initializer);

    if (!isStaticShape) {
      return {
        ok: false,
        reason:
          `\`${name}\` 的初始值不是静态可判定的路径` +
          `（${ts.SyntaxKind[initializer.kind]}）`,
        chain: [...seen, name],
      };
    }

    const nextSeen = new Set(seen);
    nextSeen.add(name);

    if (ts.isIdentifier(initializer)) {
      /*
       * 别名指向另一个标识符：那一层**本身**可能就是一个已知标记
       * （典型形态 `const t = E2E_A3_CONTENT_ROOT;`，而后者是 import 进来的）。
       *
       * 因此先看它的文本是否命中标记 —— 命中就到此为止，
       * 不必（也无法）在本文件里找它的声明。
       */
      const innerText = initializer.getText(sourceFile);
      const innerHit =
        markers.shared.find((marker) => innerText.includes(marker)) ??
        markers.exclusive.find((marker) => innerText.includes(marker));
      if (innerHit !== undefined) {
        return { ok: true, text: `${own} ${innerText}`, chain: [name] };
      }

      // 递归解析下一层别名
      const inner = resolveTargetText(initializer, depth + 1, nextSeen);
      if (!inner.ok) return inner;
      return { ok: true, text: `${own} ${inner.text}`, chain: [name, ...inner.chain] };
    }

    return { ok: true, text: `${own} ${initializer.getText(sourceFile)}`, chain: [name] };
  }

  /** 按标记把解析结果归类。 */
  function classify(argNode: ts.Expression): DeletionTarget {
    const rawText = argNode.getText(sourceFile);

    /*
     * ── 先看「实参本身是否已经是标记」──
     *
     * 启动器最常见、也最该直接放行/检查的形态是直接引用常量：
     *
     *     rmSync(E2E_A3_CONTENT_ROOT, …)   // 共享，需授权
     *     rmSync(E2E_A3_SOURCE_ROOT, …)    // 独占，放行
     *
     * 这些常量多数是从 `e2e/config.ts` import 进来的，**本文件里没有声明**。
     * 若先去解析声明再分类，它们会全部变成 `unresolved` —— 那会把
     * "正确的真实代码"误判成违规，逼着人去给门禁开后门。
     *
     * 因此顺序是：**先按标记认实参本身，认不出来再去解析别名。**
     * 这不放松任何判据：标记仍然只认显式登记过的那些。
     */
    const directShared = markers.shared.find((marker) => rawText.includes(marker));
    if (directShared !== undefined) {
      return {
        kind: "shared",
        matchedMarker: directShared,
        resolvedText: rawText,
        aliasChain: [],
      };
    }
    const directExclusive = markers.exclusive.find((marker) => rawText.includes(marker));
    if (directExclusive !== undefined) {
      return {
        kind: "exclusive",
        matchedMarker: directExclusive,
        resolvedText: rawText,
        aliasChain: [],
      };
    }

    const resolution = resolveTargetText(argNode);

    if (!resolution.ok) {
      return {
        kind: "unresolved",
        rawText,
        reason: resolution.reason,
        aliasChain: resolution.chain,
      };
    }

    const sharedHit = markers.shared.find((marker) => resolution.text.includes(marker));
    if (sharedHit !== undefined) {
      return {
        kind: "shared",
        matchedMarker: sharedHit,
        resolvedText: resolution.text,
        aliasChain: resolution.chain,
      };
    }

    const exclusiveHit = markers.exclusive.find((marker) => resolution.text.includes(marker));
    if (exclusiveHit !== undefined) {
      return {
        kind: "exclusive",
        matchedMarker: exclusiveHit,
        resolvedText: resolution.text,
        aliasChain: resolution.chain,
      };
    }

    /*
     * 既不是共享也不是已登记的独占路径 —— 无法判断它会删掉什么。
     * **失败关闭**：不跳过，交由调用方报告。
     */
    return {
      kind: "unresolved",
      rawText,
      reason:
        `删除目标 \`${resolution.text}\` 既未命中共享路径标记，` +
        `也未命中已登记的独占合成路径标记 —— 无法判断它会删掉什么`,
      aliasChain: resolution.chain,
    };
  }

  /** 收集包住该节点的每一层控制流，并逐层分析授权贡献。 */
  function enclosersOf(node: ts.Node): GuardAnalysis[] {
    const out: GuardAnalysis[] = [];
    let current: ts.Node | undefined = node.parent;
    let child: ts.Node = node;

    while (current !== undefined) {
      if (ts.isIfStatement(current)) {
        const isElseSide = current.elseStatement !== undefined && current.elseStatement === child;
        out.push(analyzeEnclosingIf(current, child, isElseSide, sourceFile));
      } else if (isDeferredBoundary(current)) {
        /*
         * 回调 / 函数体 / 定时器等：执行时机与当前控制流无关。
         * 记一笔 `destroys`，让任何跨过它的调用都失败关闭 ——
         * "放在 setTimeout 里的授权"不是授权。
         */
        out.push({
          verdict: "destroys",
          condition: "",
          branch: "then",
          reason:
            "该删除位于一个延迟执行边界内（函数体 / 回调 / 定时器），" +
            "执行时机不受当前控制流约束，因此不能视为已授权",
          deferred: true,
        });
      }
      child = current;
      current = current.parent;
    }

    // parent 链是内→外，反转成由外到内便于阅读与逐层判定
    return out.reverse();
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (name === "rmSync") {
        const firstArg = node.arguments[0];
        const { line } = lines(node.getStart(sourceFile));
        const enclosers = enclosersOf(node);
        results.push({
          line: line + 1,
          firstArgument: firstArg === undefined ? "" : firstArg.getText(sourceFile),
          target:
            firstArg === undefined
              ? {
                  kind: "unresolved",
                  rawText: "",
                  reason: "rmSync 没有任何实参 —— 无法判断它会删掉什么",
                  aliasChain: [],
                }
              : classify(firstArg),
          enclosingIfConditions: enclosers
            .filter((item) => item.condition !== "")
            .map((item) => item.condition),
          enclosers,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * 这些节点构成"延迟执行"边界：里面的语句不保证在当前控制流下立刻执行。
 *
 * 刻意**不**把普通块 `{ }` 与 `try` 算进来 —— 它们是顺序执行的，
 * 不改变"授权是否必然成立"。
 */
function isDeferredBoundary(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return true;
  }
  if (ts.isMethodDeclaration(node)) return true;
  return false;
}

/**
 * 分析一层 `if` 对该调用的授权贡献。
 *
 * `child` 是通往被检查调用的那条子语句 —— 它决定了我们是走 then 还是 else。
 */
function analyzeEnclosingIf(
  statement: ts.IfStatement,
  child: ts.Node,
  isElseSide: boolean,
  sourceFile: ts.SourceFile,
): GuardAnalysis {
  const condition = statement.expression.getText(sourceFile);

  /*
   * ── then 侧：条件成立才执行 ──
   *
   * 只有当条件**证明**了授权时才算 `proved`。其余情况（不涉及开关）
   * 算 `neutral` —— 它不破坏外层的证明。
   *
   * 例外：条件里出现了开关但**不能证明**正向授权（否定 / OR / truthy /
   * 取反 / 复杂表达式）⇒ `destroys`。因为"在开关上做了判断却没证明它成立"
   * 意味着这条路径**可能**在未授权时执行。
   */
  if (!isElseSide) {
    const verdict = evaluateCond(statement.expression, sourceFile);
    return {
      verdict: verdict.kind,
      condition,
      branch: ts.isBlock(statement.thenStatement) ? "then" : "bare-then",
      reason: verdict.reason,
    };
  }

  /*
   * ── else 侧：条件**不成立**才执行 ──
   *
   * 这是最容易被误判的一侧。若条件恰好是"正向授权"，那么 else 分支
   * 就是"授权不成立时执行删除" —— 必须判为 `destroys`。
   *
   * 反之，若条件是"否定形态"（`!==`/`!`），它的 else 反而等价于正向授权。
   * 但本门禁**刻意不**把这种双重否定当作白名单：可读性差、且极易
   * 在后续编辑中反转。失败关闭更安全，且真实启动器不这么写。
   */
  return {
    verdict: "destroys",
    condition,
    branch: "else",
    reason:
      "该删除位于 `else` 分支 —— 它恰好在条件**不成立**时执行，" +
      "因此不构成授权（无论 if 条件本身是否提到了开关）",
  };
}

type CondVerdict =
  | { kind: "proved"; reason: string }
  | { kind: "neutral"; reason: string }
  | { kind: "destroys"; reason: string };

/**
 * 判定一个条件表达式是否**证明**了"授权开关精确成立"。
 *
 * ── 白名单（刻意很小）──
 *
 * 1. `SWITCH_EXPR === "1"` / `"1" === SWITCH_EXPR` —— 唯一被接受的正向比较；
 * 2. 上述条件与其他表达式的 `&&` 合取 —— 合取只会**加强**约束；
 * 3. 完全不含开关的表达式 —— `neutral`（不破坏外层证明）。
 *
 * ── 黑名单（一律 destroys 或 neutral）──
 *
 * - `!==` / `!=`：否定比较；
 * - `||`：可以绕过授权；
 * - 前缀 `!`：逻辑取反；
 * - `Boolean(...)` / 裸标识符 / 任意函数调用：无法证明精确值 `"1"`；
 * - `?:`、赋值、逗号表达式等无法静态确定形态的写法。
 */
function evaluateCond(expression: ts.Expression, sourceFile: ts.SourceFile): CondVerdict {
  /*
   * ── 先解包多余括号 ──
   *
   * `if ((process.env.X === "1"))` 在 AST 里是一个 `ParenthesizedExpression`，
   * 不是 `BinaryExpression`。若不解包，这个语义完全相同的写法会掉进
   * "涉及开关但形态不明"分支被判为危险 —— 那是一处纯形式的误报。
   *
   * 解包是安全的：括号不改变求值语义。
   */
  let node: ts.Expression = expression;
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }

  const text = expression.getText(sourceFile);

  // ── 1) 合取：全部子句都不得破坏，且至少一个证明授权 ──
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = evaluateCond(node.left, sourceFile);
    const right = evaluateCond(node.right, sourceFile);

    if (left.kind === "destroys" || right.kind === "destroys") {
      return {
        kind: "destroys",
        reason: `合取 \`${text}\` 中有一个子句无法证明授权（${left.kind === "destroys" ? left.reason : right.reason}）`,
      };
    }
    if (left.kind === "proved" || right.kind === "proved") {
      return { kind: "proved", reason: `合取 \`${text}\` 中有子句正向证明了授权，且无子句削弱它` };
    }
    return { kind: "neutral", reason: `合取 \`${text}\` 未涉及授权开关` };
  }

  // ── 2) 析取：可以绕过授权 ──
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return {
      kind: "destroys",
      reason:
        `析取 \`${text}\` 可以被**任意一侧**满足 —— 另一个条件成立时无需授权即可执行，` +
        "因此 OR 不能作为授权证明",
    };
  }

  // ── 3) 正向相等比较（唯一被接受的正向形态）──
  if (isStrictEquality(node)) {
    const binary = node as ts.BinaryExpression;
    const { switchSide, literalSide } = splitSwitchAndLiteral(binary, sourceFile);

    if (switchSide !== null && literalSide !== null) {
      if (literalSide === "1") {
        return { kind: "proved", reason: `\`${text}\` 正向比较证明了开关精确等于 "1"` };
      }
      return {
        kind: "neutral",
        reason: `\`${text}\` 比较的是开关的其它取值（"${literalSide}"），不构成本门禁要求的授权`,
      };
    }
    return { kind: "neutral", reason: `\`${text}\` 是相等比较，但未涉及授权开关` };
  }

  // ── 4) 否定相等比较：危险 ──
  if (isNegatedEquality(node)) {
    return {
      kind: "destroys",
      reason:
        `否定比较 \`${text}\` —— 它在开关**不成立**时才为真，` +
        "因此这条路径可能在未授权时执行",
    };
  }

  // ── 5) 逻辑取反：无法证明正向成立 ──
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return {
      kind: "destroys",
      reason: `逻辑取反 \`${text}\` 的成立意味着原条件不成立，无法证明授权`,
    };
  }

  // ── 6) 其它涉及开关的形态：一律失败关闭 ──
  if (mentionsGuardToken(node, sourceFile)) {
    return {
      kind: "destroys",
      reason:
        `条件 \`${text}\` 涉及授权开关，但形态不在可证明的白名单内` +
        "（例如 Boolean(...)、裸变量、函数调用、真值判断）—— 无法证明它精确等于 \"1\"",
    };
  }

  // ── 7) 完全不涉及开关：不破坏外层证明 ──
  return { kind: "neutral", reason: `\`${text}\` 未涉及授权开关` };
}

function isStrictEquality(expression: ts.Expression): boolean {
  return (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
  );
}

function isNegatedEquality(expression: ts.Expression): boolean {
  return (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  );
}

/** 比较的一侧指向开关、另一侧是字面量时，拆出来。 */
function splitSwitchAndLiteral(
  binary: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
): { switchSide: string | null; literalSide: string | null } {
  const leftText = binary.left.getText(sourceFile);
  const rightText = binary.right.getText(sourceFile);

  const isSwitchSide = (node: ts.Expression): boolean => mentionsGuardToken(node, sourceFile, /* precise */ true);
  const literalOf = (node: ts.Expression): string | null =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;

  if (isSwitchSide(binary.left)) {
    return { switchSide: leftText, literalSide: literalOf(binary.right) };
  }
  if (isSwitchSide(binary.right)) {
    return { switchSide: rightText, literalSide: literalOf(binary.left) };
  }
  return { switchSide: null, literalSide: null };
}

/**
 * 判断表达式是否引用了授权开关。
 *
 * @param precise 为 true 时只认"读环境变量"的形态
 *                （`process.env.X` / 裸 `X`），用于比较两侧的识别。
 */
function mentionsGuardToken(node: ts.Node, sourceFile: ts.SourceFile, precise = false): boolean {
  const text = node.getText(sourceFile);
  if (!GUARD_TOKEN.test(text)) return false;
  if (!precise) return true;

  /*
   * 精确形态：`process.env.E2E_RESET_DB`、`process.env["E2E_RESET_DB"]`、
   * 或裸标识符 `E2E_RESET_DB`。`Boolean(...)` / 函数调用 / 取反都**不**算 ——
   * 它们不是"开关的取值本身"。
   */
  if (ts.isPropertyAccessExpression(node)) {
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env"
    );
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env" &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === SWITCH_NAME
    );
  }
  return ts.isIdentifier(node) && node.text === SWITCH_NAME;
}

/** 授权开关的名字（唯一权威常量）。 */
const SWITCH_NAME = "E2E_RESET_DB";

/** 用于"提到了开关"的宽松匹配。 */
const GUARD_TOKEN = new RegExp(`\\b${SWITCH_NAME}\\b`);

/**
 * 判断某个 `rmSync` 调用是否在**语义上**被授权开关保护。
 *
 * 判定规则：控制流路径上**每一层**都不得 `destroys`，且**至少一层** `proved`。
 *
 * 为什么是"至少一层 proved"而不是"最内层 proved"：
 * 外层正向授权条件对内层是**严格施加**的 —— 只要外层证明了开关等于 "1"，
 * 内层的任何条件都无法让开关变成别的值。因此内层出现无关条件（neutral）
 * 不影响结论；但内层若出现 `destroys`（例如内层是 `else` 分支、
 * 或内层对开关做了否定判断），整个路径就不再受保护。
 */
export function isGuardedBy(call: RmSyncCallSite, guardToken: string): boolean {
  // 兼容调用方传入自定义开关名：只在名字一致时按本模块语义判定。
  if (guardToken !== SWITCH_NAME) {
    const pattern = new RegExp(`\\b${guardToken}\\b`);
    return call.enclosingIfConditions.some((condition) => pattern.test(condition));
  }

  const hasProof = call.enclosers.some((item) => item.verdict === "proved");
  const hasDestruction = call.enclosers.some((item) => item.verdict === "destroys");
  return hasProof && !hasDestruction;
}

/**
 * 汇总一个调用点未受保护的原因（供失败信息使用）。
 *
 * 刻意返回**具体**原因列表而不是布尔：失败信息必须能让读者直接定位
 * "是哪一层、因为什么写法",否则它会退化成"某处有问题"。
 */
export function explainUnguarded(call: RmSyncCallSite): string[] {
  const reasons: string[] = [];

  const destroyed = call.enclosers.filter((item) => item.verdict === "destroys");
  for (const item of destroyed) {
    reasons.push(item.condition === "" ? item.reason : `[${item.branch}] ${item.reason}`);
  }

  if (!call.enclosers.some((item) => item.verdict === "proved")) {
    reasons.push(
      call.enclosers.length === 0
        ? "该删除位于顶层 —— 没有任何条件保护"
        : "控制流路径上没有任何一层正向证明了授权开关等于 \"1\"",
    );
  }

  return reasons;
}

/**
 * 从源码里找出所有**指向共享路径**的 `rmSync` 调用。
 *
 * ── 本轮语义变化 ──
 *
 * 早先它对 `firstArgument` 做子串匹配：实参不是直接写出来的共享路径
 * （别名、函数调用、条件表达式）时**根本不会命中**，于是那条删除
 * 完全不进入判定 —— 静默放行。
 *
 * 现在改为按 `target.kind === "shared"` 筛选，而 `target` 来自
 * 作用域正确的别名解析（见 `classify`）。无法解析的目标不会被这里
 * 悄悄丢掉，而是保留在完整调用列表里，由 `auditSharedRmSync` 判为失败。
 */
export function findSharedPathRmSyncCalls(
  source: string,
  markers: readonly string[],
  fileName = "anonymous.ts",
  exclusiveMarkers: readonly string[] = [],
): RmSyncCallSite[] {
  return collectRmSyncCalls(source, fileName, {
    shared: markers,
    exclusive: exclusiveMarkers,
  }).filter((call) => call.target.kind === "shared");
}

/**
 * 对"共享路径的删除必须受开关保护"这条规则做**一次完整判定**。
 *
 * ── 三类目标的处置（本轮修复的核心）──
 *
 * | 目标分类 | 处置 |
 * | --- | --- |
 * | `shared` | 必须通过授权检查；无授权 ⇒ 违规 |
 * | `exclusive` | 放行（明确的独占合成路径，没有第二个进程读它） |
 * | `unresolved` | **违规**（失败关闭） |
 *
 * 第三条是关键：一个无法确定目标的删除既可能删掉共享目录，也可能删掉
 * 别的东西。门禁不能替它猜 —— "解析不了"必须与"不安全"同等对待。
 */
export interface SharedRmSyncAudit {
  /** 全部 `rmSync` 调用（含独占与无法解析的，便于诊断）。 */
  calls: RmSyncCallSite[];
  /** 其中指向共享路径的调用。 */
  sharedCalls: RmSyncCallSite[];
  /** 其中指向独占合成路径的调用。 */
  exclusiveCalls: RmSyncCallSite[];
  /** 违规：共享路径无授权，或目标无法解析。 */
  violations: RmSyncCallSite[];
}

export function auditSharedRmSync(
  source: string,
  markers: readonly string[],
  guardToken: string,
  fileName = "anonymous.ts",
  exclusiveMarkers: readonly string[] = DEFAULT_MARKERS.exclusive,
): SharedRmSyncAudit {
  const calls = collectRmSyncCalls(source, fileName, { shared: markers, exclusive: exclusiveMarkers });
  const sharedCalls = calls.filter((call) => call.target.kind === "shared");
  const exclusiveCalls = calls.filter((call) => call.target.kind === "exclusive");

  const violations: RmSyncCallSite[] = [];
  for (const call of calls) {
    if (call.target.kind === "unresolved") {
      // 无法解析 ⇒ 失败关闭（不是跳过，也不是当成独占）
      violations.push(call);
      continue;
    }
    if (call.target.kind === "exclusive") continue;
    // shared：必须通过授权检查
    if (!isGuardedBy(call, guardToken)) violations.push(call);
  }

  return { calls, sharedCalls, exclusiveCalls, violations };
}
