# 规范化试卷包格式

本文件是**私有真题内容**与应用程序之间的契约。内容不进 Git，格式进 Git。

## 目录约定

```
private-content/                     ← 内容根，.gitignore 忽略
  cet6/
    papers/
      <package-dir>/                 ← 一个包 = 一份试卷
        paper.json                   ← 唯一的 manifest
        assets/                      ← 媒体资产，与 manifest 同目录
          listening-1.mp3
          ...
```

`<package-dir>` 的名字随意（只用于人工识别与日志），**试卷身份来自 `paper.json` 的 `id`
与 `(examType, year, session, variant)` 四元组**，不来自目录名。因此把同一个包复制成两份
会被识别为批内重复并拒绝第二条，而不是产生两条记录。

内容根可用环境变量 `CET6_CONTENT_ROOT` 覆盖（测试与 E2E 用）。默认 `<项目根>/private-content`。

## 命令

```bash
pnpm content:validate              # 只读校验全部包（不碰数据库）
pnpm content:import                # 预演：只打印会发生什么
pnpm content:import --commit       # 真正写入索引
pnpm content:import <dir> --commit # 只处理指定包目录
pnpm content:import --json         # 机器可读报告
```

空内容库是**合法状态**：两个命令都会成功退出并如实输出 `0 份`。

## paper.json

```jsonc
{
  "id": "cet6-2024-12-set1",          // 稳定标识，仅小写字母/数字/._-
  "examType": "CET6",                 // 目前只有 CET6
  "year": 2024,
  "session": "December",              // June | September | December
  "variant": "set1",                  // 多套卷标记；单套写 "single"
  "examDate": "2024-12-14",           // 未知则 null —— 不要猜
  "sourceKind": "real_past_paper",    // real_past_paper | sample | test_fixture
  "verificationStatus": "unverified", // unverified | partially_verified | verified
  "provenance": {
    "note": "来源说明（必填，不能为空）",
    "reference": "https://… 或本地文件名",
    "verificationNote": "核验了什么（标 verified 时必填）"
  },
  "contentVersion": 1,                // 单调递增；内容实质变化必须递增
  "partial": false,                   // 只含部分内容时必须显式声明为 true
  "assets": [ /* 见下 */ ],
  "sections": [ /* 见下 */ ]
}
```

### 来源与核验的硬规则

- `sourceKind` 与 `verificationStatus` **必须同时可见**于 UI。只有核验状态会让
  「未核验的示例包」看起来像「还没核对过的真题」。
- 只有 `sourceKind: "real_past_paper"` 才能标 `verified`。
- 标 `verified` 必须写 `provenance.verificationNote` —— 说清核对了什么。
- `partial: true` 的包不可能标 `verified`（不完整的东西无法已核验）。
- 内容实质变化 **必须**递增 `contentVersion`。否则导入会被拒绝，
  理由是「历史作答会被静默指向不同的题目」。版本只能前进，不能倒退。
- 生产 UI 中不存在的来源类型（`mock` / `generated` / `simulated`）不在此格式中，
  也永远不会加入。AI 生成的内容不得混入真题库。

## assets

```jsonc
{
  "id": "audio-long-conv-1",
  "kind": "audio",                    // audio | image
  "path": "assets/listening-1.mp3",   // 相对包根，POSIX 风格，禁止绝对路径与 ..
  "mimeType": "audio/mpeg",           // 必须与扩展名一致（以扩展名为准，不信声明）
  "bytes": 20011901,                  // 必须与磁盘实际字节数一致
  "checksum": "…64 位小写十六进制 sha256…",
  "label": "Section A 长对话 1"
}
```

允许的扩展名：`.mp3 .m4a .wav .ogg .png .jpg .jpeg .webp`。不支持的扩展名一律拒绝。

`bytes` 与 `checksum` 会与磁盘**实际值**比对。只相信 manifest 声明的校验和，
就永远发现不了「包内容与索引不一致」——用户看到的会是「音频打不开」而不是「包已损坏」。

生成校验和：

```bash
node -e "const c=require('crypto'),f=require('fs');const b=f.readFileSync(process.argv[1]);console.log(b.length, c.createHash('sha256').update(b).digest('hex'))" assets/listening-1.mp3
```

## sections → groups → questions

三个层级对应试卷本身的结构：**大题 → 题组（一份刺激材料 + 绑定其上的题）→ 题目**。

