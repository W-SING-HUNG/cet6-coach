/**
 * 逻辑材料分组（file ≠ logical material）。
 *
 * ── 这条规则来自 Foundation，必须原样保住 ──
 *
 * 同一份讲义常同时存在 PDF 与 DOCX 两个文件。若把"文件"当"材料"，
 * 同一份讲义就会变成两条课程材料 —— 学习者会在界面上看见两次、被统计两次。
 * 因此 Foundation 在**模型层**就把这件事消除掉了：文件是**表示**，材料是**逻辑内容**。
 *
 * 本模块的职责是把"文件清单"变成"候选材料清单"，并把**分组的依据与歧义**完整暴露出来。
 *
 * ── 这是整条流水线里最容易静默出错的一步 ──
 *
 * 因此它遵守两条硬规则：
 *
 * 1. **一个文件不得变成两份逻辑材料，一份材料也不得吞掉无关文件。**
 *    后者由函数末尾的**不变量核对**强制：每个资产键恰好出现在一份提案里。
 *    违反即上报 `invariantViolations`（那是流水线缺陷，不是数据问题）。
 * 2. **歧义必须可见，且必须 review-required。** 绝不"挑一个看起来最像的"。
 *
 * ── 分组判据（全部是可核对的字段）──
 *
 * - 归一化 stem 相同（`handout.pdf` + `handout.docx`）
 * - 文件夹上下文相同（**不同目录的同类文件不合并**）
 * - 资产种类互补且是"文档的两种导出形态"（pdf + docx）
 *
 * ── 明确不使用的判据 ──
 *
 * - 文件名相似度（`第1套听力` 与 `第1套阅读` 很像，但是两份材料）
 * - 文件大小
 * - 修改时间
 * - 任何跨目录的模糊匹配
 *
 * ── 关于 DOCX ──
 *
 * DOCX **在 V1 不被解析**。因此"PDF 与 DOCX 是同一份内容"这件事
 * **不是**被验证过的 —— 它只是一个**提案**，且必须由人确认
 * （`contentComparable: false` → `reviewRequired: true`）。
 * 绝不可以因为"名字一样"就把它当成已验证的等价。
 */

import { createHash } from "node:crypto";
import { shingles, containment, hasEnoughSubstance } from "./projection";
import { normalizeStem } from "./sources";
import type { SourceAsset, SourceAssetKind, CourseModuleHint } from "./types";
import type { MaterialGroupingProposal, MaterialGroupingResult, ProposedRepresentation } from "./types";

/**
 * 提案 id：确定性推导（同一输入重复运行得到同一个值）。
 *
 * slug 必须是**纯 ASCII**：它会成为 `course.json` 里的 `materials[].id`
 * 与 `segments[].materialId`，而生产校验器要求 `^[a-z0-9][a-z0-9._-]*$`。
 * 真实课程材料多为中文名，因此中文一律落到哈希后缀上，可读性由 `title` 承担。
 */
function proposalIdOf(normalizedStem: string, folderContext: string | null, assetKeys: string[]): string {
  const canonical = `${normalizedStem}\u0000${folderContext ?? ""}\u0000${[...assetKeys].sort().join(",")}`;
  const slug = normalizedStem
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
  return `${slug === "" ? "material" : slug}-${hash}`;
}

/** 表示标签：人可读，说明这是同一份内容的哪种形态。 */
function representationLabel(asset: SourceAsset): string {
  switch (asset.kind) {
    case "pdf":
      return "PDF 版";
    case "docx":
      return "DOCX 版（本版本不解析文本）";
    case "audio":
      return "音频（整段，不切分）";
    case "image":
      return "图片";
    default:
      return `其他（${asset.extension || "无扩展名"}）`;
  }
}

/**
 * 哪些种类**可以**成为同一份逻辑材料的不同表示。
 *
 * ── 为什么 PDF 与 DOCX 可以，而音频要单独处理 ──
 *
 * PDF 与 DOCX 是"同一份讲义的两个导出"，按 stem 就能可靠识别。
 *
 * 听力材料的情况不同：它的三个文件**名字通常各不相同**
 * （`question-handout.pdf` / `transcript-analysis.pdf` / `listening-full.mp3`），
 * 因此按 stem 分组**永远合不到一起**。但它们确实是一份逻辑材料 ——
 * 课程层的听觉段必须引用**整段音频**（生产校验器对此是硬要求），
 * 所以音频必须与该材料的文档表示归属同一份材料。
 *
 * 处置：**音频单独走"同目录唯一音频"这条提案路径**（见 `attachFolderAudio`），
 * 而不是靠 stem 合并。那条路径是**歧义的、必须人工复核的** ——
 * "这个目录里唯一的音频就是这份讲义的配套音频"是合理猜测，不是已验证事实。
 */
