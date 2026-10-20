# 规范化课程包格式（Course Layer V1）

本文件是**私有课程材料**与应用程序之间的契约。内容不进 Git，格式进 Git。

> 配套文件：真题包格式见 `docs/past-paper-package.md`。
> 两者的哲学相同（正文不落库、私有内容不进 Git、版本只能前进），
> 但**语义完全不同** —— 见下节。

## 0. 课程层是什么，不是什么

**课程层不是第二个题库。**

CET-6 的规范真相完全留在既有的 `exam_paper` + Expert Training 台账里。
课程层只做一件事：把**私人课程材料**规范化、索引，并允许人工核验过的
片段**指向**规范真题位置。方向是单向的：

```
课程包 → 课程材料 → 课程段
                      ↓（可选的、人工核验的链接）
                 规范真题 section / group / question
```

反向不成立：课程材料**不得**成为题目、答案或学习者能力证据的来源。

### 必须区分的两件事

| | 课程曝光（Course Exposure） | 表现证据（Performance Evidence） |
| --- | --- | --- |
| 含义 | 学习者**看过/学过**一段课程材料 | 学习者**独立作答**一道规范真题 |
| 落点 | `course_exposure_event` | `performance_event` / `assessment_event` / `evidence_projection` |
| 是否只追加 | 是（数据库触发器守护） | 是（数据库触发器守护） |
| 能否产生技能分/掌握度/弱项 | **永不** | 那是后续阶段的机制层工作 |

记录课程曝光**不会**写任何 Expert 台账，也不会写 `skill_profile` /
`answer_attempt` / `review_item`。这条边界由服务层不 import 对方 + 架构门禁
+ 表结构（曝光表里没有 outcome/score/mastery 列）三重守护。

### 未匹配是合法状态

课程材料按题型重新归组，其中大量内容（方法说明、写作模板、老师讲解）
本来就不与任何单道真题一一对应。因此：

- 一个**所有段都未匹配**的课程包完全可以成功导入，这不是警告也不是失败；
- 导入器与校验器里**不存在**任何"未匹配比例过高则拒绝"的分支；
- 一条课程段可以**无限期**保持未匹配。

这一点很重要：若导入要求全匹配，课程层在原理上就不可用。

---

## 1. 目录约定

```
private-content/                     ← 内容根，.gitignore 忽略
  cet6/
    papers/                          ← 真题包（另一个导入器）
      <package-dir>/
        paper.json
  courses/                           ← 课程包（本文件）
    <package-dir>/                   ← 一个包 = 一门课程材料的一次交付
      course.json                    ← 唯一的 manifest
      assets/                        ← 讲义 / 音频 / 图片
        handout.pdf
        handout.docx
        listening-full.mp3
```

> **为什么 `courses/` 不在 `cet6/papers/` 之下**：两个导入器的 `discover()`
> 各自只枚举自己的目录，因此"课程包被真题导入器误当成试卷"（或反之）
> 在**原理上**不可能 —— 这比"记得过滤"可靠得多。

`<package-dir>` 的名字随意（只用于人工识别与日志）。**课程身份来自
`course.json` 的 `id`**，不来自目录名。因此把同一个包复制成两份会被识别为
批内 id 重复并拒绝第二条，而不是产生两条记录。

内容根可用环境变量 `CET6_CONTENT_ROOT` 覆盖（测试与 E2E 用）。
默认 `<项目根>/private-content`。

### 安全约束（硬性）

- **真实付费材料不得进入 Git。** `private-content/` 整体被 `.gitignore` 忽略。
- **不得把课程材料上传到任何外部服务，不得为课程内容调用远程 AI。**
- **不得把绝对路径写进 manifest 或数据库。** 库中只存相对课程根的路径。
- `assets[].path` 经过与真题包同一套路径安全解析：拒绝 `..` 上跳、
  绝对路径、盘符路径、越界软链接、`\0`。反斜杠会被规范化为 POSIX 风格。

---

## 2. 命令

