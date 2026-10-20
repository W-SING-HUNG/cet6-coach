// @vitest-environment node
/**
 * A3 恢复 · 完整性判据单元测试。
 *
 * ── 这个文件守的核心判据 ──
 *
 * "内容快照完好"必须是**逐文件 sha256** 的事实，而不是总字节数。
 * 两个文件互换内容、或一个文件被**同尺寸**替换，总字节数完全不变 ——
 * 只有逐文件校验和能发现。
 *
 * ── 为什么单独成文件（而不是并入 controlled-import）──
 *
 * 它是恢复路径的第一道判据，而恢复是**不可逆**操作。把它的用例与
 * 导入用例混在一起会让"哪一条断言在守恢复"变得难以定位；
 * 独立成文件后，变异证明（M10）可以精确指向它。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_MANIFEST_FILENAME,
  inspectBackup,
  readContentManifest,
  verifyContentBackup,
  writeContentManifest,
} from "@/services/course-recovery";
import { createContentBackup } from "@/services/course-backup";

const roots: string[] = [];
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `a3-recovery-${tag}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造一份"课程目录"，返回其根。 */
function seedCourses(root: string): string {
  const courses = join(root, "courses");
  mkdirSync(join(courses, "course-a", "assets"), { recursive: true });
  mkdirSync(join(courses, "course-b", "assets"), { recursive: true });
  writeFileSync(join(courses, "course-a", "course.json"), '{"id":"course-a"}');
  writeFileSync(join(courses, "course-a", "assets", "a.pdf"), "AAAA");
  writeFileSync(join(courses, "course-b", "course.json"), '{"id":"course-b"}');
  writeFileSync(join(courses, "course-b", "assets", "b.pdf"), "BBBB");
  return courses;
}

describe("A3 恢复 · 内容快照完整性", () => {
  it("清单逐文件记录相对路径、字节数与 sha256，且不含绝对路径", () => {
    const root = makeRoot("manifest");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    expect(snap.ok).toBe(true);

    const manifest = writeContentManifest(snap.backupPath!);
    expect(manifest.fileCount).toBe(4);
    expect(manifest.entries.length).toBe(4);

    for (const entry of manifest.entries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
      // 相对路径：不得是绝对路径、不得含盘符、不得含上跳
      expect(entry.relativePath.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:/.test(entry.relativePath)).toBe(false);
      expect(entry.relativePath.includes("..")).toBe(false);
    }
    // 清单本身不得包含绝对路径（它会随备份一起留在盘上）
    const raw = readFileSync(join(snap.backupPath!, CONTENT_MANIFEST_FILENAME), "utf8");
    expect(/[A-Za-z]:\\/.test(raw), "清单不得含盘符绝对路径").toBe(false);
  });

  it("完好的快照通过校验", () => {
    const root = makeRoot("clean");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    if (snap.backupPath !== null) writeContentManifest(snap.backupPath);

    const verification = verifyContentBackup(snap.backupPath!);
    expect(verification.ok, verification.error ?? "").toBe(true);
    expect(verification.missing).toEqual([]);
    expect(verification.checksumMismatch).toEqual([]);
    expect(verification.unexpected).toEqual([]);
  });

  it("**同尺寸篡改**必须被发现（总字节数判据抓不住它）", () => {
    const root = makeRoot("same-size");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    if (snap.backupPath !== null) writeContentManifest(snap.backupPath);

    const before = verifyContentBackup(snap.backupPath!);
    expect(before.ok).toBe(true);
    const totalBefore = before.totalBytes;

    // 同尺寸替换：改一个字节，长度不变
    const target = join(snap.backupPath!, "course-a", "assets", "a.pdf");
    const original = readFileSync(target);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] ^ 0xff;
    writeFileSync(target, tampered);

    const after = verifyContentBackup(snap.backupPath!);
    expect(after.totalBytes, "总字节数确实没变（这正是判据必须更细的原因）").toBe(totalBefore);
    expect(after.ok, "同尺寸篡改必须被校验和发现").toBe(false);
    expect(after.checksumMismatch).toContain("course-a/assets/a.pdf");
    expect(after.sizeMismatch).toEqual([]);
  });

  it("两个文件**互换内容**必须被发现", () => {
    const root = makeRoot("swap");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    if (snap.backupPath !== null) writeContentManifest(snap.backupPath);

    const a = join(snap.backupPath!, "course-a", "assets", "a.pdf");
    const b = join(snap.backupPath!, "course-b", "assets", "b.pdf");
    const aBytes = readFileSync(a);
    const bBytes = readFileSync(b);
    // 两者都是 4 字节 ⇒ 互换后总字节数完全不变
    writeFileSync(a, bBytes);
    writeFileSync(b, aBytes);

    const after = verifyContentBackup(snap.backupPath!);
    expect(after.ok, "内容互换必须被发现").toBe(false);
    expect(after.checksumMismatch.length).toBe(2);
  });

  it("缺失文件与多余文件都被精确列出", () => {
    const root = makeRoot("missing-extra");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    if (snap.backupPath !== null) writeContentManifest(snap.backupPath);

    rmSync(join(snap.backupPath!, "course-b", "course.json"));
    writeFileSync(join(snap.backupPath!, "stray.txt"), "not in manifest");

    const after = verifyContentBackup(snap.backupPath!);
    expect(after.ok).toBe(false);
    expect(after.missing).toContain("course-b/course.json");
    expect(after.unexpected).toContain("stray.txt");
  });

  it("缺清单的快照**不**被当作可执行的恢复点", () => {
    const root = makeRoot("no-manifest");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    expect(snap.ok).toBe(true);
    // 刻意不写清单

    const verification = verifyContentBackup(snap.backupPath!);
    expect(verification.ok).toBe(false);
    expect(verification.manifestReadable).toBe(false);

    const inspection = inspectBackup(backupDir);
    expect(inspection.usable, "没有完整性清单 ⇒ 不是恢复点").toBe(false);
  });

  it("清单格式不受支持时失败关闭", () => {
    const root = makeRoot("bad-manifest");
    const courses = seedCourses(root);
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    const snap = createContentBackup(courses, join(backupDir, "courses-pre-a3"));
    writeFileSync(join(snap.backupPath!, CONTENT_MANIFEST_FILENAME), '{"manifestVersion":99}');

    const read = readContentManifest(snap.backupPath!);
    expect(read.ok).toBe(false);
    expect(read.error).toContain("不受支持");
    expect(verifyContentBackup(snap.backupPath!).ok).toBe(false);
  });

  it("清单聚合摘要是确定性的（同内容 ⇒ 同摘要）", () => {
    const root = makeRoot("deterministic");
    const courses = seedCourses(root);
    const first = join(root, "b1", "courses-pre-a3");
    const second = join(root, "b2", "courses-pre-a3");
    mkdirSync(join(root, "b1"), { recursive: true });
    mkdirSync(join(root, "b2"), { recursive: true });
    createContentBackup(courses, first);
    createContentBackup(courses, second);

    const m1 = writeContentManifest(first);
    const m2 = writeContentManifest(second);
    expect(m1.digest).toBe(m2.digest);
    expect(m1.fileCount).toBe(m2.fileCount);
  });
});
