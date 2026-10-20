import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "@/lib/http-range";

/**
 * Range 头解析的三态语义测试。
 *
 * 三态区分的真实后果：`unsatisfiable` 必须映射为 416，
 * 若与 `none` 混为一谈，越界请求会退化为整文件下载（实测踩到）。
 */

const SIZE = 4_906_476;

describe("Range：无头与不可识别 → 整文件", () => {
  it("没有 Range 头", () => {
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: "none" });
  });

  it("空字符串", () => {
    expect(parseRangeHeader("", SIZE)).toEqual({ kind: "none" });
  });

  it("非 bytes 单位（例如 items=0-10）", () => {
    expect(parseRangeHeader("items=0-10", SIZE)).toEqual({ kind: "none" });
  });

  it("语法无法识别时按整文件处理（RFC 9110 允许忽略）", () => {
    for (const header of ["bytes=abc", "bytes=0-abc", "bytes", "bytes=", "bytes=-", "garbage"]) {
      expect(parseRangeHeader(header, SIZE), header).toEqual({ kind: "none" });
    }
  });

  it("多段范围按整文件处理（不支持多段，安全降级）", () => {
    expect(parseRangeHeader("bytes=0-10,20-30", SIZE)).toEqual({ kind: "none" });
  });
});

describe("Range：合法范围 → ok", () => {
  it("前缀范围", () => {
    expect(parseRangeHeader("bytes=0-1023", SIZE)).toEqual({ kind: "ok", start: 0, end: 1023 });
  });

  it("后缀形式 bytes=-N", () => {
    expect(parseRangeHeader("bytes=-512", SIZE)).toEqual({ kind: "ok", start: SIZE - 512, end: SIZE - 1 });
  });

  it("开放式 bytes=N-", () => {
    expect(parseRangeHeader(`bytes=${SIZE - 100}-`, SIZE)).toEqual({ kind: "ok", start: SIZE - 100, end: SIZE - 1 });
  });

  it("终点超出末尾时收敛到最后字节（合法）", () => {
    expect(parseRangeHeader(`bytes=0-${SIZE + 9999}`, SIZE)).toEqual({ kind: "ok", start: 0, end: SIZE - 1 });
  });

  it("单字节范围", () => {
    expect(parseRangeHeader("bytes=100-100", SIZE)).toEqual({ kind: "ok", start: 100, end: 100 });
  });

  it("后缀大于文件大小时返回整个文件", () => {
    expect(parseRangeHeader(`bytes=-${SIZE + 1000}`, SIZE)).toEqual({ kind: "ok", start: 0, end: SIZE - 1 });
  });

  it("空白被容忍", () => {
    expect(parseRangeHeader("  bytes=0-10  ", SIZE)).toEqual({ kind: "ok", start: 0, end: 10 });
  });
});

describe("Range：语法合法但不可满足 → unsatisfiable（必须 416）", () => {
  it("起点等于文件大小", () => {
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("起点远超文件大小（实测踩到的情形）", () => {
    expect(parseRangeHeader("bytes=999999999-9999999999", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("起点大于终点", () => {
    expect(parseRangeHeader("bytes=500-100", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("后缀为 0", () => {
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("空文件的任何范围都不可满足", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-10", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("Range：真实音频大小的端到端取值", () => {
  it("2024-12 第一套音频（4,906,476 字节）的典型播放器请求", () => {
    // 播放器通常会先探头部
    expect(parseRangeHeader("bytes=0-", SIZE)).toEqual({ kind: "ok", start: 0, end: SIZE - 1 });
    // 再请求一小段
    const chunk = parseRangeHeader("bytes=65536-131071", SIZE);
    expect(chunk).toEqual({ kind: "ok", start: 65536, end: 131071 });
    // 拖动到最后
    expect(parseRangeHeader("bytes=-16384", SIZE)).toEqual({ kind: "ok", start: SIZE - 16384, end: SIZE - 1 });
  });
});
