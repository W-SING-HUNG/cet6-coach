import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentRootDisplayLabel,
  courseSourcesDirDisplayLabel,
  coursesDirDisplayLabel,
  getContentRoot,
  isWithin,
  normalizeRelativePath,
  papersDirDisplayLabel,
  resolveWithinRoot,
  toDisplayPath,
  UnsafePathError,
} from "@/content/paper/paths";
import { isScannableText, listScannableFiles } from "../tests/support/paper-fingerprints";

/**
 * 路径边界测试。
 *
 * 这是产品里唯一一处「外部数据决定读本机哪个文件」的地方，
 * 因此它的边界必须被穷举式地钉住，而不是靠"看起来写了 .. 检查"。
 * 威胁模型与检查项对应 Snyk 的 Zip Slip 分类与 Python tarfile 的 data filter。
 */

function withRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cet6-paths-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("normalizeRelativePath：词法层拒绝", () => {
  it("接受合法的相对 POSIX 路径", () => {
    expect(normalizeRelativePath("assets/listening.mp3")).toBe("assets/listening.mp3");
    expect(normalizeRelativePath("paper.json")).toBe("paper.json");
    expect(normalizeRelativePath("a/b/c/d.png")).toBe("a/b/c/d.png");
  });

  it("把反斜杠视为分隔符并规范化（Windows 包作者常见写法）", () => {
    expect(normalizeRelativePath("assets\\listening.mp3")).toBe("assets/listening.mp3");
    expect(normalizeRelativePath("assets\\sub\\a.wav")).toBe("assets/sub/a.wav");
  });

  it("拒绝单点段（含反斜杠写法的 . 段）", () => {
    // `.\assets\a.wav` 归一化后含 `.` 段 —— 与 `./a.mp3` 同等对待，一律拒绝
    expect(() => normalizeRelativePath(".\\assets\\a.wav")).toThrow(UnsafePathError);
  });

  it("拒绝 .. 上跳（含各种位置）", () => {
    for (const input of [
      "../etc/passwd",
      "assets/../../etc/passwd",
      "assets/..",
      "..",
      "a/../b",
      "..\\..\\windows\\system32",
    ]) {
      expect(() => normalizeRelativePath(input), input).toThrow(UnsafePathError);
    }
  });

  it("拒绝绝对路径与盘符路径", () => {
    for (const input of ["/etc/passwd", "/", "C:/Windows/system32", "c:\\windows\\win.ini", "//server/share/x"]) {
      expect(() => normalizeRelativePath(input), input).toThrow(UnsafePathError);
    }
  });

  it("拒绝空字节与空路径", () => {
    expect(() => normalizeRelativePath("a\0b")).toThrow(UnsafePathError);
    expect(() => normalizeRelativePath("")).toThrow(UnsafePathError);
    expect(() => normalizeRelativePath("   ")).toThrow(UnsafePathError);
  });

  it("拒绝单点段（避免 alias 到别处的歧义路径）", () => {
    expect(() => normalizeRelativePath("./a.mp3")).toThrow(UnsafePathError);
    expect(() => normalizeRelativePath("a/./b.mp3")).toThrow(UnsafePathError);
  });
});

describe("isWithin", () => {
  it("根自身视为在内", () => {
    expect(isWithin("C:/root", "C:/root")).toBe(true);
  });

  it("子路径在内，兄弟目录与父目录在外", () => {
    expect(isWithin("C:/root", "C:/root/a/b")).toBe(true);
    expect(isWithin("C:/root", "C:/rootx")).toBe(false);
    expect(isWithin("C:/root", "C:/other")).toBe(false);
    expect(isWithin("C:/root/sub", "C:/root")).toBe(false);
  });
});