const REPRESENTATION_COMPATIBLE_KINDS: SourceAssetKind[] = ["pdf", "docx"];

/** 文件夹标签属于听力模块时，该目录里的音频才可能被提案为配套音频。 */
function isListeningFolder(label: string | null): boolean {
  if (label === null) return false;
  return /(听力|听|listening|listen)/i.test(label);
}

export interface GroupMaterialsInput {
  assets: SourceAsset[];
  /**
   * 已解析文档的正文（assetKey → 段落文本）。
   *
   * 只有 PDF 会有条目。它让"PDF 与 DOCX 是否内容相同"这个问题
   * **在只有一侧可解析时**被如实回答为"无法比对"，
   * 而不是被假定为相同。
   */
  parsedText?: Map<string, string>;
}

/**
 * 把清点出的资产分组为候选逻辑材料。
 *
 * 分组键 = (归一化 stem, 文件夹上下文)。**两个条件都相同才合并。**
 */
export function proposeMaterialGroupings(input: GroupMaterialsInput): MaterialGroupingResult {
  const { assets } = input;
  const parsedText = input.parsedText ?? new Map<string, string>();
  const warnings: string[] = [];

  // ── 1) 按 (归一化 stem, 文件夹上下文, 种类族) 分桶 ──
  //
  // 种类族参与分桶的原因：同一目录下可能同时有 `unit1.pdf`（讲义）
  // 与 `unit1.mp3`（音频）。它们 stem 相同、目录相同，但**不是**同一份逻辑材料 ——
  // 一个是阅读讲义，一个是听力音频。若按 stem 合并，听力材料就会变成
  // "一份同时是讲义又是音频的材料"，而它的段该锚定哪一侧将无法回答。
  const buckets = new Map<string, SourceAsset[]>();
  for (const asset of assets) {
    const normalizedStem = normalizedStemOf(asset);
    const family = REPRESENTATION_COMPATIBLE_KINDS.includes(asset.kind) ? "document" : asset.kind;
    const key = `${normalizedStem}\u0000${asset.folderContext ?? ""}\u0000${family}`;
    const list = buckets.get(key) ?? [];
    list.push(asset);
    buckets.set(key, list);
  }

  const proposals: MaterialGroupingProposal[] = [];

  for (const [, group] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...group].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const normalizedStem = normalizedStemOf(sorted[0]);
    const folderContext = sorted[0].folderContext;
    const kinds = [...new Set(sorted.map((asset) => asset.kind))].sort();

    const basis: string[] = [];
    basis.push(`归一化文件名相同：\`${normalizedStem}\``);
    basis.push(
      folderContext === null ? "位于源根目录下" : `位于同一文件夹：\`${folderContext}\``,
    );
    if (sorted.length > 1) {
      basis.push(
        `覆盖 ${sorted.length} 个文件，形态为 ${kinds.map(describeKind).join(" + ")} —— ` +
          `这是"一份逻辑内容、多种表示"的提案，**不是**多份材料。`,
      );
    }

    // ── 2) 内容可比对性 ──
    const parsedSides = sorted.filter((asset) => parsedText.has(asset.assetKey) && asset.kind === "pdf");
    let contentComparable = false;
    let textContainment: number | null = null;

    if (parsedSides.length >= 2) {
      // 两个 PDF：可以真的比内容
      const [first, second] = parsedSides;
      const a = parsedText.get(first.assetKey) ?? "";
      const b = parsedText.get(second.assetKey) ?? "";
      if (hasEnoughSubstance(a) && hasEnoughSubstance(b)) {
        contentComparable = true;
        textContainment = containment(shingles(a), shingles(b));
      }
    }

    // ── 3) 歧义与复核要求 ──
    const reviewNotes: string[] = [];
    let ambiguous = false;
    let ambiguityReason: string | null = null;

    const hasDeferredSide = sorted.some((asset) => asset.kind === "docx");
    const multiRepresentation = sorted.length > 1;

    if (multiRepresentation && hasDeferredSide && !contentComparable) {
      // 这是本阶段**最重要的**一条诚实性要求：
      // PDF 与 DOCX 同名，但 DOCX 没被解析，因此"它们是同一份内容"
      // **没有被验证过**，只是机器提案。必须人工确认。
      reviewNotes.push(
        `这份提案把 ${sorted.length} 个文件当作同一份逻辑材料的多种表示，` +
          `但其中 DOCX 在 V1 **不被解析**（TEXT_EXTRACTION_DEFERRED），` +
          `因此"它们内容相同"这一点**没有被验证过**，只是基于文件名与目录的提案。` +
          `必须人工确认；若它们其实是两份不同内容，应拆成两份材料。`,
      );
    } else if (multiRepresentation && !contentComparable) {
      // 两个同类文件（例如两个 PDF）被并成一份材料，但**内容无法比对** ——
      // 通常是一侧文本层缺失或文本量太少。机器既不支持"内容相同"，
      // 也不支持"内容不同"，因此**绝不得默认合并**。
      reviewNotes.push(
        `这份提案把 ${sorted.length} 个文件当作同一份逻辑材料的多种表示，` +
          `但**无法比对它们的内容**（一侧没有可用的文本层，或文本量太少）。` +
          `因此"它们内容相同"这一点**没有被验证过**，只是基于文件名与目录的提案。` +
          `必须人工确认；若它们其实是两份不同内容，应拆成两份材料。`,
      );
    }

    if (multiRepresentation && contentComparable && textContainment !== null) {
      if (textContainment < 0.5) {
        // 两个可解析的 PDF 同名但内容差很多 —— 这几乎必然是两份不同材料
        ambiguous = true;
        ambiguityReason =
          `同名的两个 PDF 内容包含度只有 ${(textContainment * 100).toFixed(1)}%，` +
          `远低于"同一份内容"的水平。它们很可能是两份不同的材料（例如"讲义"与"答案"），` +
          `**不得**因为文件名相同就合并。必须人工裁决。`;
        reviewNotes.push(ambiguityReason);
      } else {
        basis.push(
          `两个可解析的 PDF 内容包含度 ${(textContainment * 100).toFixed(1)}% —— 支持"同一份内容"。`,
        );
      }
    }

    if (kinds.includes("unsupported")) {
      reviewNotes.push(
        `这份提案包含本版本不支持的文件类型 —— 它们被登记但不会被解析，也不会进入课程包。`,
      );
    }

    proposals.push({
      id: proposalIdOf(normalizedStem, folderContext, sorted.map((asset) => asset.assetKey)),
      title: buildTitle(sorted, normalizedStem),
      normalizedStem,
      folderContext,
      moduleHint: dominantModuleHint(sorted),
      representations: sorted.map(
        (asset): ProposedRepresentation => ({
          assetKey: asset.assetKey,
          sourceRelativePath: asset.relativePath,
          kind: asset.kind,
          label: representationLabel(asset),
        }),
      ),
      basis,
      evidence: {
        sameNormalizedStem: true,
        sameFolderContext: true,
        kinds,
        contentComparable,
        textContainment,
      },
      ambiguous,
      ambiguityReason,
      reviewRequired: reviewNotes.length > 0,
      reviewNotes,
    });
  }

  // ── 4) 听力配套音频：同目录唯一音频 → 并入该目录的听力讲义 ──
  //
  // 这一步之所以必须存在：课程层的听觉段**必须**引用整段音频
  // （`docs/course-package.md` §5 与生产校验器都是硬要求）。
  // 而听力材料的三个文件名字通常各不相同，按 stem 分组永远合不到一起 ——
  // 于是会发生"听力段拿不到音频资产 ⇒ 包被生产校验器拒绝"。
  //
  // 判据刻意保守且**歧义必须可见**：
  // - 只在文件夹标签属于听力模块时考虑；
  // - 该目录下**恰好只有一个**音频文件；
  // - 该目录下**恰好只有一份**文档材料（多于一份就不知道该配给谁 ⇒ 歧义）；
  // - 无论是否成功，都标记 `reviewRequired` 并说明依据。
  attachFolderAudio(proposals, assets);

  // ── 5) 不变量核对：每个资产恰好属于一份提案 ──
  //
  // 这是"一个文件不能同时是两份逻辑内容"与"一个文件也不能凭空消失"
  // 这两件事的机器判据。Foundation 的校验器在包层面也检查它，
  // 但**在生成阶段就检查**更早、更容易定位。
  const invariantViolations: string[] = [];
  const ownerCount = new Map<string, number>();
  for (const proposal of proposals) {
    for (const representation of proposal.representations) {
      ownerCount.set(representation.assetKey, (ownerCount.get(representation.assetKey) ?? 0) + 1);
    }
  }
  for (const asset of assets) {
    const count = ownerCount.get(asset.assetKey) ?? 0;
    if (count === 0) {
      invariantViolations.push(`资产 ${asset.relativePath} 不属于任何材料提案 —— 它被静默丢掉了。`);
    } else if (count > 1) {
      invariantViolations.push(
        `资产 ${asset.relativePath} 同时属于 ${count} 份材料提案 —— 一个文件不能是两份逻辑内容。`,
      );
    }
  }

  if (invariantViolations.length > 0) {
    warnings.push("分组不变量被违反（这是流水线缺陷，不是数据问题）：" + invariantViolations.join("；"));
  }

  const ambiguousCount = proposals.filter((proposal) => proposal.reviewRequired).length;
  if (ambiguousCount > 0) {
    warnings.push(
      `${ambiguousCount} 份材料提案需要人工确认（含"PDF+DOCX 等价"这类**未被验证**的提案）。`,
    );
  }

  return { proposals, invariantViolations, warnings };
}