```bash
pnpm course:validate                 # 只读校验全部课程包（不碰数据库）
pnpm course:import                   # 预演：只打印会发生什么（dry-run）
pnpm course:import --commit          # 真正写入索引
pnpm course:import <dir> --commit    # 只处理指定包目录
pnpm course:import --json            # 机器可读报告

pnpm course:link --course <id> --segments   # 列出该包的段（人工核验时找 id）
pnpm course:link --course <id> --list       # 列出链接及其运行时可用性
pnpm course:link --course <id> --segment <sid> --paper <pid> --section <sid> \
  --scope section --status verified --ref "<核验依据>"            # 预演
pnpm course:link … --commit                                      # 写入
```

空课程库是**合法状态**：`validate` 与 `import` 都会成功退出并如实输出 `0 份`。

**导入默认是 dry-run，写入必须显式加 `--commit`。** 这条与真题导入一致。

### 只读保证（包括 schema）

| 命令 | 会写数据库吗 | 会迁移 schema 吗 |
| --- | --- | --- |
| `course:validate` | 否（**根本不打开数据库**） | 否 |
| `course:import`（无 `--commit`） | 否 | **否** |
| `course:link --list` / `--segments` | 否 | **否** |
| `course:link`（无 `--commit`） | 否 | **否** |
| `course:import --commit` | 是 | **是**（增量 v8→v9，属于提交动作） |
| `course:link --commit` | 是（只加链接行，不建表） | 否（表在激活时已建好） |

**「dry-run，不写数据库」是字面为真的，包括 schema。**
只读命令使用**只读数据库连接**：不建目录、不建表、不跑迁移、不写
`schema_meta`。任何写入都会在 SQLite 层以
`attempt to write a readonly database` 失败 —— 这是**结构性**保证，
不是"打开之后保证不写"。

> 为什么必须写清楚这一点：曾经有一条"预演"命令经由迁移-capable 的连接工厂
> 打开库，于是**打开本身**就把 v8 库迁移成了 v9。

**迁移是提交动作的一部分，不属于任何预演。** 只有 `course:import --commit`
会执行 v8 → v9 的增量迁移（建课程层三张表与只追加触发器），
并在**同一个事务**内写入课程索引。

### 在 v8 库上跑只读命令

课程层表是 schema v9 才有的。若库还是 v8：

- 只读命令**不会**迁移它；`schema_version` 保持 8，也不会新建任何 `course_*` 表。
- 它们会**如实说明"课程层尚未激活"**，并给出激活方式：
  `pnpm course:import --commit`。
- 它们**不会**抛出 `no such table` —— "课程层未激活"是正常状态，不是错误。
- `course:import`（无 `--commit`）仍会报告 `--commit` **之后**会发生什么
  （例如"新增 3 份"），但会同时显式说明课程层尚未激活、索引当前必然为空。

---

## 3. course.json

```jsonc
{
  "id": "rsvp-2026h2-reading",     // 稳定课程 id，仅小写字母/数字/._-
  "provider": "rsvp",              // 提供方。**自由字符串，不是枚举**
  "edition": "2026 下半年",         // 版次 / 期次标签。可为 null
  "title": "2026 下半年六级阅读讲义",
  "contentVersion": 1,             // 单调递增；**语义内容**变化才递增
  "provenance": {
    "note": "来源说明（必填）",
    "reference": "购买渠道 / 课程名 / 本地文件名",
    "rightsNote": "这份材料为何可以合法保存在本机（必填）"
  },
  "materials": [ /* 见 §4 */ ],
  "segments":  [ /* 见 §5 */ ],
  "assets":    [ /* 见 §6 */ ]
}
```

### schemaVersion 与 contentVersion 是**两件不同的事**

| 字段 | 回答的问题 | 何时递增 | 是否影响已核验链接 |
| --- | --- | --- | --- |
| `schemaVersion` | 这份 JSON 该按**哪一版契约**解析？ | JSON 形状 / 字段含义变化时 | **不影响** |
| `contentVersion` | 这是第几版**语义内容**？ | 课程正文或结构实质变化时 | 升版即失效，须重新核验 |

硬规则：