```jsonc
"sections": [
  {
    "id": "writing",                       // slug，会出现在 URL 中
    "type": "writing",
    "order": 0,
    "title": "写作",
    "instructions": null,
    "groups": [
      {
        "id": "writing#g1",
        "order": 0,
        "instructions": "Directions: …",
        "audioAssetId": null,              // 听力组必填，非听力组必须为 null
        "transcript": null,                // 听力原文；没有就为 null，不由 AI 补全
        "passage": null,                   // 阅读文章
        "paragraphs": null,                // 长篇阅读的带标号段落
        "wordBank": null,                  // 选词填空的词库
        "firstNumber": 1,                  // 本组首题在试卷上的官方题号
        "questions": [ /* … */ ]
      }
    ]
  }
]
```

### 大题类型（`type`）与官方顺序

顺序**必须**是官方顺序的子序列（允许 `partial` 时缺项，不允许乱序）：

| order | type | 官方题量 | 占卷面 |
| --- | --- | --- | --- |
| 0 | `writing` | 1 | 15% |
| 1 | `listening.long_conversation` | 8 | 8% |
| 2 | `listening.passage` | 7 | 7% |
| 3 | `listening.talk_report_lecture` | 10 | 20% |
| 4 | `reading.banked_cloze` | 10 | 5% |
| 5 | `reading.matching` | 10 | 10% |
| 6 | `reading.careful_reading` | 10 | 20% |
| 7 | `translation` | 1 | 15% |

合计 57 题、130 分钟。文档里的数字与代码里的常量同源（`src/domain/paper.ts`）。

### 题目五种形态

**四选一**（听力与仔细阅读）：

```jsonc
{ "kind": "mcq", "id": "q1", "number": 1, "order": 0,
  "stem": "…", "explanation": "…" ,
  "options": [ {"id":"A","label":"…"}, {"id":"B","label":"…"}, {"id":"C","label":"…"}, {"id":"D","label":"…"} ],
  "answer": "B" }
```

**选词填空**（10 个空共享文章与词库，因此 `passage` / `wordBank` 挂组上）：

```jsonc
{ "kind": "banked_cloze_blank", "id": "q27", "number": 27, "order": 0,
  "blankId": "1", "answer": "…" }
```
文章里用 `[1]`…`[10]` 标记空位，且每个空必须在文章中出现对应标记。
官方规则：词库每个词至多使用一次（校验器强制）。

**段落匹配**（`paragraphs` 挂组上）：

```jsonc
{ "kind": "matching_statement", "id": "q37", "number": 37, "order": 0,
  "statement": "…", "answerParagraph": "B" }
```

**写作**：

```jsonc
{ "kind": "writing", "id": "q57", "number": 57, "order": 0,
  "prompt": "…", "instructions": "…",
  "referenceEssay": null, "minWords": 150, "maxWords": 200 }
```

**翻译**（汉译英）：

```jsonc
{ "kind": "translation", "id": "q58", "number": 58, "order": 0,
  "sourceText": "……中文段落……", "instructions": "…", "referenceTranslation": null }
```

`referenceEssay` / `referenceTranslation` 没有就留 `null` —— **不要生成**。
生成的范文会污染对真实水平的判断。

## 题号规则

题号是**试卷上的官方编号**，不是数组下标。

- 严格递增（禁止乱序与重复）—— 硬约束。
- 完整卷（`partial: false`）还必须从 1 连续到总题数。
- 部分卷（`partial: true`）**保留缺口**：若缺听力讲座（第 17–26 题），
  选词填空仍从第 27 题开始 —— 那正是试卷原样，强行重排会让题号与手上的原卷对不上。

## 校验错误的位置

校验失败时错误路径精确到字段，例如：

```
sections[2].groups[1].questions[3].answer: 答案指向不存在的选项：Z
sections[4].groups[0].wordBank: 选词填空必须提供词库
assets[0].path: 路径不安全：../../../secret.mp3（包含 .. 上跳）
```

一次报告**全部**问题，而不是只报第一个。

## 路径安全

导入会读本机文件，因此包内路径按不可信输入处理。两级防线（`src/content/paper/paths.ts`）：

1. **词法层**：拒绝绝对路径、盘符路径（`C:/`）、UNC、`..` 段、`.` 段、空字节。
2. **真实路径层**：目标存在时用 `realpath` 解析后再次比对内容根前缀 ——
   词法检查对「根内合法路径指向根外的软链接」无能为力。