/**
 * 把听力目录的"讲义 + 文字稿 + 整段音频"归为**一份**逻辑材料。
 *
 * ── 为什么这里必须按目录合并，而不是按文件名 ──
 *
 * 实测的真实形态（也是任务明确描述的形态）：一个听力套装的三个文件
 * **名字各不相同** ——
 *
 *   question-handout.pdf     题干讲义
 *   transcript-analysis.pdf  文字稿 / 解析
 *   listening-full.mp3       整段录音
 *
 * 按 stem 分组**永远**合不到一起（三个 stem 都不同），于是：
 * - 课程层的听觉段拿不到音频资产；
 * - 而生产校验器**硬性要求** `listening_*` 段必须引用整段音频
 *   ⇒ 整份包被拒绝。
 *
 * 因此这里按"同目录 + 该目录恰好一个音频 + 目录标签属于听力"把它们
 * **合并为一份材料**（多份表示）。这正是"一份逻辑听力套装可以有多个资产"。
 *
 * ── 这仍然只是**提案** ──
 *
 * "这些文件属于同一个套装"是**基于目录结构的合理猜测，不是已验证事实**。
 * 因此合并后**必须**标记 `reviewRequired`，并把依据完整写进 `basis` 与
 * `reviewNotes`。若目录里混了两个套装，人工必须拆开。
 *
 * **就地修改传入的 proposals 数组**（它们刚被构造出来，尚未交付给调用方）。
 */