- `schemaVersion` **必需**。缺失、非整数、或高于应用支持的版本一律**拒绝导入**，
  并且错误会**直说**是契约版本的问题（而不是抛出一串无关的下游字段错误）。
  当前应用支持：`1`。
- **两者绝不可互相替代。** 把 `schemaVersion` 当 `contentVersion` 用，
  会让一次纯粹的序列化调整被判成"内容变了"，从而**让一批本来完全成立的
  人工复核链接无谓失效**；反过来则会让解析器失去"我能不能读懂这份文件"的判据。
- `schemaVersion` **不参与内容指纹**（见下）。

### provider 的语义

`provider` 是**被校验的普通字符串**（slug 形式），**没有** provider 枚举，
也没有 `rsvpSegment` 这类把首个 provider 焊进领域/存储命名的东西。
换成第二个 provider 时，只应新增一个包目录 —— 不需要改 schema、不需要改领域层。

（术语边界：`provider` 只描述"这份材料来自谁"，它**不**影响任何学习者证据语义。）

### contentVersion 与内容指纹（重要）

与真题包一样，有两个不同的判据：

| 判据 | 存于 | 回答的问题 |
| --- | --- | --- |
| manifest 校验和 | `course_package.manifest_checksum` | `course.json` 这个**文件**是否被改动过 |
| 内容指纹 | `course_package.content_fingerprint` | 这是不是同一版**内容** |

**纳入指纹**（内容本身）：材料 id 与标题、段的 id/kind/order/标题/锚点、
段的 `text` / `transcript` / `referenceTranslation` / `notes`、
段引用的音频资产 id、段的表示 id。

**排除指纹**（声明或文件级事实）：**`schemaVersion`**（序列化契约版本）、
`provider` / `edition` / `provenance` / `rightsNote`、
资产的 `path` / `bytes` / `checksum` / `mimeType`、
**未被任何段引用的表示**。

由此得到三条必须成立的行为：

- 只改 `rightsNote`（或 provider / edition）⇒ 判为 `metadata_only`，
  **不递增 `contentVersion`**；
- 给同一份材料补一个 DOCX 版本 ⇒ 指纹**不变**（同一逻辑内容的不同文件）；
- **只升 `schemaVersion`（纯序列化调整）⇒ 指纹不变**，
  因此不会让已核验的链接无谓失效。

**内容实质变化必须递增 `contentVersion`**，否则导入被拒绝。理由与真题包相同，
但后果更具体：`contentVersion` 是已核验链接的绑定对象之一，涨版本会让链接失效 ——
而**无谓地**涨版本会让一批本来仍然成立的人工复核记录白白失效。

版本**只能前进**：包声明的版本低于库中版本即拒绝。

---

## 4. materials 与 representations（一份材料，多种表示）

```jsonc
{
  "id": "material-reading",
  "title": "2026 下半年六级阅读讲义",
  "representations": [
    { "id": "pdf",  "assetId": "handout-pdf",  "label": "PDF 版" },
    { "id": "docx", "assetId": "handout-docx", "label": "DOCX 版" }
  ]
}
```

### 为什么必须有表示层

同一份讲义常同时存在 PDF 与 DOCX 两个文件。若把"文件"当作"材料"，
同一份讲义就会变成**两条重复的课程材料** —— 于是同一段课程内容会在界面上
出现两次、被学习者看见两次、被统计两次。

表示层把这件事在**模型层面**消除：**文件是表示，材料是逻辑内容。**

校验器另外补两条：

- 同一材料**不得重复引用同一个资产**（那只是同一个文件写了两行）；
- 同一资产**不得被两份不同材料引用** —— 一个文件不能同时是两份逻辑内容，
  否则"这份材料有几个文件"与"这个文件属于哪份材料"两个问题的答案会互相矛盾。

因此一个包里有 N 个文件，不等于有 N 份材料。

---

## 5. segments（课程段 / 出现）

```jsonc
{
  "id": "reading.a",
  "materialId": "material-reading",
  "kind": "reading_passage",
  "order": 0,
  "title": "阅读篇章 A",
  "representationId": "pdf",
  "anchor": {
    "pageStart": 1,
    "pageEnd": 3,
    "quote": "稳定文本引证（用于对回源件）"
  },
  "audioAssetId": null,
  "startSeconds": null,
  "endSeconds": null,
  "text": "正文……",
  "transcript": null,
  "referenceTranslation": null,
  "notes": "课程讲解 / 语言点"
}
```

