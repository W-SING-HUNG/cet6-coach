import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 逃逸夹具的真实构造能力探测（**不是**跳过开关）。
 *
 * ── 为什么需要它，以及它为什么不能只是一个 `catch { return }` ──
 *
 * 本仓库有若干测试要证明「指向内容根之外的符号链接会被拒绝」。它们原先写成：
 *
 *     try { symlinkSync(...) } catch { return; }
 *
 * 这在 Windows 上是**永久空跑**：非管理员进程创建符号链接会拿到 `EPERM`
 * （Windows 的 `SeCreateSymbolicLinkPrivilege` 默认只授予管理员与开发者模式），
 * 于是每一条真实断言都被 `return` 跳过，而测试仍然报 PASS。
 * 「没有执行」被显示成「通过了」——这正是本仓库在别处反复拒绝的那种静默失败。
 *
 * ── 本模块的判据 ──
 *
 * 在**临时目录**里真的建一次链接并**真的解析**它，确认：
 *   1. 链接创建成功；
 *   2. `realpath` 之后确实落在根本之外（即它真的能表达"逃逸"这件事）。
 *
 * 只有两条都成立才返回 `available: true`。探测本身失败**不会**被吞掉：
 * 调用方必须显式处理 `available: false`。
 *
 * ── Windows 上的受控替代：junction ──
 *
 * Windows 上**普通用户**可以创建目录 junction（`symlinkSync(..., "junction")`），
 * 它同样是指向目录的重解析点，`realpath` 之后同样落在根本之外。
 * 因此在本机实测 `EPERM` 的平台上，用 junction 表达同一个逃逸语义是
 * **真实执行**，不是伪造成功：产品代码走的是同一段 `realpathSync` + `isWithin`。
 *
 * ── 仍然不可用时怎么办 ──
 *
 * 若两种形态都不可用（极端受限的系统），测试必须**显式失败或显式标注**，
 * 绝不能静默通过。本模块只负责如实报告能力，由各测试决定如何处置。
 */

export interface EscapeLinkCapability {
  /** 能构造出真实指向根外的链接（符号链接或 Windows junction）。 */
  available: boolean;
  /** 实际可用的形态；探测失败时为 null。 */
  kind: "symlink-file" | "junction-dir" | null;
  /** 探测过程中的真实失败原因（`EPERM` 等），便于报告；成功时为 null。 */
  unavailableReason: string | null;
}

/**
 * 探测本机能否构造"指向根外"的链接。
 *
 * 每次调用都使用独立的临时目录并在结束时清理，因此不会污染调用方的夹具。
 */
export function probeEscapeLink(): EscapeLinkCapability {
  const insideRoot = mkdtempSync(join(tmpdir(), "cet6-cap-inside-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "cet6-cap-outside-"));
  const reasons: string[] = [];

  try {
    writeFileSync(join(outsideRoot, "probe-target.txt"), "probe", "utf8");

    // 形态 1：文件符号链接（POSIX、以及授予了特权的 Windows）。
    try {
      const link = join(insideRoot, "probe-link.txt");
      symlinkSync(join(outsideRoot, "probe-target.txt"), link, "file");
      const resolved = realpathSync(link);
      if (!resolved.startsWith(realpathSync(insideRoot))) {
        return { available: true, kind: "symlink-file", unavailableReason: null };
      }
      reasons.push("symlink created but did not resolve outside the root");
    } catch (error) {
      reasons.push(`symlink-file: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }

    // 形态 2：Windows 目录 junction（普通用户即可创建，无需特权）。
    try {
      const link = join(insideRoot, "probe-junction");
      symlinkSync(outsideRoot, link, "junction");
      if (!realpathSync(link).startsWith(realpathSync(insideRoot))) {
        return { available: true, kind: "junction-dir", unavailableReason: null };
      }
      reasons.push("junction created but did not resolve outside the root");
    } catch (error) {
      reasons.push(`junction-dir: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }

    return { available: false, kind: null, unavailableReason: reasons.join("; ") };
  } finally {
    rmSync(insideRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

/**
 * 把 `root` 内**指定相对路径**变成一个**真实指向 `outsideRoot`** 的逃逸入口。
 *
 * 关键在于：入口必须落在**产品实际引用的那个相对路径**上。若只在包里
 * 随便放一个链接，而 manifest 引用的是别的路径，那么导入器根本不会碰到它，
 * 于是"端到端拒绝"这条断言会变成空话（本轮修复前正是这种形态）。
 *
 * - 符号链接：直接把该文件路径换成指向 `outsideRoot` 内同名文件的链接。
 * - junction：Windows 上普通用户只能建**目录** junction，因此把该路径的
 *   **父目录**换成指向 `outsideRoot` 的 junction，并在 `outsideRoot` 内
 *   放置同名文件。解析 `assets/handout.pdf` 时仍然落到根外。
 *
 * @returns 产品应当引用、且实际会被拒绝的相对路径（POSIX 风格）。
 */
export function createEscapeLink(
  root: string,
  outsideRoot: string,
  capability: EscapeLinkCapability,
  relativeTarget: string,
): string {
  if (capability.kind === "symlink-file") {
    const segments = relativeTarget.split("/");
    const fileName = segments[segments.length - 1];
    // 目标文件放在根外，与引用路径同名，避免"名字不同也算逃逸"的歧义
    writeFileSync(join(outsideRoot, fileName), "%PDF-1.4 outside the content root\n");
    rmSync(join(root, ...segments), { force: true });
    symlinkSync(join(outsideRoot, fileName), join(root, ...segments), "file");
    return relativeTarget;
  }
  if (capability.kind === "junction-dir") {
    const segments = relativeTarget.split("/");
    const fileName = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);
    writeFileSync(join(outsideRoot, fileName), "%PDF-1.4 outside the content root\n");
    // 用 junction 替换父目录（junction 只能指向目录）
    const parentPath = join(root, ...parentSegments);
    rmSync(parentPath, { recursive: true, force: true });
    symlinkSync(outsideRoot, parentPath, "junction");
    return relativeTarget;
  }
  throw new Error(
    `本机无法构造指向根外的链接（${capability.unavailableReason ?? "unknown"}）。` +
      `调用方必须先检查 probeEscapeLink().available。`,
  );
}

/** 供调用方建目录的便捷包装（仅用于夹具，不做任何断言）。 */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