describe("resolveWithinRoot：真实路径层", () => {
  it("解析存在的文件并给出根内相对路径", () => {
    const { root, cleanup } = withRoot();
    try {
      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(join(root, "assets", "a.mp3"), "x");

      const resolved = resolveWithinRoot(root, "assets/a.mp3");
      expect(resolved.relativePath).toBe("assets/a.mp3");
      expect(resolved.absolutePath.endsWith("a.mp3")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("目标不存在时按 mustExist 决定：默认抛错，显式允许时返回路径", () => {
    const { root, cleanup } = withRoot();
    try {
      expect(() => resolveWithinRoot(root, "missing.mp3")).toThrow(UnsafePathError);
      const resolved = resolveWithinRoot(root, "missing.mp3", { mustExist: false });
      expect(resolved.relativePath).toBe("missing.mp3");
    } finally {
      cleanup();
    }
  });

  it("拒绝词法逃逸（未接触文件系统即拦下）", () => {
    const { root, cleanup } = withRoot();
    try {
      expect(() => resolveWithinRoot(root, "../../secret.txt", { mustExist: false })).toThrow(UnsafePathError);
    } finally {
      cleanup();
    }
  });

  it("拒绝指向根外的符号链接（词法检查无法覆盖的逃逸）", () => {
    const { root, cleanup } = withRoot();
    const outside = mkdtempSync(join(tmpdir(), "cet6-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "classified");
      // 在根内创建一个指向根外的软链接：路径本身完全合法
      try {
        symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"), "file");
      } catch {
        // 某些环境不允许创建符号链接（需要特权）；跳过而不是误判为通过
        return;
      }
      expect(() => resolveWithinRoot(root, "link.txt")).toThrow(UnsafePathError);
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("拒绝指向根外的目录软链接下的文件", () => {
    const { root, cleanup } = withRoot();
    const outside = mkdtempSync(join(tmpdir(), "cet6-outside-dir-"));
    try {
      writeFileSync(join(outside, "payload.mp3"), "x");
      try {
        symlinkSync(outside, join(root, "linkdir"), "dir");
      } catch {
        return;
      }
      expect(() => resolveWithinRoot(root, "linkdir/payload.mp3")).toThrow(UnsafePathError);
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("错误信息包含原始输入，便于定位是哪个包写坏了", () => {
    try {
      normalizeRelativePath("../../etc/passwd");
      expect.unreachable("应该抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafePathError);
      expect((error as Error).message).toContain("../../etc/passwd");
    }
  });
});

// ---------------------------------------------------------------------------
// 展示用路径投影（display projection）
//
// ── 这组测试守的是独立评审 F-2 ──
//
// 曾经的缺陷：真题库空状态把 `library.papersDir`（**本机绝对路径**）直接渲染进
// HTML。绝对路径是服务端读盘的输入，不是界面的输出。修法不是"记得要消毒"，
// 而是让页面**根本拿不到**绝对路径 —— 它只能拿到投影出来的标签。
//
// 因此这里的判据不是"sanitize 之后不含路径"，而是更强的两条：
//   1. 投影结果在任何配置下都是**固定的产品级字符串**；
//   2. 即使把内容根指到一个极端的自定义位置，投影也不含它的任何成分。
// ---------------------------------------------------------------------------

describe("展示用路径投影：任何配置下都不含本机布局", () => {
  const original = process.env.CET6_CONTENT_ROOT;

  function withContentRoot(value: string | undefined, fn: () => void): void {
    if (value === undefined) delete process.env.CET6_CONTENT_ROOT;
    else process.env.CET6_CONTENT_ROOT = value;
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env.CET6_CONTENT_ROOT;
      else process.env.CET6_CONTENT_ROOT = original;
    }
  }

  /**
   * 合成内容根，覆盖 Windows / POSIX / UNC / 用户配置目录四种形态。
   *
   * ── 为什么这些用例曾经在 Linux 上失败 ──
   *
   * 它们把 Windows 字面量（`D:\…`、`\\host\share\…`）直接当作**绝对路径**
   * 传给 `toDisplayPath`。这在 Windows 上成立，在 POSIX 上不成立：
   * `path.posix.isAbsolute("D:\\…")` 是 `false`，于是产品把内容根当成
   * **相对路径**解析，`relative()` 必然返回 `..` 前缀，结果只剩占位名。
   *
   * 这不是产品的跨平台缺陷 —— `toDisplayPath` 的输入契约就是"**本平台**的
   * 绝对路径"，服务端也只会读到本平台的路径。错的是测试把 Windows 的字面量
   * 当成了跨平台输入。
   *
   * ── 修法：用产品自己解析出的根来构造目标路径 ──
   *
   * `contentRootFor(raw)` 返回 `getContentRoot()` 在设置该值之后**实际**得到的
   * 根（Windows 上就是原文；POSIX 上会被 `resolve` 到 cwd 之下）。
   * 目标路径由这个根 join 出来，因此在**两种平台**上都是本平台的绝对路径，
   * 而断言的不变量完全不变：投影结果只能是 `private-content` + 相对子路径，
   * 不得含内容根的任何一个成分。
   *
   * 这样也顺带覆盖了一个更真实的形态：内容根**不存在**时
   * （`realpathSync` 抛错）投影仍然必须成立。
   */
  const SYNTHETIC_ROOTS = [
    "D:\\synthetic-user\\synthetic-study\\cet6-content",
    "/home/synthetic-user/synthetic-study/cet6-content",
    "\\\\synthetic-nas\\synthetic-share\\cet6-content",
    "C:\\Users\\synthetic\\AppData\\Local\\cet6-content",
  ];

  /**
   * 设置内容根之后，产品**实际**使用的根（与 `getContentRoot()` 同源）。
   *
   * 注意：这里**不能**复用 `withContentRoot` —— 它在结束时恢复的是
   * **模块加载时**捕获的 `original`，若在外层 `withContentRoot` 内部调用，
   * 会把外层刚设好的值一起冲掉。因此这里保存/恢复的是**当次**的值。
   */
  function contentRootFor(raw: string): string {
    const saved = process.env.CET6_CONTENT_ROOT;
    process.env.CET6_CONTENT_ROOT = raw;
    try {
      return getContentRoot();
    } finally {
      if (saved === undefined) delete process.env.CET6_CONTENT_ROOT;
      else process.env.CET6_CONTENT_ROOT = saved;
    }
  }

  /** 在给定内容根下构造一个本平台的绝对子路径（POSIX 风格的分段）。 */
  function insideRoot(raw: string, ...segments: string[]): string {
    return join(contentRootFor(raw), ...segments);
  }

  it("标签是固定产品字符串，与内容根无关", () => {
    for (const root of SYNTHETIC_ROOTS) {
      withContentRoot(root, () => {
        expect(contentRootDisplayLabel()).toBe("private-content");
        expect(papersDirDisplayLabel()).toBe("private-content/cet6/papers");
        expect(coursesDirDisplayLabel()).toBe("private-content/courses");
        expect(courseSourcesDirDisplayLabel()).toBe("private-content/course-sources");
      });
    }
  });

  it("标签不含盘符、用户名、UNC 前缀或任何分隔符之外的成分", () => {
    for (const root of SYNTHETIC_ROOTS) {
      withContentRoot(root, () => {
        for (const label of [
          contentRootDisplayLabel(),
          papersDirDisplayLabel(),
          coursesDirDisplayLabel(),
          courseSourcesDirDisplayLabel(),
        ]) {
          expect(label, label).not.toMatch(/[A-Za-z]:\\/); // 盘符
          expect(label, label).not.toMatch(/^\\\\/); // UNC
          expect(label, label).not.toMatch(/^\/[^s]/); // POSIX 绝对（/synthetic…）
          expect(label, label).not.toContain("synthetic-user");
          expect(label, label).not.toContain("synthetic-study");
          expect(label, label).not.toContain("AppData");
        }
      });
    }
  });

  it("未设置 CET6_CONTENT_ROOT 时同样只给占位名", () => {
    withContentRoot(undefined, () => {
      expect(contentRootDisplayLabel()).toBe("private-content");
      expect(papersDirDisplayLabel()).toBe("private-content/cet6/papers");
    });
  });

  it("toDisplayPath 把内容根内的绝对路径折成占位名 + 相对子路径", () => {
    const root = "D:\\synthetic-user\\synthetic-study\\cet6-content";
    withContentRoot(root, () => {
      // 用产品自己解析出的根构造目标，因此两种平台上都是本平台的绝对路径
      const shown = toDisplayPath(insideRoot(root, "cet6", "papers", "pkg-a"));
      expect(shown).toBe("private-content/cet6/papers/pkg-a");
      expect(shown).not.toContain("synthetic");
    });
  });

  it("toDisplayPath 对内容根之外的路径只给占位名（失败关闭方向）", () => {
    withContentRoot("D:\\synthetic-user\\synthetic-study\\cet6-content", () => {
      // 根外：宁可少给信息，也不要把盘符/用户名送出去
      expect(toDisplayPath("D:\\synthetic-user\\Documents\\secret.txt")).toBe("private-content");
      expect(toDisplayPath("C:\\Windows\\system32\\win.ini")).toBe("private-content");
      expect(toDisplayPath("/etc/passwd")).toBe("private-content");
    });
  });

  it("toDisplayPath 对内容根本身给占位名", () => {
    withContentRoot("D:\\synthetic-user\\synthetic-study\\cet6-content", () => {
      expect(toDisplayPath("D:\\synthetic-user\\synthetic-study\\cet6-content")).toBe("private-content");
    });
  });

  it("POSIX 与 UNC 内容根同样被折掉", () => {
    const posixRoot = "/home/synthetic-user/cet6-content";
    withContentRoot(posixRoot, () => {
      expect(toDisplayPath(insideRoot(posixRoot, "courses", "x"))).toBe("private-content/courses/x");
    });
    const uncRoot = "\\\\synthetic-nas\\share\\cet6-content";
    withContentRoot(uncRoot, () => {
      expect(toDisplayPath(insideRoot(uncRoot, "cet6", "papers", "p"))).toBe("private-content/cet6/papers/p");
    });
  });

  it("不存在的路径也安全投影（不抛错、不含输入）", () => {
    const root = "D:\\synthetic-user\\synthetic-study\\cet6-content";
    withContentRoot(root, () => {
      // 目标与内容根在磁盘上都不存在：realpath 两侧都会抛，投影仍须成立
      const shown = toDisplayPath(insideRoot(root, "nope", "missing.json"));
      expect(shown).toBe("private-content/nope/missing.json");
      expect(shown).not.toContain("synthetic");
    });
  });
});

// ---------------------------------------------------------------------------
// 文本/二进制判定（finding F-4）
//
// ── 这组测试守的是什么 ──
//
// 曾经的缺陷：两道扫描各自带一份**闭集**扩展名白名单，于是 `.bak`、
// `.markdown`、`.orig` 这些"没人想到的扩展名"对所有扫描器都不可见 ——
// 而选扩展名的是引入材料的人，不是扫描器。
//
// 修法把判据收敛成一处（`isScannableText`）并改成"deny-by-default +
// 内容探测"：已知二进制 ⇒ 不扫；已知文本 ⇒ 扫；未知扩展名 ⇒ 读头部，
// 只有能干净解码成 UTF-8 且不含 NUL 才扫。
//
// 因此这里的判据不是"白名单里有哪些"，而是三件事：
//   1. 未知扩展名的**文本**文件必须被扫（这是修掉的那个洞）；
//   2. 已知二进制必须不被扫（否则扫描器会去读图片字节）；
//   3. 伪装成文本的二进制（含 NUL）必须不被扫。
// ---------------------------------------------------------------------------

describe("isScannableText：未知扩展名不再构成盲区", () => {
  /** 一段合成文本（不是任何真实材料）。 */
  const TEXT_HEAD = Buffer.from("a synthetic control phrase for the scanner\nmore synthetic lines\n", "utf8");
  /** 一个二进制头部：PNG 魔数 + NUL 字节。 */
  const BINARY_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

  it("已知文本扩展名被扫（不需要内容探测）", () => {
    for (const name of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.json", "a.md", "a.css", "a.yml", "a.txt", "a.svg"]) {
      expect(isScannableText(name), name).toBe(true);
    }
  });

  it("已知二进制扩展名不被扫（即使内容是文本）", () => {
    for (const name of ["a.png", "a.jpg", "a.pdf", "a.mp3", "a.zip", "a.woff2", "a.db", "a.wasm"]) {
      expect(isScannableText(name, () => TEXT_HEAD), name).toBe(false);
    }
  });

  it("未知扩展名的文本文件被扫（F-4 修掉的洞）", () => {
    // 这三个形态在修好之前对所有扫描器都不可见。
    for (const name of ["leak.md.bak", "note.markdown", "orig.ts.orig"]) {
      expect(isScannableText(name, () => TEXT_HEAD), name).toBe(true);
    }
  });

  it("未知扩展名但内容是二进制 ⇒ 不被扫", () => {
    expect(isScannableText("mystery.bin", () => BINARY_HEAD)).toBe(false);
    expect(isScannableText("mystery.dat", () => BINARY_HEAD)).toBe(false);
  });

  it("含 NUL 的'文本'不被扫（NUL 是 cheapest reliable binary signal）", () => {
    const withNul = Buffer.concat([TEXT_HEAD, Buffer.from([0x00])]);
    expect(isScannableText("mystery.xyz", () => withNul)).toBe(false);
  });

  it("空文件与读不动的文件不被扫（不猜）", () => {
    expect(isScannableText("mystery.xyz", () => Buffer.alloc(0))).toBe(false);
    expect(isScannableText("mystery.xyz", () => { throw new Error("EACCES"); })).toBe(false);
    // 没有提供 readHead 时对未知扩展名保守判否（调用方可以不探测）
    expect(isScannableText("mystery.xyz")).toBe(false);
  });

  it("非 UTF-8 字节序列不被扫", () => {
    // 0xFF 0xFE 单独出现不是合法 UTF-8 序列
    expect(isScannableText("mystery.xyz", () => Buffer.from([0xff, 0xfe, 0xff, 0xfe]))).toBe(false);
  });

  it("大小写不影响判定", () => {
    expect(isScannableText("A.PNG", () => TEXT_HEAD)).toBe(false);
    expect(isScannableText("A.TS")).toBe(true);
  });

  it("listScannableFiles 覆盖未知扩展名的文本文件，且跳过二进制", () => {
    const base = mkdtempSync(join(tmpdir(), "cet6-scan-"));
    try {
      mkdirSync(join(base, "d"), { recursive: true });
      writeFileSync(join(base, "d", "note.md"), "synthetic text\n");
      writeFileSync(join(base, "d", "note.md.bak"), "synthetic text\n");
      writeFileSync(join(base, "d", "note.markdown"), "synthetic text\n");
      writeFileSync(join(base, "d", "blob.png"), "not really a png");
      const scanned = listScannableFiles(base);
      expect(scanned, scanned.join(",")).toContain("d/note.md");
      expect(scanned, scanned.join(",")).toContain("d/note.md.bak");
      expect(scanned, scanned.join(",")).toContain("d/note.markdown");
      expect(scanned, scanned.join(",")).not.toContain("d/blob.png");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