### 段的种类（`kind`）

| kind | 含义 | 必填内容 |
| --- | --- | --- |
| `reading_passage` | 阅读：按题型重新归组的历年真题文章 | `text` 或 `notes` |
| `listening_conversation` | 听力：长对话 | `audioAssetId`（`transcript` 建议） |
| `listening_passage` | 听力：篇章 | `audioAssetId` |
| `listening_recording` | 听力：整段录音（讲座 / 报道） | `audioAssetId` |
| `translation_passage` | 翻译：中文原文 + 课程参考译文 + 语言点 | `text` 必填 |
| `writing_template` | 写作：模板 | `text` 或 `notes` |
| `method_note` | 方法知识 / 说明 | `text` 或 `notes` |

新增种类必须来自**真实材料里确实出现了它**，而不是"以后可能用得上"。

### 音频：整段材料，不物理切分

听力段引用的是**整段音频资产**（整卷 MP3 或整段录音）。

- **不得**为了"每段一个文件更整齐"而切分或重编码音频。
- `startSeconds` / `endSeconds` 是模型里**可选**的时间区间，
  本阶段**不产生**它，也**不读取音频内容**去推断区间。
- 听力段没有 `transcript` 只产生**提醒**，不阻断导入
  （有的材料确实只给音频）。

### 锚点与来源可追溯

- `anchor.quote` 是"稳定文本引证"：当页码不可用时（扫描件、重排版、DOCX），
  它是唯一还能把 segment 与源件对上的东西。
- `pageStart` / `pageEnd` 只在某个具体表示的页码体系里成立 ——
  因此声明页码**必须同时声明 `representationId`**（PDF 有页码，DOCX 没有）。
  否则"第 12 页"指向哪份文件根本不可知。
- 既无页码也无引文是**合法的**（例如课程自编的方法说明），
  但会产生一条提醒：这一段无法定位回源件。
- **不做自动对齐**：锚点是包作者的声明，不是系统推断出来的。

### 顺序

同一材料内，段的 `order` 必须**从 0 连续**。
它表达呈现顺序，不允许"声明顺序"与"数组顺序"两个真相。

### 翻译段的参考译文

`referenceTranslation` 是**课程材料**，不是唯一正确译法。
缺少它只产生提醒（有的翻译讲义只给语言点）。

---

## 6. assets

```jsonc
{
  "id": "handout-pdf",
  "kind": "document",                   // document | audio | image
  "path": "assets/handout.pdf",         // 相对包根，POSIX，禁止绝对路径与 ..
  "mimeType": "application/pdf",        // 必须与扩展名一致（以扩展名为准，不信声明）
  "bytes": 123456,                      // 必须与磁盘实际字节数一致
  "checksum": "…64 位小写 hex sha256…", // 必须与磁盘实际内容一致
  "label": "讲义 PDF 版"
}
```

允许的扩展名：`.pdf` `.docx` `.doc` `.md` `.txt`（文档）、
`.mp3` `.m4a` `.wav` `.ogg`（音频）、`.png` `.jpg` `.jpeg` `.webp`（图片）。

**三个字段都必须与磁盘实际值一致**，任何不符即拒绝整个包
（字节数、sha256、MIME 与扩展名映射）。校验顺序与真题包一致：
**先词法、再磁盘、最后语义** —— 路径不安全时立刻停在路径层，不去读任何文件。

资产生成方式（PowerShell）：

```powershell
$f = "assets/handout.pdf"
$b = (Get-Item $f).Length
$h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
"bytes=$b checksum=$h"
```

---

## 7. canonical 链接（人工核验）

### 系统无法自己知道对应关系

一段课程材料对应哪道真题，**只能由人工核验**。以下都**不是**证明：

- 文件名
- "第 1 套" 之类的套别号
- 物理 PDF 顺序 / 页码
- 题号本身

