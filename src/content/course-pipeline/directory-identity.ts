/**
 * 本机目录**身份**判定（metadata-only，fail-closed）。
 *
 * ── 它解决的真实缺陷（评审指出的）──
 *
 * `scripts/course-a1-owner-acceptance.ts` 早先这样判断"使用者是否选中了
 * 本次创建的合成测试目录"：
 *
 *     pickedCorrectly = basename(picked.path) === FIXTURE_DIR_NAME;
 *
 * **只比目录名不足以证明它是同一个目录。** 只要机器上**任何其它位置**
 * 恰好有一个同名目录（例如 使用者的下载目录里有一份同名的旧测试夹，
 * 或上一次运行留下的未删净副本），这次验收就会把它当成"正确"而接受，
 * 随后**读取并检查那个目录的内容** —— 而它可能根本不是本次合成夹具，
 * 甚至可能包含真实材料。
 *
 * 对一条以"只碰合成材料"为硬约束的验收工具来说，这是必须失败关闭的。
 *
 * ── 判据：真实路径身份，而不是名字 ──
 *
 * 用 Node 内置的 `realpathSync.native` 把**两侧**都解析成规范真实路径，
 * 再用 `path.relative` 复核"从一侧到另一侧的空相对路径"。
 * 两侧都要解析的理由是具体的：Windows 上 `os.tmpdir()` 常带 8.3 短名
 * （形如 `C:\Users\<account>~1\AppData\...`），而系统文件夹对话框回传的是**长名**
 * 路径 —— 即使选对了，裸字符串比较也会不相等。因此**必须**归一后再比。
 *
 * ── 为什么是 metadata-only ──
 *
 * 本模块**只**调用 `realpathSync` / `statSync`：它们只碰目录项元数据，
 * **绝不打开文件、绝不枚举目录内容**。因此"身份未确认之前不读取任何内容"
 * 是一条**结构性**事实（本模块没有读内容的调用点），而不是调用顺序上的纪律。
 * 由 `tests/course-a1-workbench.test.ts` 的源码级门禁守护。
 *
 * ── 为什么不用 dev/ino 作为额外信号 ──
 *
 * 真实路径相等已经**同时**覆盖硬链接、目录联接（junction）与大小写/
 * 短名差异（`realpathSync.native` 会把它们全部收敛到同一个规范路径）。
 * 再叠一层 dev/ino 只会增加分支而不增加判据强度 —— 而每多一个分支，
 * 就多一处可能 fail-open 的地方。**严格相等 + 失败关闭**是这里要的性质。
 */

import { realpathSync, statSync } from "node:fs";
import { relative } from "node:path";

/** 身份判定被拒绝的原因（每一种都有独立的处置措辞）。 */
export type DirectoryIdentityRejection =
  /** 我们自己创建的夹具根解析不了 —— 本次验收无法成立。 */
  | "expected_root_unresolvable"
  /** 选中路径解析不了（不存在 / 断链 / 权限不足 / 非法字符）。 */
  | "picked_path_unresolvable"
  /** 解析成功，但它不是一个目录（例如选中了文件）。 */
  | "picked_path_not_a_directory"
  /** 解析成功且是目录，但它**不是**本次创建的那个目录。 */
  | "picked_path_not_the_expected_directory";

export type DirectoryIdentityVerdict =
  | { accepted: true; realPath: string }
  | { accepted: false; reason: DirectoryIdentityRejection; message: string };

type Resolved =
  | { ok: true; realPath: string }
  | { ok: false; reason: "unresolvable" | "not_a_directory" };

/**
 * 把一个路径解析成**规范真实路径**（只读元数据）。
 *
 * 失败一律返回 tagged 结果而不是抛异常：调用方必须对"解析不了"给出
 * 与"解析成功但不是同一个目录"**不同**的处置，而异常会把两者压成同一个
 * `catch`。这与 `folder-picker` 把"取消"与"失败"分开是同一条纪律。
 */
