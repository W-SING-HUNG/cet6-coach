"use client";

import { useEffect, useRef } from "react";

/**
 * 模态层的键盘焦点管理（**唯一实现**）。
 *
 * ── 为什么需要它 ──
 * 一个带 `aria-modal="true"` 的弹层只声明了"这是模态"，
 * 浏览器**不会**因此限制 Tab 的移动范围。独立评审 F-3 实测：
 * 焦点可以从弹层 Tab 到背后的页面 —— 对键盘用户来说，
 * "模态"是坏的，且读屏会念到被遮住的内容。
 *
 * ── 三件事 ──
 * 1. **打开时**记住原本聚焦的元素，并把焦点移入弹层
 *    （落到 `[data-autofocus]`，否则第一个可聚焦元素）。
 * 2. **Tab / Shift+Tab 在弹层内循环**，出不去。
 * 3. **关闭时**把焦点还给原来的元素 —— 但仅当它仍在文档里
 *    （例如"跳转到未答题"之后，原来的交卷按钮可能已不存在）。
 *
 * ── 为什么不用 modal 框架 ──
 * 项目里只有两个模态（交卷确认、题目导航），且都是受控组件：
 * 需要的只是"焦点不逃逸 + 关闭后归位"。
 * 引入 Radix Dialog 之类会带来一个依赖、一套 portal 与一层样式覆盖，
 * 而收益仅是这两条已经有测试的行为。因此这里抽一个**共用的 hook**，
 * 让两处共用同一份实现（避免"两份都写对"这种脆弱约定）。
 */

/** 弹层内可聚焦元素的选择器。排除 `disabled` 与 `tabindex="-1"`。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      // 排除视觉隐藏元素（`sr-only` 的 radio 之类仍可聚焦，因此只排 display:none / visibility:hidden）
      element.offsetParent !== null || element.getClientRects().length > 0,
  );
}

export interface ModalFocusOptions {
  /** 是否处于打开状态。 */
  open: boolean;
  /** 关闭时的回调（Esc 或外部关闭都会用同一个）。 */
  onClose: () => void;
  /**
   * 是否禁用 Esc 关闭。
   *
   * 交卷弹层在**提交进行中**用它：此刻关闭会让用户以为操作被取消，
   * 而服务端其实正在落库。
   */
  escapeDisabled?: boolean;
  /**
   * 点击遮罩是否关闭。默认 `true`。
   * 题目导航需要它（点空白处关掉）；交卷确认不需要（避免误关）。
   */
  closeOnBackdrop?: boolean;
}

/**
 * 返回要挂在弹层根元素上的 `ref`。
 *
 * 根元素必须同时承载 `role="dialog"` 与 `aria-modal="true"`。
 */
export function useModalFocus({
  open,
  onClose,
  escapeDisabled = false,
  closeOnBackdrop = true,
}: ModalFocusOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 打开前聚焦的元素，关闭时归位。 */
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // 打开：记住来源 + 移入焦点；关闭：归位
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    /*
     * 焦点目标：优先 `[data-autofocus]`（弹层作者指定的主要动作），
     * 否则第一个可聚焦元素。用 `requestAnimationFrame` 等一帧，
     * 因为此刻子元素可能还没完成布局（`offsetParent` 还是 null）。
     */
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const preferred = container.querySelector<HTMLElement>("[data-autofocus]");
      const target = preferred ?? focusableWithin(container)[0] ?? container;
      target.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      // 归位只在元素**仍在文档里**时执行 —— 跳转到未答题后交卷键可能已经消失
      const previous = previouslyFocused.current;
      if (previous && previous.isConnected) previous.focus();
      previouslyFocused.current = null;
    };
  }, [open]);

  // 键盘：Tab 循环 + Esc 关闭
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      const container = containerRef.current;
      if (!container) return;

      if (event.key === "Escape") {
        if (escapeDisabled) return;
        event.preventDefault();
        // 阻止冒泡：外层若有其它 Esc 处理（如阅读器的翻题快捷键）不该被触发
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const items = focusableWithin(container);
      if (items.length === 0) {
        // 没有可聚焦元素时把焦点钉在容器上，避免 Tab 跑到背景
        event.preventDefault();
        container.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        // Shift+Tab 在第一个（或焦点已在容器外）时回到最后一个
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        // Tab 在最后一个（或焦点已在容器外）时回到第一个
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, escapeDisabled]);

  /**
   * 遮罩点击处理。判断"点击落在遮罩本身而不是弹层内容上"，
   * 因此不需要额外包一层。
   */
  function onBackdropClick(event: React.MouseEvent) {
    if (!closeOnBackdrop || escapeDisabled) return;
    if (event.target === event.currentTarget) onClose();
  }

  return { containerRef, onBackdropClick };
}