库中记录的包路径同样过这两道检查：**数据库不是可信来源**。

## 从 PDF / MP3 到规范化包（半自动流水线）

原始源导入由 `src/content/pipeline/` 与两个命令承担：

```bash
pnpm papers:extract <paper-id>              # 生成候选包 + 审计模板
pnpm papers:review <paper-id>               # 复核汇总（重新求值门禁）
pnpm papers:review <paper-id> --promote     # 门禁通过后晋升到 cet6/papers/
```

**链路**：原始源 → 候选包 → 人工复核 → 晋升 → **同一个校验器** → 导入。
AI 抽取的结果**先变成候选包**，而不是直接写数据库。

### 候选包的位置与状态

```
private-content/
  raw/<paper-id>/
    sources.json              来源登记（extract 的输入：主源/答案/音频/第三方 + 校验和）
    question-paper.pdf        主源 PDF（抽取对象）
    secondary/…               第三方页面（仅用于交叉核对与听力题干重建）
  candidates/<paper-id>/      ← 候选包，**不在 cet6/papers/ 下**
    paper.json                候选 manifest（status 未批准）
    candidate.json            元数据：复核项 + 源保真 + 答案验证 + 门禁
    corrections.json          人工裁决驱动的修正（**由人书写**）
    review.json               人工复核记录（**由人书写**）
    assets/…                  资产
  audit/<paper-id>-normalization.md   规范化审计记录
```

**关键设计**：候选目录**不在 `cet6/papers/` 之下**。导入器的 `discover()`
只枚举 `cet6/papers/*`，因此候选包**在原理上**不可能被导入 ——
这比"记得不要导入候选"可靠。

### 门禁（fail-closed）

`pnpm papers:review` 会**重新求值**门禁（不信任候选文件里的旧结论）。
11 项检查全部通过才 `IMPORTABLE`：

无阻断项 · 官方题量 · 各大题题量 · 源保真 0 DIFF · 资产磁盘校验 ·
听力音频 · 源件校验和稳定 · **人工复核已完成** · 全部阻断项已裁决 ·
听力题干来源已披露 · 答案证据强度已记录。

**人工复核是一项独立检查，且工具从不生成它** ——
若流水线能自己写复核记录，"人工复核"就只是一句话。

### 复核者要写什么

`corrections.json`（每条必须带理由与证据）：

```jsonc
{
  "paperId": "…", "reviewer": "…", "reviewedAt": "YYYY-MM-DD",
  "corrections": [
    {
      "type": "relabel_option",          // 源件把选项标签印错
      "questionId": "q54",
      "from": "O", "to": "C",
      "reason": "…", "evidence": "…",     // 证据非空且 ≥10 字符
      "resolves": { "code": "option_label_unexpected", "where": "q54.options" }
    },
    {
      "type": "uphold_primary_answer",   // 来源间答案分歧，裁定保留主源值（不改写答案）
      "questionId": "q13",
      "primary": "C", "secondary": "B",
      "reason": "…", "evidence": "…",
      "resolves": { "code": "answer_not_in_options", "where": "<answers>/q13" }
    }
  ]
}
```

`review.json`（必须声明核验范围；`notVerified` 是 `partially_verified` 的依据）：

```jsonc
{
  "paperId": "…", "reviewer": "…", "reviewedAt": "YYYY-MM-DD",
  "resolutions": [{ "code": "…", "where": "…", "resolution": "…", "evidence": "…" }],
  "verifiedScope": ["…"],   // 不得为空
  "notVerified": ["…"]      // 没有未核验项时填空数组
}
```

**不允许**通用文本替换修正（`replace_text`）：发现用词不符时，
正确做法是核对源件本身，而不是让工具换掉内容。

### 源保真与答案验证

- **源保真**：只比对 `origin: "primary"` 的字段；第三方重建的内容判 `UNVERIFIABLE`
  而非 `DIFF`（对它做比对必然失败，会淹没真正的偏差）。
  紧凑形式删空白、**保留撇号**、按句子比对 —— 三个决定都由实测倒逼。
- **答案验证**：证据强度分 `single_source` / `cross_source_agree` /
  `cross_source_conflict`。单一来源**不**阻断（是合法的诚实状态）；
  跨来源**分歧必须阻断**，且不得自动调和。一致提升的是可信度而非权威性 ——
  **不存在"官方"这一档位**。