export function resolveDirectoryIdentity(absolutePath: string): Resolved {
  let realPath: string;
  try {
    // `.native` 用操作系统的真实解析（Windows 上会展开短名与目录联接）；
    // 普通 `realpathSync` 在 Windows 上对短名路径可能不做同样归一。
    realPath = realpathSync.native(absolutePath);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  try {
    if (!statSync(realPath).isDirectory()) return { ok: false, reason: "not_a_directory" };
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  return { ok: true, realPath };
}

/** 面向 使用者的中文措辞（**不含任何绝对路径**）。 */
export function describeIdentityRejection(reason: DirectoryIdentityRejection, expectedLabel: string): string {
  switch (reason) {
    case "expected_root_unresolvable":
      return "程序自己刚创建的测试文件夹解析不了，因此这一次验收无法成立。请重新运行本程序。";
    case "picked_path_unresolvable":
      return "你选中的文件夹无法解析（可能已被移动、删除，或没有访问权限）。请重新选择。";
    case "picked_path_not_a_directory":
      return "你选中的不是一个文件夹（看起来是一个文件）。请重新选择文件夹。";
    case "picked_path_not_the_expected_directory":
      return (
        `你选中的文件夹**不是本次创建的那个测试目录**，只是名字碰巧相同。` +
        `为防止读到无关内容，本次检查已拒绝。请在窗口里选中本次的「${expectedLabel}」，` +
        `或点「换一个文件夹」重试。`
      );
  }
}

/**
 * 判定"选中的路径是否**就是**本次创建的那个目录"（**唯一判据入口**）。
 *
 * 任一环节无法确认即**拒绝**（fail-closed）：夹具根解析不了、选中路径
 * 解析不了、选中路径不是目录、真实路径不相等。
 */
export function verifyPickedDirectory(
  expectedRoot: string,
  pickedPath: string,
  expectedLabel: string,
): DirectoryIdentityVerdict {
  const expected = resolveDirectoryIdentity(expectedRoot);
  if (!expected.ok) {
    const reason: DirectoryIdentityRejection = "expected_root_unresolvable";
    return { accepted: false, reason, message: describeIdentityRejection(reason, expectedLabel) };
  }

  const picked = resolveDirectoryIdentity(pickedPath);
  if (!picked.ok) {
    const reason: DirectoryIdentityRejection =
      picked.reason === "not_a_directory" ? "picked_path_not_a_directory" : "picked_path_unresolvable";
    return { accepted: false, reason, message: describeIdentityRejection(reason, expectedLabel) };
  }

  /*
   * 两道判据都要成立，缺一即拒绝：
   * ① 规范真实路径**逐字符相等**（realpath 已统一大小写、短名与联接）；
   * ② 从期望目录到选中目录的**相对路径为空**（`""` 即"就是它自己"）。
   *
   * 第 ② 条不是第 ① 条的重复 —— 它实测具备**纵深防御**：
   * 单独把 ① 改成"只比名字"（保留 ②）时，同名别处目录**仍然被拒绝**，
   * 行为级用例**不会**变红。也就是说，要真正让这条安全属性失效，
   * 必须**同时**破坏两条（已由因果红/绿实测确认）。
   *
   * 保留两条而非合并成一条的理由正在于此：它们由不同的机制提供
   * （字符串成立 vs 路径代数），任何一条被单独改坏都不足以放行错目录。
   */
  const sameRealPath = expected.realPath === picked.realPath;
  const emptyRelative = relative(expected.realPath, picked.realPath) === "";
  if (sameRealPath && emptyRelative) {
    return { accepted: true, realPath: picked.realPath };
  }

  const reason: DirectoryIdentityRejection = "picked_path_not_the_expected_directory";
  return { accepted: false, reason, message: describeIdentityRejection(reason, expectedLabel) };
}

/** 选中结果处置：**只有**通过身份校验的目录才会得到"可以记住"的路径。 */
export type PickedDirectoryDecision =
  | { remember: string }
  | { remember: null; reason: DirectoryIdentityRejection; message: string };

/**
 * 验收工具使用**唯一**入口。
 *
 * ── 为什么把它单独抽出来 ──
 *
 * "拒绝之后仍然去读内容"这件事必须在**结构上**不可能，而不是靠调用顺序
 * 记得先校验。这里的返回类型强制了这一点：被拒绝时 `remember` 是 `null`，
 * 因此调用方拿不到任何可用于读取的路径 —— 只能把它丢掉。
 */
export function decideSourceAfterPick(
  expectedRoot: string,
  pickedPath: string,
  expectedLabel: string,
): PickedDirectoryDecision {
  const verdict = verifyPickedDirectory(expectedRoot, pickedPath, expectedLabel);
  if (verdict.accepted) return { remember: verdict.realPath };
  return { remember: null, reason: verdict.reason, message: verdict.message };
}

/**
 * 一次"选择文件夹"尝试的完整处置（**纯数据输入**，便于直接驱动）。
 *
 * ── 谁会被改、谁不会被改（这是本轮唯一的行为变更面）──
 *
 * | 结局 | `nextSource` | 理由 |
 * | --- | --- | --- |
 * | `confirmed` | 规范化后的**真实路径** | 身份已核对 |
 * | `rejected`（同名但非本次目录） | **null** | 本轮的修复：严格失败关闭 |
 * | `cancelled` | **原样保留 `currentSource`** | 取消不是错误，**既有行为不变** |
 * | `dialog_unavailable` | **原样保留 `currentSource`** | 打不开不是错误，**既有行为不变** |
 *
 * `cancelled` 与 `dialog_unavailable` 刻意**不**清空：取消/重试的既有语义
 * （用户关掉窗口后还能对之前选好的目录继续）必须保持不变，否则本轮修复会
 * 顺手改掉一条与安全无关的交互行为 —— 那不是"聚焦修复"。
 */
export interface PickResolutionInput {
  /** `pickFolder()` 的结局。 */
  outcome: string;
  /** 选中路径（`selected` 时非 null）。 */
  pickedPath: string | null;
  /** 本次创建的夹具根。 */
  expectedRoot: string;
  /** 夹具目录名（**只作展示**）。 */
  expectedLabel: string;
  /** 当前会话里已记住的源。 */
  currentSource: string | null;
}

/** 一次尝试处置后的状态（调用方据此更新会话与打印）。 */
export interface PickResolution {
  /** 新的"已记住的源"。被**拒绝**时必须是 null（严格失败关闭）。 */
  nextSource: string | null;
  /** 是否确认选中了本次目录。 */
  pickedCorrectly: boolean;
  /** 给 使用者 看的一句话（**不含绝对路径**）。 */
  message: string;
  /** 语义分类，便于调用方决定用哪种前缀与处置。 */
  kind: "confirmed" | "rejected" | "cancelled" | "dialog_unavailable";
}

/**
 * 把"一次选择尝试"收敛成新的会话状态（**唯一实现**）。
 *
 * ── 为什么这段逻辑必须抽出来并被直接测试 ──
 *
 * 它是整条验收里**唯一**决定"接下来能不能读盘"的地方，而它此前只存在于
 * 验收脚本的闭包里 —— 于是它只能被**源码模式匹配**守护（那种断言在逻辑被
 * 改写但形态相似时会漏掉）。抽成纯函数之后，被测的是**行为**：
 * 给一个同名但在别处的目录，返回的 `nextSource` 必须是 `null`，
 * 无论调用方怎么写。
 *
 * ── 它刻意不做的事 ──
 *
 * 不打印、不弹窗。呈现留给调用方 —— 因此这条判据可以在测试里被穷举，
 * 而不需要真实 GUI。
 */
export function resolvePickOutcome(input: PickResolutionInput): PickResolution {
  if (input.outcome === "selected" && input.pickedPath !== null) {
    const decision = decideSourceAfterPick(input.expectedRoot, input.pickedPath, input.expectedLabel);
    if (decision.remember !== null) {
      return {
        nextSource: decision.remember,
        pickedCorrectly: true,
        message: `已确认：你选中的是本次测试目录「${input.expectedLabel}」（已核对真实路径身份）。`,
        kind: "confirmed",
      };
    }
    /*
     * 拒绝 ⇒ **清空**已记住的源。
     *
     * 若只把本次结果置空，而此前已经记过一个目录（例如 使用者 先选对、
     * 又点开换成了一个同名的错目录），那个旧路径仍会留在会话里 ——
     * 界面还能继续读它。清空之后 `browse` / `inspect` 会直接拒绝，
     * 因此"被拒绝 ⇒ 不继续检查"是一条**结构性**事实。
     */
    return {
      nextSource: null,
      pickedCorrectly: false,
      message: decision.message,
      kind: "rejected",
    };
  }

  if (input.outcome === "cancelled") {
    return {
      // 取消**不是失败** ⇒ 保持既有行为（不清空已选好的目录）
      nextSource: input.currentSource,
      pickedCorrectly: false,
      message: "你取消了选择。想继续时再点一次「选择课程文件夹…」即可（取消不是错误）。",
      kind: "cancelled",
    };
  }

  return {
    // 打不开**不是失败** ⇒ 同样保持既有行为
    nextSource: input.currentSource,
    pickedCorrectly: false,
    message: `文件夹选择窗口没能打开（原因代码：${input.outcome}）。`,
    kind: "dialog_unavailable",
  };
}
