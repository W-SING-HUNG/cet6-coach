/**
 * HTTP Range 头解析。
 *
 * 为什么单独成模块：这是唯一一处需要**区分三态**的逻辑，而三态的区分有真实后果 ——
 * - `none`：没有 Range 头，或语法无法识别 → 返回整文件（RFC 9110 §14.2 允许忽略）。
 * - `unsatisfiable`：语法合法但范围超出文件 → 必须返回 **416**。
 * - `ok`：返回 206 + Content-Range。
 *
 * 把 `none` 与 `unsatisfiable` 合并成一个 null 会造成真实缺陷：
 * 客户端请求一个越界范围（例如文件被换小后播放器仍按旧长度请求）时，
 * 服务器会静默退化为**整文件下载** —— 用户只想拿一小段，却拉走整个音频。
 * 已实测踩到该问题（越界 Range 返回 200 而非 416）。
 *
 * 只支持单段 `bytes=`。多段请求按 `none` 处理（返回整文件），这是合法且安全的降级。
 */

export type RangeResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "ok"; start: number; end: number };

export function parseRangeHeader(header: string | null, size: number): RangeResult {
  if (!header) return { kind: "none" };

  // 多段范围（含逗号）不在支持范围内 → 按整文件处理
  if (header.includes(",")) return { kind: "none" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };

  const [, rawStart, rawEnd] = match;

  // `bytes=-` 两头都空，语法无意义 → 整文件
  if (rawStart === "" && rawEnd === "") return { kind: "none" };

  if (rawStart === "") {
    // `bytes=-N`：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix)) return { kind: "none" };
    if (suffix <= 0) return { kind: "unsatisfiable" };
    return { kind: "ok", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start)) return { kind: "none" };

  let end: number;
  if (rawEnd === "") {
    end = size - 1;
  } else {
    end = Number(rawEnd);
    if (!Number.isFinite(end)) return { kind: "none" };
  }

  if (start >= size || start > end) return { kind: "unsatisfiable" };
  return { kind: "ok", start, end: Math.min(end, size - 1) };
}
