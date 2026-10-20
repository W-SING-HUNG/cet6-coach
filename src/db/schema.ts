/**
 * SQLite DDL。
 *
 * 设计原则：
 * - 单一事实来源。派生结果（如诊断维度分）不落库，读时按确定性规则重算，避免状态不一致。
 * - 表数量克制，只覆盖当前阶段真实需要，不做"未来可能有"的空表。
 *   实际数量：**21 张**（20 张业务表 + schema_meta）。以本文件的 DDL 为准 ——
 *   修改 DDL 后请同步更新此处数字与 README 的 schema 说明。
 * - 字段名与 `src/domain/models.ts` 对齐，未来迁移 Postgres 时改动可控。
 *
 * 数量核对方式（不凭印象书写，遵循「单一事实来源」）：
 * `grep -c "^CREATE TABLE IF NOT EXISTS" src/db/schema.ts`
 */

export const SCHEMA_VERSION = 9;

/**
 * 连接级 PRAGMA。
 *
 * **必须与 DDL 分开**，且**在事务之外执行**：`PRAGMA journal_mode = WAL`
 * 不能在事务内切换（SQLite 会报 "cannot change into wal mode from within a transaction"），
 * 而建库/迁移现在整体包在一个事务里（见 `client.ts`）。混在一起的后果是
 * 迁移与建库要么报错、要么失去原子性。
 */
export const SCHEMA_PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- schema 版本单调性（防"旧代码打开新库并静默降级"）
--
-- 为什么用触发器而不是只靠应用层检查：应用层检查只能约束**当前及以后**的代码。
-- 已经发布的旧版本应用打开一个新库时，它的建库流程会无条件把
-- schema_meta.schema_version 写成自己的低版本 —— 之后新代码再打开，
-- 就会认为库是旧版并跳过迁移，于是**新表被当成不存在**，而旧代码
-- 又完全不知道新表的存在，两侧都在错误的认知下继续写数据。
--
-- 触发器把这条约束下沉进数据库本身：**已发布的旧代码也会被它拦住**
-- （旧代码的那条 UPSERT 会因 RAISE(ABORT) 抛错而启动失败 —— 正是"失败关闭"）。
--
-- 允许相等（幂等重写），只禁止下降。
-- 已知时序局限：这条保护只在库**被新代码打开过一次之后**才存在
-- （新库由本版本创建即带触发器；更早的老库在下次升级时补上）。
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS schema_meta_version_monotonic
BEFORE UPDATE ON schema_meta
WHEN OLD.key = 'schema_version'
  AND NEW.key = 'schema_version'
  AND CAST(NEW.value AS INTEGER) < CAST(OLD.value AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'schema_version 不允许下降：旧版本应用不得打开新版本数据库');
END;

