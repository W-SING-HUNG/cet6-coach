import type { MetadataRoute } from "next";

/**
 * PWA manifest。
 *
 * 提供合法的 manifest + 图标是 Chrome 放宽后的可安装基础条件。
 * 完整的离线优先缓存不在 Phase 1 范围内，因此不在这里声明相关能力。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CET-6 Coach",
    short_name: "CET-6",
    description: "个人 CET-6 备考教练：诊断、动态计划与训练闭环。",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f7f4ee",
    theme_color: "#f7f4ee",
    lang: "zh-CN",
    dir: "ltr",
    categories: ["education", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "今日计划", short_name: "Today", url: "/today" },
      { name: "复习队列", short_name: "Review", url: "/review" },
    ],
  };
}
