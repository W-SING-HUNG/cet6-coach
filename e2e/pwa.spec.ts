import { test, expect } from "@playwright/test";

/**
 * PWA 基础验证。
 *
 * Phase 1 的要求是"合法 manifest + 可安装基础"，不是完整 offline-first。
 * 因此这里验证的是 manifest 可访问、字段齐全、图标真实可取，
 * 以及移动端不产生 manifest 相关的运行时失败。
 *
 * 明确不声称"已验证可安装"（installability）—— 那需要真实的安装事件断言，
 * 属于后续阶段。当前表述：PWA foundation implemented / installability not fully validated。
 */

test.describe("PWA foundation", () => {
  test("manifest 可访问且必需字段完整", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);

    const manifest = (await response.json()) as Record<string, unknown>;

    expect(manifest.name).toBe("CET-6 Coach");
    expect(manifest.short_name).toBe("CET-6");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#f7f4ee");
    expect(manifest.background_color).toBe("#f7f4ee");
    expect(manifest.lang).toBe("zh-CN");
    expect(Array.isArray(manifest.icons)).toBe(true);
  });

  test("所有声明的图标真实返回 PNG", async ({ request }) => {
    const manifest = (await (await request.get("/manifest.webmanifest")).json()) as {
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };

    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);

    for (const icon of manifest.icons) {
      const response = await request.get(icon.src);
      expect(response.status(), `图标不可访问：${icon.src}`).toBe(200);
      expect(response.headers()["content-type"], `图标类型错误：${icon.src}`).toContain("image/png");
    }
  });

  test("HTML 中声明了 manifest 与 apple-touch-icon", async ({ page }) => {
    await page.goto("/today");
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBe("/manifest.webmanifest");
    // Next 通过 metadata 注入 apple-touch-icon
    const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    expect(appleIcon).toContain("apple-touch-icon");
  });

  test("service worker 文件可取，且不缓存 HTML 导航", async ({ request }) => {
    const response = await request.get("/sw.js");
    expect(response.status()).toBe(200);

    const source = await response.text();
    // 关键约束：静态资源才走缓存，HTML 导航必须绕过 SW 缓存
    expect(source).toContain("isStaticAsset");
    expect(source).not.toMatch(/mode\s*===?\s*["']navigate["']/);
  });
});