它们可以作为**候选线索**，但永远不是证据。因此链接的唯一入口是
`pnpm course:link`（人工显式声明）。

### 三个粒度

| `--scope` | 必须声明 | 不得声明 |
| --- | --- | --- |
| `section` | `--section` | `--group` / `--question` |
| `group` | `--section` `--group` | `--question` |
| `question` | `--section` `--group` `--question` | — |

### 核验状态

| `--status` | 含义 | 能否成为运行时链接 |
| --- | --- | --- |
| `verified` | 人工核验通过 | **能**（且必须给出 `--ref`） |
| `candidate` | 机器 / 人工候选，尚未核验 | 不能 |
| `rejected` | 已被人工作废 | 不能 |

`candidate` / `rejected` **可以落库**（保留"这条为什么没被采用"的审计线索），
但运行时读取一律过滤掉。判据集中在 `isLinkRuntimeUsable` 一处。

`verified` **必须**给出 `--ref`（谁、依据什么材料、何时核验的）：
一条没有出处的"已核验"与机器候选没有区别，只是自称更可信。

### 失败关闭：写入时必须全部成立

服务层在写入前逐项校验，任一不成立即拒绝（`fail closed`，不写任何行）：

1. 课程包在索引中；
2. 请求的课程内容版本**就是当前版本**；
3. `segment` 在该版本的规范化课程包中确实存在；
4. **当前课程包可读，且 manifest 校验和 == 索引登记值**（包未漂移）；
5. 目标真题卷在索引中；
6. 目标真题 `contentVersion` **精确匹配**；
7. **当前真题包可读，且 manifest 校验和 == 索引登记值**（包未漂移）；
8. `section` / `group` / `question` 在该真题包中确实存在；
9. 目标粒度在结构上成立；
10. `verified` 必须有核验引用。

第 3、4、7、8 项读的是**磁盘上的规范化包**，而不是只信数据库的计数 ——
索引里没有"这个 group_id 是否存在"，也没有"盘上的字节是否还是那一份"。

### 版本相等是**必要但不充分**的（最重要的一节）

`contentVersion` 相等只证明"**没有人正式升过版**"，**不证明**"包还是复核时那一份"。
盘上的 `course.json` / `paper.json` 可以被直接改动而版本号毫无变化。

因此运行时可用性的判据是**当前盘的真相**，不只是版本号：

```
可用 ⟺ status == verified
      ∧ 课程包在索引中 ∧ 链接记录的课程版本 == 当前索引版本
      ∧ 真题卷在索引中 ∧ 链接记录的真题版本 == 当前索引版本
      ∧ 当前课程包可读 ∧ 课程 manifest 校验和 == 索引登记值
      ∧ 当前真题包可读 ∧ 真题 manifest 校验和 == 索引登记值
      ∧ 声明的大题/题组/题目在当前真题包中仍然结构存在
```

后三条是**必须**的：少了它们，系统对"包漂移"是 fail-open 的 ——
直接在盘上改内容而不升版本，版本比对会全部通过，链接看起来仍然可用，
而它指向的内容已经换了。

具体后果（全部有对抗性测试覆盖）：

| 情形 | 写入链接 | 既有运行时链接 |
| --- | --- | --- |
| 课程包在盘上被改动（版本未变） | **拒绝**（提示重新导入） | **立即不可用** |
| 真题包在盘上被改动（版本未变） | **拒绝**（提示重新导入） | **立即不可用** |
| 包的 manifest 被删除或无法解析 | **拒绝** | **立即不可用** |
| 声明的大题/题组/题目在当前包中已不存在 | **拒绝** | **立即不可用** |
| 只改 `rightsNote` / `schemaVersion` 等**声明** | 允许（内容未变） | **仍可用** |

**不需要重新导入或升版本，运行时就要立刻看到漂移。**
这一点很关键：若"漂移要等下一次导入才生效"，那么从改盘到下次导入之间的
整段时间里，系统都在用一条已经失真的链接当真相。

### 失效（staleness）：版本一升，链接立即不可用

链接记录**两个**内容版本：复核时的课程版本与真题版本。运行时可用性
**不是存储字段**，而是"链接记录的版本 vs 当前版本"的函数：

