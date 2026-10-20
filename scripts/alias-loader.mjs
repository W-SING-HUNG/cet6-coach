/**
 * Node 侧的 `@/*` 路径别名解析。
 *
 * 用途：让 scripts/*.ts 能以与源码相同的方式导入模块。
 * Node 本身不读 tsconfig 的 paths，而验证脚本又必须复用**完全相同**的
 * service 层代码（否则验证的就不是真实路径），因此这里注册一个解析钩子。
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolvePath(ROOT, "src");

/**
 * 源码使用 bundler 风格的"无扩展名相对导入"（`./schema`），
 * 但 Node ESM 要求显式扩展名。这里补齐 .ts/.tsx 与 index 解析。
 */
function resolveFileLike(base) {
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    resolvePath(base, "index.ts"),
    resolvePath(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const hit = resolveFileLike(resolvePath(SRC, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }

    // 相对导入且无扩展名
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const hit = resolveFileLike(resolvePath(parentDir, specifier));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
});