function attachFolderAudio(proposals: MaterialGroupingProposal[], assets: SourceAsset[]): void {
  const audioAssets = assets.filter((asset) => asset.kind === "audio");
  if (audioAssets.length === 0) return;

  const audioByFolder = new Map<string, SourceAsset[]>();
  for (const audio of audioAssets) {
    const key = audio.folderContext ?? "";
    const list = audioByFolder.get(key) ?? [];
    list.push(audio);
    audioByFolder.set(key, list);
  }

  for (const [folder, folderAudio] of audioByFolder) {
    // 判据 1：目录标签必须属于听力模块。否则**不合并**（音频可能是别的用途）。
    // 注意 `folder === ""` 表示源根目录 —— 源根通常混放多种材料，因此也不合并。
    if (folder === "" || !isListeningFolder(folder)) continue;
    // 判据 2：该目录恰好一个音频（多则无法判断哪个属于哪个套装 ⇒ 不猜）
    if (folderAudio.length !== 1) continue;

    const candidates = proposals.filter(
      (proposal) =>
        (proposal.folderContext ?? "") === folder &&
        proposal.representations.some((rep) => rep.kind === "pdf" || rep.kind === "docx"),
    );
    if (candidates.length === 0) continue;

    const audio = folderAudio[0];

    // ── 把该目录下**所有其他提案**并入主体 ──
    //
    // 必须"所有"，不能只并入文档提案：音频在分桶阶段也自成了**一份提案**
    // （种类族不同）。若只并入文档而留下音频提案，该音频就同时属于两份材料 ——
    // 生产校验器会直接拒绝这个包（实测踩到：
    // `资产 … 同时被材料 A 与 B 引用。一个文件只能属于一份逻辑材料`）。
    const target = candidates[0];
    const absorbed = proposals.filter(
      (proposal) => proposal !== target && (proposal.folderContext ?? "") === folder,
    );

    for (const other of absorbed) {
      for (const rep of other.representations) {
        if (target.representations.some((existing) => existing.assetKey === rep.assetKey)) continue;
        target.representations.push(rep);
      }
      const index = proposals.indexOf(other);
      if (index >= 0) proposals.splice(index, 1);
    }

    // 并入的内容必须在 `basis` 里说清楚（复核者据此核对）
    const absorbedDocs = absorbed
      .flatMap((proposal) => proposal.representations)
      .filter((rep) => rep.kind === "pdf" || rep.kind === "docx");
    if (absorbedDocs.length > 0) {
      target.basis.push(
        `同目录的其它文件（\`${absorbedDocs.map((rep) => rep.sourceRelativePath).join("`、`")}\`）` +
          `被并入本材料：一个听力套装通常同时有题干讲义与文字稿/解析，而**它们的文件名各不相同**，` +
          `无法按名字识别套装，只能依据目录结构。`,
      );
    }

    if (!target.representations.some((rep) => rep.kind === "audio")) {
      target.representations.push({
        assetKey: audio.assetKey,
        sourceRelativePath: audio.relativePath,
        kind: "audio",
        label: representationLabel(audio),
      });
      target.basis.push(
        `同目录下唯一的音频文件 \`${audio.relativePath}\` 被提案为本材料的配套**整段**音频` +
          `（听力段必须引用整段音频；本层**不切分、不重编码、不推断时间区间**）。`,
      );
    }

    target.representations.sort((a, b) => a.assetKey.localeCompare(b.assetKey));
    target.evidence.kinds = [...new Set(target.representations.map((rep) => rep.kind))].sort();

    // 目录级合并是**提案**，必须人工确认
    const mergedCount = absorbed.length;
    const mergedNote =
      mergedCount > 0
        ? "（依据：文件名各不相同，无法按名字识别套装；只能依据目录结构）"
        : "";
    target.reviewRequired = true;
    target.reviewNotes.push(
      `本材料由**同一目录**下的 ${mergedCount + 1} 个文件合并而来${mergedNote}。` +
        `这是**基于目录结构的合理猜测，不是已验证事实** —— ` +
        `必须人工确认这些文件确实属于同一个听力套装。若该目录混放了两个套装，请拆开。`,
    );
  }
}