```
可用 ⟺ status == verified
      ∧ 课程当前版本存在 ∧ 课程版本 == 链接记录的课程版本
      ∧ 真题当前版本存在 ∧ 真题版本 == 链接记录的真题版本
```

**课程升版或真题升版后，链接立即不可用**，且**绝不自动跟着升级**：

> 链接的价值来自"这一段确实对应那道题"这次**人工复核**。
> 自动升级会把那次复核**静默地**应用到它从未被复核过的新内容上 ——
> 复核结论被保留，而复核的对象已经换了。

这与"历史作答不得被静默指向另一道题"是同一条原则。
升版后必须**重新核验**（建立一条指向新版本的新链接）；
旧链接原样保留为历史记录，**不被改写、不被删除**。

可用性在读取时按当前索引与当前包重算，因此：

- 课程包或试卷被移出索引 ⇒ 相关链接立即不可用（而不是报错或静默当成未变）；
- 包在盘上漂移 ⇒ 立即不可用（见上）；
- 链接不会因"重新导入课程包"而被删除。

### 每一行都是**不可变的复核主张**

`course_canonical_link` 的一行 = 一条审计主张
（"某年某月某人依据某材料核验过这条对应关系"）。
由此推出四条硬行为：

| 行为 | 结果 |
| --- | --- |
| 同一份**完整**主张重复写入 | **幂等**：不产生重复行 |
| 同一目标，但**修正了出处**（`--ref`） | **追加一条新行**；旧行保留 |
| 同一目标，但**修正了注解**（`--note`） | **追加一条新行**；旧行保留 |
| 对任意行做 raw `UPDATE` / `DELETE` | **被数据库触发器阻断** |

因此链接的**确定性身份包含**映射身份 + `verificationStatus` +
`verificationRef` + `note`；**不包含** `createdAt`（时间不是主张的内容，
纳入它会让每次重跑都产生新行）。

"不可变"由 `BEFORE UPDATE` / `BEFORE DELETE` 触发器 `RAISE(ABORT)` 守护，
与 `performance_event` / `assessment_event` / `course_exposure_event`
用的是同一种机制 —— **不是**应用层约定（约定拦不住迁移脚本与调试工具）。

修正的正确做法就是**再核验一次**（追加新行），而**不是**改写旧行。
这也意味着：`--ref` 写错了不需要手工改库，直接带着修正后的出处重跑即可。

### 运行时目标与审计历史是**两个层次**

同一组映射被独立复核两次、或出处被修正后重新核验，会产生**多条**
都成立的 verified 行 —— 但它们描述的是**同一个** canonical 目标。

- **运行时真相按语义目标去重**：`listRuntimeLinksForSegment` 对同一
  `(course, version, segment, paper, version, section, group, question, scope)`
  只返回**一条**，代表行取 `createdAt` 最新者（平手时按 id 升序，因此可复现）。
  一次复核修正**不会**让系统以为出现了两个对应关系。
- **审计历史不去重**：`listLinksForSegment` / `listLinksForSegmentWithUsability`
  返回**每一条**不可变行，`getCourseLinkOverview().verifiedRows` 也如实计数。

概览里 `verifiedUsable`（去重后的运行时目标数）与 `verifiedRows`（审计行数）
**分开报告** —— 合成一个数字会让"复核了两次"看起来像"两个对应关系"。

### 读取入口

| 用途 | 函数 | 是否去重 |
| --- | --- | --- |
| **运行时链接**（当前可用的 verified） | `listRuntimeLinksForSegment` | **是**（语义目标） |
| 全部链接 + 逐条可用性与原因 | `listLinksForSegmentWithUsability` | 否（审计历史） |
| 某段的原始不可变复核行 | `repos.courses.listLinksForSegment` | 否（审计历史） |
| 整包概览（运行时目标数 / 审计行数 / 候选 / 否决） | `getCourseLinkOverview` | 目标去重、行数如实 |

所有下游（规划器、未触碰判定、未来 UI）应当只使用
`listRuntimeLinksForSegment`（或等价的权威服务路径），
**不得自己重写这套判据** —— 那必然漂移。

