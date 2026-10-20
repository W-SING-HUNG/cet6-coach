import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/nav/app-shell";

export const metadata: Metadata = {
  title: {
    default: "CET-6 Coach",
    template: "%s · CET-6 Coach",
  },
  description: "个人 CET-6 备考教练：诊断、动态计划与训练闭环。",
  applicationName: "CET-6 Coach",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CET-6 Coach",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#f7f4ee",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