/** 归一化 stem：用 `sources.ts` 的唯一实现，避免两套判据漂移。 */
function normalizedStemOf(asset: SourceAsset): string {
  return normalizeStem(asset.stem);
}

function describeKind(kind: SourceAssetKind): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "docx":
      return "DOCX";
    case "audio":
      return "音频";
    case "image":
      return "图片";
    default:
      return "未支持类型";
  }
}

/**
 * 材料标题。
 *
 * 用**源件原名**（第一个表示的 stem），因为复核者要在自己的目录里找到它。
 * 刻意**不**推断"这是 2024 年 12 月第一套"—— 那是套别号，不是身份。
 */
function buildTitle(assets: SourceAsset[], normalizedStem: string): string {
  const primary = assets[0];
  const stem = primary.stem.trim();
  if (stem !== "") return stem;
  return normalizedStem === "" ? primary.basename : normalizedStem;
}

/**
 * 这份材料的候选模块提示（取多数）。
 *
 * 分歧时返回 null 并让调用方知道"这里没有一致的线索" —— 猜测一个
 * 会让下游的模块感知分段做出错误选择。
 */
function dominantModuleHint(assets: SourceAsset[]): CourseModuleHint | null {
  const counts = new Map<CourseModuleHint, number>();
  for (const asset of assets) {
    if (asset.moduleHint === null) continue;
    counts.set(asset.moduleHint, (counts.get(asset.moduleHint) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // 平手 ⇒ 无一致线索
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

// 分组的规范摘要由 `digests.ts` 的唯一实现提供（复核时会现场重算同一份）。
export { courseGroupingDigest as groupingDigest } from "./digests";
