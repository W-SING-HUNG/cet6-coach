import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { getRepositories } from "@/repositories/sqlite";
import { createPaperCatalog } from "@/content/paper";
import { parseRangeHeader } from "@/lib/http-range";

export const dynamic = "force-dynamic";

/**
 * 私有内容资产的服务端点 —— 唯一的媒体读取出口。
 *
 * 为什么需要它：试卷包里的音频位于 `private-content/`，**刻意不在 public/ 内**，
 * 因此 Next.js 的静态服务不会（也不应该）暴露它。要证明"真实音频能被产品消费"，
 * 就必须有一条受控的读取路径。
 *
 * 这条路由的安全性是全应用最敏感的一处，因此约束写在这里：
 *
 * 1. **不接受路径**。客户端只能给 `paperId` 与 `assetId`，两个都是**索引中的标识**。
 *    路径由服务端从索引查出后，再经 `resolveWithinRoot` 的两级防线解析。
 *    客户端无法用它去读任意文件 —— 它只能请求"已索引、且类型为 audio/image"的资产。
 * 2. **类型白名单**。即便索引被污染，非 audio/image 的 MIME 一律 404。
 * 3. **越界即 404**。符号链接逃逸、`..`、绝对路径全部在解析层被拒。
 * 4. **支持 Range**，因为音频播放器需要拖动进度；不返回整个文件也能正常播放。
 */

/**
 * Range 解析见 `@/lib/http-range`。
 *
 * 那里区分三态（none / unsatisfiable / ok）是必需的：
 * 早先把"语法非法"与"范围越界"合并成一个 null，导致越界请求静默退化为整文件下载
 * （实测：`bytes=999999999-` 返回 200 而非 416）。
 */

function notFound(): Response {
  return new Response("资产不存在", { status: 404 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ paperId: string; assetId: string }> },
) {
  const { paperId, assetId } = await params;

  // 只允许来自索引的安全标识字符集，避免把奇怪输入带进解析层
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(paperId) || !/^[a-z0-9][a-z0-9._-]*$/i.test(assetId)) {
    return notFound();
  }

  const catalog = createPaperCatalog(getRepositories());
  const resolved = catalog.resolveAssetPath(paperId, assetId);
  if (!resolved) return notFound();

  let size: number;
  try {
    size = statSync(resolved.absolutePath).size;
  } catch {
    return notFound();
  }

  const baseHeaders: Record<string, string> = {
    "Content-Type": resolved.mimeType,
    // 私有内容不进 CDN、不被共享缓存；同时便于排查"包换过没有"
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${resolved.checksum.slice(0, 32)}"`,
  };

  // 条件请求：内容没变就不重传
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.replace(/^W\//, "") === baseHeaders.ETag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const range = parseRangeHeader(request.headers.get("range"), size);

  if (range.kind === "unsatisfiable") {
    return new Response("请求的字节范围超出文件大小", {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (range.kind === "ok") {
    const { start, end } = range;
    const stream = createReadStream(resolved.absolutePath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = createReadStream(resolved.absolutePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

/** 只允许读取，明确拒绝其它方法（避免误以为是可变资源）。 */
export async function POST() {
  return new Response("只读端点", { status: 405, headers: { Allow: "GET" } });
}
