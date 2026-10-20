/**
 * 文本工具。
 *
 * 单独成文件的原因：`CJK` 与 `norm` 被检测层、来源适配器与实体检测同时使用。
 * 放在任一方都会造成循环依赖，而复制三份会让"中文边界"这条判据出现三个版本 ——
 * 那是典型的静默分歧来源。
 */

/** 是否包含中日韩文字（含全角标点）。用于判断翻译正文与中文括注。 */
export const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** 空白归一化：折叠所有空白为单空格并去除首尾。 */
export const norm = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * 拼接文本行。
 *
 * PDF 把长文按行切开，行尾不带空格。英文断行必须补空格
 * （`...give classical` + `music a try`），而中文断行补空格会污染原文
 * （实测 2025-06 翻译 `如今的中式婚礼习俗` 被断行）。
 * 因此按边界字符的语系决定是否插空格 —— 这是**有意的规范化**，已登记在审计模板中。
 */
export function joinTextLines(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (line === "") continue;
    if (out === "") {
      out = line;
      continue;
    }
    const prevChar = out[out.length - 1];
    const nextChar = line[0];
    const needsSpace = !out.endsWith(" ") && !out.endsWith("-") && !CJK.test(prevChar) && !CJK.test(nextChar);
    out = needsSpace ? `${out} ${line}` : `${out}${line}`;
  }
  return out.replace(/[ \t]+/g, " ").trim();
}