-- 学习者。Phase 1 单用户，但保留 id 以便未来多用户/云同步。
CREATE TABLE IF NOT EXISTS learner_profile (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  weekday_minutes   INTEGER NOT NULL,
  weekend_minutes   INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_goal (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL REFERENCES learner_profile(id) ON DELETE CASCADE,
  exam_name      TEXT NOT NULL,
  exam_date      TEXT NOT NULL,
  target_score   INTEGER NOT NULL,
  score_history  TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_goal_profile ON exam_goal(profile_id);

CREATE TABLE IF NOT EXISTS diagnostic_session (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL REFERENCES learner_profile(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  item_ids       TEXT NOT NULL DEFAULT '[]',
  partial        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_diag_profile ON diagnostic_session(profile_id, started_at DESC);

CREATE TABLE IF NOT EXISTS diagnostic_answer (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES diagnostic_session(id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL,
  dimension      TEXT NOT NULL,
  choice_id      TEXT,
  answer_text    TEXT,
  skipped        INTEGER NOT NULL DEFAULT 0,
  submitted_at   TEXT NOT NULL,
  UNIQUE(session_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_diag_answer_session ON diagnostic_answer(session_id);

-- 能力画像。每个 profile 一行；skills 以 JSON 存储，因为它是整体读写、无需按字段查询。
CREATE TABLE IF NOT EXISTS skill_profile (
  id                    TEXT PRIMARY KEY,
  profile_id            TEXT NOT NULL UNIQUE REFERENCES learner_profile(id) ON DELETE CASCADE,
  skills                TEXT NOT NULL,
  dimensions            TEXT NOT NULL DEFAULT '[]',
  weaknesses            TEXT NOT NULL DEFAULT '[]',
  recommendations       TEXT NOT NULL DEFAULT '[]',
  unassessed_notices    TEXT NOT NULL DEFAULT '[]',
  based_on_diagnostic   TEXT,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_plan (
  id                  TEXT PRIMARY KEY,
  profile_id          TEXT NOT NULL REFERENCES learner_profile(id) ON DELETE CASCADE,
  plan_date           TEXT NOT NULL,
  available_minutes   INTEGER NOT NULL,
  planned_for_minutes INTEGER NOT NULL,
  generated_by        TEXT NOT NULL,
  revision_count      INTEGER NOT NULL DEFAULT 0,
  notes               TEXT NOT NULL DEFAULT '[]',
  warnings            TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(profile_id, plan_date)
);
CREATE INDEX IF NOT EXISTS idx_plan_profile_date ON daily_plan(profile_id, plan_date DESC);

CREATE TABLE IF NOT EXISTS study_task (
  id                TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL REFERENCES daily_plan(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  skill             TEXT NOT NULL,
  priority          TEXT NOT NULL,
  title             TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL,
  content_ref       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  completed_at      TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_plan ON study_task(plan_id, sort_order);

-- 跨日的未完成任务归属。用于"补做昨天没做的核心任务"。
CREATE INDEX IF NOT EXISTS idx_task_status ON study_task(status, completed_at);

CREATE TABLE IF NOT EXISTS study_session (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL REFERENCES learner_profile(id) ON DELETE CASCADE,
  task_id           TEXT REFERENCES study_task(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
  skill             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT NOT NULL,
  duration_minutes  INTEGER NOT NULL,
  correct_count     INTEGER NOT NULL DEFAULT 0,
  total_count       INTEGER NOT NULL DEFAULT 0,
  score             REAL NOT NULL DEFAULT 0,
  feedback_summary  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_session_profile_time ON study_session(profile_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS answer_attempt (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES learner_profile(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES study_task(id) ON DELETE SET NULL,
  content_item_id TEXT NOT NULL,
  answer_text     TEXT,
  choice_id       TEXT,
  correct         INTEGER NOT NULL DEFAULT 0,
  score           REAL NOT NULL DEFAULT 0,
  feedback        TEXT NOT NULL DEFAULT '',
  error_tags      TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_profile_time ON answer_attempt(profile_id, created_at DESC);

-- 复习队列。Phase 1 只按 due_on 做确定性到期排序；
-- stability/difficulty/reps/lapses 为 ts-fsrs 预留，接入时无需迁移 schema。
CREATE TABLE IF NOT EXISTS review_item (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL REFERENCES learner_profile(id) ON DELETE CASCADE,
  content_item_id   TEXT NOT NULL,
  content_ref       TEXT NOT NULL,
  skill             TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  due_on            TEXT NOT NULL,
  stability         REAL NOT NULL DEFAULT 0,
  difficulty        REAL NOT NULL DEFAULT 0,
  reps              INTEGER NOT NULL DEFAULT 0,
  lapses            INTEGER NOT NULL DEFAULT 0,
  last_reviewed_on  TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(profile_id, content_item_id)
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_item(profile_id, due_on);

-- ---------------------------------------------------------------------------
-- 真题试卷索引（Phase 2）
--
-- 设计取舍：试卷**正文不落库**。正文以规范化包（private-content 下的
-- 目录 + manifest + 音频）作为规范来源，SQLite 只保存"索引 + 来源 + 版本 +
-- 校验和 + 题目/资产的可引用标识"。
--
-- 理由：
-- 1. 正文体量大（含长文与音频元数据），且天然按整卷读写，SQLite 的强项不是长文本存储。
-- 2. 正文需要被人审阅、被 diff、被外部工具重写 —— 文件比数据库行更适合这一用途。
-- 3. 但**可引用性必须落库**：未来的作答记录要外键引用试卷/题目，跨版本的内容更新
--    必须能被拦截（见 content_version 与 manifest_checksum）。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_paper (
  id                  TEXT PRIMARY KEY,
  exam_type           TEXT NOT NULL,
  exam_year           INTEGER NOT NULL,
  session             TEXT NOT NULL,
  variant             TEXT NOT NULL,
  exam_date           TEXT,
  source_kind         TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  provenance_note     TEXT NOT NULL,
  provenance_ref      TEXT,
  verification_note   TEXT,
  -- 内容版本：实质变化时必须递增。历史作答靠它区分"同一个题目 id 的不同版本"。
  content_version     INTEGER NOT NULL,
  partial             INTEGER NOT NULL DEFAULT 0,
  package_path        TEXT NOT NULL,
  manifest_checksum   TEXT NOT NULL,
  -- 印出内容的规范指纹。与 manifest_checksum 分工：
  -- 本列判"这是不是同一版内容"（元数据变更不影响它）；
  -- manifest_checksum 判"文件是否被改动过"。
  -- 判据拆开的原因：只改 provenance/验证说明时整包校验和会变，
  -- 用它判内容会误判为"内容实质变化"并强制升版本 —— 而升版本会错误地
  -- 暗示内容变成了另一版。可为 NULL：早期导入的行没有该值。
  content_fingerprint TEXT,
  section_count       INTEGER NOT NULL,
  question_count      INTEGER NOT NULL,
  imported_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- 同一年同一场次的同一套卷只能有一条：阻止"换个 id 再导入一遍"
  UNIQUE(exam_type, exam_year, session, variant)
);
CREATE INDEX IF NOT EXISTS idx_paper_year_session ON exam_paper(exam_year DESC, session);

-- 资产只存元数据与包内相对路径。绝不存绝对路径，也绝不存字节内容。
CREATE TABLE IF NOT EXISTS paper_asset (
  paper_id      TEXT NOT NULL REFERENCES exam_paper(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  checksum      TEXT NOT NULL,
  label         TEXT,
  PRIMARY KEY (paper_id, id)
);

-- 试卷的**学习策略状态**（训练池 / 模考保留）。
-- 刻意与 exam_paper 分表：重新导入内容（版本升级）绝不能重置用户的选择。
CREATE TABLE IF NOT EXISTS paper_study_state (
  paper_id   TEXT PRIMARY KEY REFERENCES exam_paper(id) ON DELETE CASCADE,
  pool       TEXT NOT NULL DEFAULT 'training',
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Expert Training 事实台账（V1）
--
-- 分层遵循 content-policy/LEARNING_MODEL.md 第 1 节：观测 ≠ 解释。
--   learning_run        —— 一次真实真题阅读训练会话（范围：试卷 + 内容版本 + 大题）
--   performance_event   —— 不可变的**观测**：学习者做了什么、结果判定是什么
--   assessment_event    —— 可版本化的**评分结果**：重评时追加，绝不覆盖
--   evidence_projection —— 可重建的低层派生信号（answer.correct / answer.incorrect）
--
-- 三条硬规则（由本文件的触发器与架构门禁共同守护）：
-- 1. **只追加**：performance_event / assessment_event 不得 UPDATE 或 DELETE。
-- 2. **因果不落观测**：PerformanceEvent 里不写"因为…""说明他…"这类措辞，
--    因此表结构里**没有** mechanism / weakness / error_tag / diagnosis 之类字段。
--    机制判断属于后续阶段的 MechanismHypothesis，不是观测事实。
-- 3. **引用稳定**：用 paper_id + content_version + section_id + group_id + question_id
--    指向具体一道真题 —— 内容升版后旧事件仍指向它当时的那一版，不会被静默改指向。
-- ---------------------------------------------------------------------------

-- 一次训练会话。范围刻意是"试卷的某个阅读大题"：
-- 它同时是可达的训练单元（可在一段时间内做完）与可解释的证据范围。
CREATE TABLE IF NOT EXISTS learning_run (
  id               TEXT PRIMARY KEY,
  profile_id       TEXT NOT NULL REFERENCES learner_profile(id),
  paper_id         TEXT NOT NULL REFERENCES exam_paper(id),
  -- 事件发生时的内容版本。内容升版后，旧 run 的事实仍指向旧版本。
  content_version  INTEGER NOT NULL,
  section_id       TEXT NOT NULL,
  section_type     TEXT NOT NULL,
  -- 本 run 覆盖的题组 id（内容升版可能增删题组，因此按当时实际作答记录）。
  group_ids        TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'in_progress',
  item_count       INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  submitted_at     TEXT,
  duration_seconds INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_profile_time ON learning_run(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_paper_section ON learning_run(paper_id, content_version, section_id);

-- 注意：部分唯一索引 uniq_run_single_in_progress **不在这里**。
-- 它要求先归一化历史脏数据才能建立（见 INVARIANT_STATEMENTS）：
-- 早先的查询缺陷会让同键积累出多条 in_progress 行，直接建索引会抛
-- UNIQUE constraint failed，而那发生在建库阶段 → 整个库打不开。

-- 不可变观测。**一行 = 一次作答判定**，不含任何因果解释。
CREATE TABLE IF NOT EXISTS performance_event (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES learning_run(id),
  profile_id       TEXT NOT NULL REFERENCES learner_profile(id),
  -- 稳定真实引用：这五项合起来唯一确定"当时的那一道题"。
  paper_id         TEXT NOT NULL,
  content_version  INTEGER NOT NULL,
  section_id       TEXT NOT NULL,
  group_id         TEXT NOT NULL,
  question_id      TEXT NOT NULL,
  question_number  INTEGER,
  question_kind    TEXT NOT NULL,
  -- 作答形态与内容：choice = 选项 id；blank = 选词填空词；paragraph = 匹配段落标号。
  response_kind    TEXT NOT NULL,
  response_value   TEXT,
  -- skipped：未作答（留空）。它**不是** incorrect —— 没有证据与答错是两件事。
  outcome          TEXT NOT NULL,
  -- 计时：可靠测量到才有值；未测到为 NULL，不猜。
  duration_seconds INTEGER,
  -- 改过答案（真实观测到才置 1）；首次作答 / 复习作答的证据价值不同。
  answer_changed   INTEGER NOT NULL DEFAULT 0,
  attempt_kind     TEXT NOT NULL DEFAULT 'first_attempt',
  grading_source   TEXT NOT NULL,
  grading_version  TEXT NOT NULL,
  sequence         INTEGER NOT NULL DEFAULT 0,
  occurred_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_run ON performance_event(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_perf_profile_time ON performance_event(profile_id, occurred_at DESC);
-- 按"哪道题"回看历史：内容版本必须参与，否则升版后两个版本会混成一条。
CREATE INDEX IF NOT EXISTS idx_perf_question
  ON performance_event(paper_id, content_version, section_id, group_id, question_id);

-- 评分结果可版本化：同一次作答被重新评价时**追加**一条，保留原有那条。
CREATE TABLE IF NOT EXISTS assessment_event (
  id                    TEXT PRIMARY KEY,
  performance_event_id  TEXT NOT NULL REFERENCES performance_event(id),
  rubric_version        TEXT NOT NULL,
  outcome               TEXT NOT NULL,
  score                 REAL NOT NULL DEFAULT 0,
  grading_source        TEXT NOT NULL,
  -- 若本条取代了某条旧评估，记下它的 id（旧的那条仍在表里，不被删除）。
  supersedes_id         TEXT REFERENCES assessment_event(id),
  note                  TEXT,
  assessed_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessment_perf ON assessment_event(performance_event_id, assessed_at);

-- 低层派生信号的可重建投影。
-- 它不是真相来源：删空这张表后可由 performance_event 完整重算（见 services/expert-training）。
-- 之所以落库而不每次现算：Today 与画像要按 profile 快速读取聚合值。
CREATE TABLE IF NOT EXISTS evidence_projection (
  profile_id   TEXT NOT NULL REFERENCES learner_profile(id),
  signal       TEXT NOT NULL,
  value        INTEGER NOT NULL DEFAULT 0,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, signal)
);

-- 只追加守护：不可变历史不得被就地改写或删除。
-- 触发器而非仅靠应用层约定 —— 约定拦不住直接执行的 SQL（含迁移脚本、调试工具）。
CREATE TRIGGER IF NOT EXISTS performance_event_append_only_update
BEFORE UPDATE ON performance_event
BEGIN
  SELECT RAISE(ABORT, 'performance_event 是只追加的不可变观测，不允许 UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS performance_event_append_only_delete
BEFORE DELETE ON performance_event
BEGIN
  SELECT RAISE(ABORT, 'performance_event 是只追加的不可变观测，不允许 DELETE');
END;

CREATE TRIGGER IF NOT EXISTS assessment_event_append_only_update
BEFORE UPDATE ON assessment_event
BEGIN
  SELECT RAISE(ABORT, 'assessment_event 是只追加的评分历史，不允许 UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS assessment_event_append_only_delete
BEFORE DELETE ON assessment_event
BEGIN
  SELECT RAISE(ABORT, 'assessment_event 是只追加的评分历史，不允许 DELETE');
END;

-- ---------------------------------------------------------------------------
-- 课程层（Course Layer，V1 基础）
--
-- 三张表，与 Expert 台账**完全平行、互不写入**：
--
--   course_package        —— 课程包索引（正文不落库，与 exam_paper 同一哲学）
--   course_canonical_link —— 人工核验过的"课程段 → 规范真题位置"链接
--   course_exposure_event —— 只追加的课程曝光观测
--
-- 三条不可越界的语义（见 content-policy/LEARNING_MODEL.md）：
--
-- 1. **课程层不是第二个题库。** CET-6 的规范真相完全留在
--    「exam_paper」+ Expert 台账里。课程段只能**指向**真题位置，
--    永不携带题目、答案或判分结论。
-- 2. **课程曝光 ≠ 表现证据。** 「course_exposure_event」里没有任何
--    correct/incorrect/score/mastery/mechanism 字段，本阶段也没有任何代码
--    把曝光写进 performance_event / assessment_event / evidence_projection /
--    skill_profile / answer_attempt。这条由服务层与架构门禁双重守护。
-- 3. **未匹配是合法状态。** 一条课程段可以永远没有 canonical 链接。
--    因此这里**没有**外键从 course_package 指回 exam_paper，
--    也没有任何"必须匹配"的约束 —— 3 号表的存在本身就是这条语义的载体。
--
-- **曝光事件刻意不带 canonical 外键**（这是本设计最关键的一处）：
-- 一段课程材料完全可能在"还不知道它对应哪道真题"的时候就被学过了。
-- 若把 canonical 目标写进曝光主身份，那段历史就永久无法在两周后人工核验出
-- 对应关系时被**回溯投影**到那道真题上 —— 信息在那时被丢弃了。
-- 因此曝光只引用 (profile, course, segment, 当时看到的内容版本)，
-- 链接关系留在 course_canonical_link，投影在后续阶段做。
--
-- 同样刻意**没有** course_id → course_package(id) 的外键：那会造出一个
-- 两难 —— ON DELETE CASCADE 让"删掉课程包索引"顺手销毁曝光历史（违反只追加），
-- ON DELETE RESTRICT 又让索引无法移除。曝光的正确语义是"这件事发生过"，
-- 它引用的是一个**标识**，不是一行会被清理的索引记录。
-- 对 profile 的外键保留（与 performance_event 一致）：没有学习者就没有观测。
-- ---------------------------------------------------------------------------

-- 课程包索引。**只有索引与版本事实，没有正文**：
-- 正文（讲义文本、PDF/DOCX、MP3）的规范来源是 private-content/courses 下的包。
CREATE TABLE IF NOT EXISTS course_package (
  id                  TEXT PRIMARY KEY,
  -- provider 是自由字符串而不是枚举：首个 provider 是一个商业课程品牌，
  -- 但把它做成 CHECK 约束会把"再来一个 provider"变成一次 schema 迁移。
  provider            TEXT NOT NULL,
  edition             TEXT,
  title               TEXT NOT NULL,
  -- 内容版本：**语义内容**变化时才递增。
  -- 只改 rightsNote / provider / edition 这类声明不得涨版本 ——
  -- 涨版本会让所有已核验链接无谓地变成 stale。
  content_version     INTEGER NOT NULL,
  provenance_note     TEXT NOT NULL,
  provenance_ref      TEXT,
  -- 权利说明：这份付费材料为何可以合法保存在本机。必填。
  rights_note         TEXT NOT NULL,
  -- 包目录相对于课程根（private-content/courses）的路径。
  -- **绝不存绝对路径** —— 便携清单与数据库行都不该泄漏本机路径。
  package_path        TEXT NOT NULL,
  -- course.json 的 sha256：判"文件是否被改动过"。
  manifest_checksum   TEXT NOT NULL,
  -- 规范内容指纹：判"这是不是同一版内容"（元数据变更不影响它）。
  content_fingerprint TEXT,
  material_count      INTEGER NOT NULL,
  segment_count       INTEGER NOT NULL,
  asset_count         INTEGER NOT NULL,
  asset_bytes         INTEGER NOT NULL,
  -- 资产清单，以 JSON 存储（id / kind / relativePath / mimeType / bytes / checksum）。
  --
  -- 为什么不单开一张 course_asset 表（与 paper_asset 的差异是**有意的**）：
  -- 试卷资产要按 (paper_id, asset_id) 单独解析磁盘路径去流式播放音频，
  -- 因此必须可被外键引用、可被单独查询。课程正文在本阶段**没有服务路径**
  -- （无 UI、无播放），资产清单只是"这个包声明了哪些文件、校验和是什么"，
  -- 整体读写、无需按字段查询 —— 正是 JSON 列适用的形态。
  -- 为一个当前无人查询的集合建表 + 索引，属于"未来可能有"的空结构。
  -- 若后续阶段需要按资产查询，那时加表是纯增量迁移。
  asset_index         TEXT NOT NULL DEFAULT '[]',
  imported_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_course_provider ON course_package(provider, title);

-- 课程段 → 规范真题位置的链接。**只有人工核验过的链接能成为运行时链接。**
--
-- 为什么用一张表 + scope 判别字段，而不是 section/group/question 三张链接表：
-- 三张表让"同一段同时链到大题与某道题"变成可表达的状态，
-- 那是无意义且必然漂移的状态。这里 scope 决定哪些标识必须非空。
CREATE TABLE IF NOT EXISTS course_canonical_link (
  -- 主键是**由声明身份确定性推导**出来的（见 repositories 的 linkIdentity），
  -- 而不是随机 UUID。理由：同一份声明被复核两次（CLI 重跑、包重新导入）
  -- 必须是**幂等**的，而随机 id 会让每次重跑都追加一条一模一样的链接。
  -- 用确定性 id + 「ON CONFLICT(id) DO NOTHING」，幂等性就落在数据库层，
  -- 而不是靠"记得先查一下"（那是 check-then-act）。
  --
  -- 身份里**包含 verification_status**，因此同一目标的候选与被核验版本
  -- 是两行、都保留 —— "这条曾经只是候选，后来被人工核验"这段审计线索不会丢。
  id                    TEXT PRIMARY KEY,
  -- course_id / paper_id 刻意**不是外键**（对照：exposure 同样如此）。
  --
  -- 用外键会产生一个两难：ON DELETE CASCADE 让"删掉课程包或试卷索引"
  -- 顺手销毁人工复核记录（那是**历史审计事实**，而「容器状态可以变，
  -- 历史事实不能改」直接冲突）；ON DELETE RESTRICT 又让索引维护被历史记录
  -- 卡死。两者都不可接受。
  --
  -- 正确做法与 performance_event / course_exposure_event 一致：
  -- 这里存的是**标识**，不是"一行会被清理的记录"。目标是否还在索引中
  -- 由 「isLinkRuntimeUsable」 在读取时按当前索引重算 —— fail-closed，
  -- 而且**不销毁任何历史复核记录**。由 tests/course-link.test.ts 固定。
  course_id             TEXT NOT NULL,
  segment_id            TEXT NOT NULL,
  -- 复核时的课程内容版本。包升版后本行即 STALE（不再可用），原样保留为历史。
  course_content_version INTEGER NOT NULL,

  -- 规范目标：始终指向某个真题大题的上下文。
  paper_id              TEXT NOT NULL,
  -- 复核时的真题内容版本。卷子升版后本行即 STALE —— **绝不自动跟着升级**：
  -- 那会把一次人工复核静默套用到它从未被复核过的新内容上。
  paper_content_version INTEGER NOT NULL,
  section_id            TEXT NOT NULL,
  group_id              TEXT,
  question_id           TEXT,

  -- section / group / question（见 domain/course.ts 的 COURSE_LINK_TARGET_SCOPES）
  target_scope          TEXT NOT NULL,
  -- verified / candidate / rejected。
  -- candidate 与 rejected **可以落库**（保留"这条为什么没被采用"的审计线索），
  -- 但运行时读取一律过滤掉 —— 判据集中在 domain/course.ts 的 isLinkRuntimeUsable。
  verification_status   TEXT NOT NULL,
  -- 核验/审计引用：谁、依据什么材料、什么时候核验的。已核验时必填。
  verification_ref      TEXT NOT NULL,
  note                  TEXT,
  created_at            TEXT NOT NULL
  -- **没有 UNIQUE(segment_id)**：同一段允许存在多条历史链接
  -- （不同目标、不同版本、被否决的候选）。那正是"重新核验"的载体 ——
  -- 删旧行会销毁历史复核记录，而本层明确拒绝销毁历史。
  -- 幂等性由上面的确定性主键承担。
);
CREATE INDEX IF NOT EXISTS idx_course_link_segment ON course_canonical_link(course_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_course_link_target
  ON course_canonical_link(paper_id, paper_content_version, section_id);

-- 运行时链接查询的支撑索引：只覆盖 verified，因为那才是运行时读取的集合。
CREATE INDEX IF NOT EXISTS idx_course_link_verified
  ON course_canonical_link(course_id, course_content_version, segment_id)
  WHERE verification_status = 'verified';

-- ---------------------------------------------------------------------------
-- 人工复核记录**只追加**：course_canonical_link 的每一行都是
-- 一条**不可变的复核主张**（"某年某月某人核验过这条对应关系"）。
--
-- 为什么必须由数据库阻断 UPDATE/DELETE，而不是只靠"仓储不提供方法"：
-- 同样的理由已经在 performance_event / assessment_event /
-- course_exposure_event 上成立 —— 仓储层的缺失挡不住直接执行的 SQL
-- （迁移脚本、调试工具、未来的调用方）。
--
-- 复核记录的可信度**完全来自它的不可变性**：如果一条"已核验"的行可以被
-- 就地改写成另一个出处或另一个目标，那么"谁核验了什么"就不再可审计，
-- 整条 canonical 链接链路的证据价值归零。
--
-- 修正的正确途径是**追加**一条新的复核行（见 domain/course.ts 的
-- 语义目标去重说明），而不是改写旧行。
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS course_canonical_link_append_only_update
BEFORE UPDATE ON course_canonical_link
BEGIN
  SELECT RAISE(ABORT, 'course_canonical_link 是不可变的人工复核记录，不允许 UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS course_canonical_link_append_only_delete
BEFORE DELETE ON course_canonical_link
BEGIN
  SELECT RAISE(ABORT, 'course_canonical_link 是不可变的人工复核记录，不允许 DELETE');
END;

-- 课程曝光：**只追加**的学习者观测。
--
-- 它回答的是"学习者见过/学过这段课程材料"，**不是**"学习者会做这道题"。
-- 因此本表里刻意**没有** outcome / score / correct / mastery / mechanism /
-- diagnosis / error_tag / question_id 这些列 —— 见 COURSE_EXPOSURE_FORBIDDEN_FIELDS。
-- 一旦这些字段出现，课程曝光会立刻被下游当成表现证据使用。
CREATE TABLE IF NOT EXISTS course_exposure_event (
  id                    TEXT PRIMARY KEY,
  profile_id            TEXT NOT NULL REFERENCES learner_profile(id),
  course_id             TEXT NOT NULL,
  segment_id            TEXT NOT NULL,
  -- 学习者**当时实际看到的那一版**课程内容。课程升版后旧曝光仍指向旧版本 ——
  -- 与 performance_event 的 content_version 是同一条纪律。
  course_content_version INTEGER NOT NULL,
  -- 事件种类描述"发生了什么"，不描述"为什么"。
  event_type            TEXT NOT NULL,
  occurred_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_course_exposure_profile_time
  ON course_exposure_event(profile_id, occurred_at DESC);
-- 按"哪一段"回看历史：内容版本必须参与，否则升版后两个版本会混成一条。
CREATE INDEX IF NOT EXISTS idx_course_exposure_segment
  ON course_exposure_event(course_id, course_content_version, segment_id);

-- 只追加守护：**由数据库本身保证，不是应用层约定**（与 performance_event 同一条理由：
-- 约定拦不住直接执行的 SQL —— 迁移脚本、调试工具、未来的调用方）。
CREATE TRIGGER IF NOT EXISTS course_exposure_event_append_only_update
BEFORE UPDATE ON course_exposure_event
BEGIN
  SELECT RAISE(ABORT, 'course_exposure_event 是只追加的课程曝光观测，不允许 UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS course_exposure_event_append_only_delete
BEFORE DELETE ON course_exposure_event
BEGIN
  SELECT RAISE(ABORT, 'course_exposure_event 是只追加的课程曝光观测，不允许 DELETE');
END;
`;

/**
 * 增量迁移。
 *
 * 每个条目是"把 schema 从 from 版本升到 to 版本需要执行的语句"。
 * - `ALTER TABLE ... ADD COLUMN` 是幂等且不丢数据的（执行前会检查列是否存在）。
 * - 数据归一化用 UPDATE，天然幂等。
 */
export const MIGRATIONS: Array<{ from: number; to: number; description: string; statements: string[] }> = [
  {
    from: 1,
    to: 2,
    description: "daily_plan 增加 warnings 列：planner 生成的时间不足提示此前被丢弃，用户在 Today 看不到",
    statements: ["ALTER TABLE daily_plan ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'"],
  },
  {
    from: 2,
    to: 3,
    description:
      "归一化错误的默认考试日期 2026-12-19 → 官方日期 2026-12-12。" +
      "2026-12-19 从来不是真实 CET 考试日，因此只可能是此前版本写入的默认值，不是用户主动选择的日期",
    statements: [
      "UPDATE exam_goal SET exam_date = '2026-12-12', updated_at = datetime('now') WHERE exam_date = '2026-12-19'",
    ],
  },
  {
    from: 3,
    to: 4,
    description:
      "skill_profile 增加 unassessed_notices 列：未评估模块（听力）的说明此前无处存放，" +
      "导致它只能被当成普通弱项或被静默丢弃",
    statements: ["ALTER TABLE skill_profile ADD COLUMN unassessed_notices TEXT NOT NULL DEFAULT '[]'"],
  },
  {
    from: 4,
    to: 5,
    description:
      "新增真题试卷索引表（exam_paper / paper_asset / paper_study_state）。" +
      "这三张表是纯新增，不改动也不删除任何 Phase 1 的用户数据 —— " +
      "试卷正文仍以 private-content 下的规范化包为规范来源，库里只做索引与可引用标识",
    statements: [],
  },
  {
    from: 5,
    to: 6,
    description:
      "exam_paper 增加 content_fingerprint 列：导入判据原先只看整包校验和，" +
      "于是只改 provenance / 验证说明这类元数据也会被误判为『内容实质变化』并强制递增 " +
      "contentVersion —— 而那会错误地暗示内容是另一版。拆开后：内容指纹判内容、" +
      "整包校验和判文件改动。历史行该列为 NULL，由下次导入补写",
    statements: ["ALTER TABLE exam_paper ADD COLUMN content_fingerprint TEXT"],
  },
  {
    from: 6,
    to: 7,
    description:
      "新增 Expert Training 事实台账（learning_run / performance_event / assessment_event / " +
      "evidence_projection）与只追加守护触发器，以及 schema 版本单调性触发器。" +
      "四张表纯新增，不改动也不删除任何既有数据；" +
      "performance_event / assessment_event 的 UPDATE/DELETE 由触发器阻断 —— " +
      "不可变观测与评分历史只允许追加，重新评分追加新评估而不覆盖旧记录",
    statements: [],
  },
  {
    from: 7,
    to: 8,
    description:
      "learning_run 增加部分唯一索引 uniq_run_single_in_progress：" +
      "同一 (profile, paper, 内容版本, 大题) 至多一个进行中会话。" +
      "修复「再练一次」后的状态错乱 —— 早先的查询让已完成会话优先于进行中会话，" +
      "导致新会话在 UI 上不可见；索引从数据库层再保证一层" +
      "「不会积累孤儿进行中会话」。已完成的历史会话不受约束（可反复练同一份材料）。" +
 "该索引要求先归一化历史脏数据，因此在 INVARIANT_STATEMENTS 中执行",
    statements: [],
  },
  {
    from: 8,
    to: 9,
    description:
      "新增课程层（Course Layer）三张表：course_package（课程包索引，正文不落库）、" +
      "course_canonical_link（人工核验过的『课程段 → 规范真题位置』链接）、" +
      "course_exposure_event（只追加的课程曝光观测），以及曝光的 UPDATE/DELETE 阻断触发器。" +
      "三张表**纯新增**：不改动、不删除、不重写任何既有行，也不触碰 exam_paper / " +
      "learning_run / performance_event / assessment_event / evidence_projection —— " +
      "课程层与 Expert 台账完全平行、互不写入。" +
      "course_exposure_event 里刻意没有 outcome/score/mastery/mechanism 之类字段：" +
      "课程曝光（看过材料）不是表现证据（独立作答），这条区分由表结构与门禁共同守护。" +
      "该迁移只依赖 CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS，天然幂等",
    statements: [],
  },
];

/**
 * 结构不变量：在**迁移之后**执行，幂等。
 *
 * 与 `SCHEMA_SQL` 的分工：那里是"表与列的形态"，这里是
 * "需要先整理数据才能成立的结构约束"。
 *
 * 为什么必须放在这一层：早先的查询缺陷（已完成优先）会让用户
 * 反复点"再练一次"却看不到新会话，从而真实积累出**同键多条 in_progress** 行。
 * 在这种库上直接建唯一索引会抛 `UNIQUE constraint failed`，
 * 而它发生在建库阶段 —— 后果是**整个库打不开**，比它要修的问题严重得多。
 * 因此先归一化（把让位的行标为 `abandoned`，不删数据），再建索引。
 *
 * 调用方必须把它与 `SCHEMA_SQL` + 迁移包在同一事务里（见 client.ts），
 * 失败时整体回滚，不留半迁移状态。
 */
export const INVARIANT_STATEMENTS: Array<{ description: string; statements: string[] }> = [
  {
    description:
      "归一化历史遗留的重复进行中会话，再建立 uniq_run_single_in_progress。" +
      "归一化只改状态不删数据：被让位的会话标为 abandoned —— " +
      "它本来就没有观测（观测只在交卷时写入），因此没有任何事实被改写",
    statements: [
      // 每 (profile, paper, 版本, 大题) 只保留最新创建的一条 in_progress，其余让位。
      // 用窗口函数而非相关子查询：语义直白，且 SQLite 原生支持。
      `UPDATE learning_run SET status = 'abandoned'
       WHERE status = 'in_progress'
         AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY profile_id, paper_id, content_version, section_id
               ORDER BY created_at DESC, id DESC
             ) AS rn
             FROM learning_run
             WHERE status = 'in_progress'
           ) WHERE rn = 1
         )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_run_single_in_progress
         ON learning_run(profile_id, paper_id, content_version, section_id)
         WHERE status = 'in_progress'`,
    ],
  },
];