包完整性的判定收敛在 `services/course-packages.ts` **一处**
（读取 + 校验和比对 + 目标结构存在性），写入路径与运行时路径共用它。
一次调用内每份包只读一次；缓存**不跨调用**，因此磁盘漂移在下次读取时
立刻可见（刻意不做模块级缓存 —— 那会掩盖漂移）。

---

## 8. 数据库（课程层三张表）

schema 版本 **9**（v8 → v9 是**纯增量**迁移）。

| 表 | 内容 | 关键约束 |
| --- | --- | --- |
| `course_package` | 课程包索引 | 正文不落库；只存版本/校验和/指纹/相对路径/计数 |
| `course_canonical_link` | **不可变的复核主张** | 身份由主张确定性推导 ⇒ 幂等；`UPDATE`/`DELETE` 由触发器阻断 |
| `course_exposure_event` | 只追加的课程曝光观测 | `UPDATE`/`DELETE` 由触发器 `RAISE(ABORT)` 阻断 |

三条设计要点：

1. **`course_package` 没有任何正文列** —— 正文的规范来源是磁盘上的包。
2. **`course_exposure_event` 没有任何结果/因果列**，也**不以 canonical 题目
   为主身份**（没有 `paper_id` / `question_id`）。后者是本设计最关键的一处：
   一段今天在"未匹配"状态下被学过的材料，两周后人工核验出它对应哪道题时，
   历史曝光必须仍能被**投影**到那道题上。若曝光当初写死了 canonical 目标，
   这份信息就已经丢了。（本阶段只保存信息，**不做**投影。）
3. **课程层与 Expert 台账完全平行**：迁移不触碰任何既有表，
   服务层不互相写入，曝光表里没有可写"表现"的字段。

**没有为 `schemaVersion` 加列**：它是 manifest 的序列化契约，
不是持久化事实。为它改库结构会把"文件格式版本"混进持久化真相，
而它与 `contentVersion` 是两件事。导入报告会打印被校验通过的契约版本，
因此排查时仍然可查。

---

## 9. 常见问题

**Q：课程包里的段必须匹配真题吗？**
不。未匹配是合法状态，而且很常见。导入不会因此失败。

**Q：能自动匹配吗？**
不能。文件名、套别号、页码顺序、题号都不是证明。可以（在后续阶段）
产生 `candidate` 记录供人复核，但只有人工核验的 `verified` 才是运行时链接。

**Q：课程升版后原来的链接怎么办？**
自动失效，必须重新核验。旧链接保留为历史，不会被删除。
如果只是改了权利说明 / 来源说明，**内容版本不变、链接不受影响**。

**Q：我直接在盘上改了课程材料（没重新导入），会怎样？**
链接**立即**不可用，而且此时**无法**建立新链接 —— 直到你重新导入把索引
对齐到盘上的内容。系统不会假装"版本没变所以内容没变"。
`pnpm course:import`（预演）会告诉你判定结果。这是刻意的：一条"已核验"
必须指向**复核过的那一份字节**，否则复核结论没有意义。

**Q：`--ref` 写错了怎么办？**
带着修正后的出处**重新核验一次**即可。系统会**追加**一条新的不可变复核行，
旧行保留为审计历史（不会被改写，也不会被删除）。
不需要手工改库 —— 而且 raw `UPDATE` / `DELETE` 会被数据库直接拒绝。

**Q：同一段被核验了两次，会不会变成两个对应关系？**
不会。运行时真相按**语义目标**去重，同一目标只返回一条
（代表行取最新的那条复核）。审计历史仍保留全部行，
概览里 `verifiedRows` 会如实显示实际复核了几次。

**Q：导入课程包会影响 Today / 计划 / 模考保留吗？**
本阶段（V1 基础）**不会**。课程层只建立索引与观测存储；
用它判定"真题已不再未触碰"属于后续阶段的工作。

**Q：课程曝光能让系统知道我会做某道题吗？**
不能，而且这是刻意的。看过材料 ≠ 独立作答。
表现证据只能来自 Expert Training 下的真实作答。
