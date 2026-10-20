/**
 * 本机目录选取器（owner-facing folder chooser）—— **Windows 原生对话框**。
 *
 * ── 它解决的产品问题 ──
 *
 * A1 的第一步是"选一个本机课程目录"。此前这件事只能靠 CLI 参数
 * （`--source <dir>`）完成 —— 也就是要求 使用者 复制粘贴一条绝对路径。
 * 但那正是这条流水线一直缺的那个入口：**非工程人员走不完第一步**。
 *
 * ── 为什么是原生对话框，而不是浏览器端的目录选择 ──
 *
 * 浏览器侧的 `showDirectoryPicker()`（File System Access API）在这一档
 * 需求上不成立，理由是实测的规范事实而不是偏好：
 *
 * | 判据 | 事实 | 对本产品的后果 |
 * | --- | --- | --- |
 * | 安全上下文 | MDN：**只在 secure context（HTTPS）可用** | 本工作台是 `http://127.0.0.1:<port>`，**不是** secure context |
 * | 基线可用性 | MDN：**not Baseline**，"does not work in some of the most widely-used browsers" | 不能作为唯一入口 |
 * | 返回什么 | 它返回 `FileSystemDirectoryHandle`——**句柄**，不是路径 | 而流水线要的是**本机路径**（Node 侧读盘）；句柄无法交给 Node |
 * | 文字层 | 需要**逐字节**读 PDF 字节做文本抽取 | 只能经 File 对象走浏览器，等于把私有材料搬进浏览器进程 |
 *
 * 最后两条是关键：本产品需要的是"**Node 进程**能按路径读源件"，
 * 而浏览器 API 的设计目标是"**页面**能在用户授权下访问文件"。
 * 两者不是同一个能力，硬凑会得到一个把私有材料绕经浏览器的架构 ——
 * 那比现在这条路更差。
 *
 * 因此选择操作系统原生对话框：它**只把路径交回本地 Node 进程**，
 * 材料字节从头到尾不经过浏览器，也不经过任何网络。
 *
 * ── 平台事实（本项目实测，不是推测）──
 *
 * | 事实 | 实测值 |
 * | --- | --- |
 * | 可用宿主 | `C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`（5.1.26100） |
 * | `pwsh`（PowerShell 7） | **未安装** ⇒ 不能依赖它 |
 * | .NET 运行时 | **.NET Framework 4.8.9345.0**（不是 .NET Core） |
 * | `-STA` 是否已被应用 | 是（`Thread.ApartmentState == STA`） |
 *
 * 这条组合恰好是**必要**的：Microsoft 的 `FolderBrowserDialog.ShowNewFolderButton`
 * 文档明确写着 ".NET Core 3.1 and later … the button is shown **regardless of
 * this property**"。也就是说在 PowerShell 7 / .NET Core 上**关不掉**"新建文件夹"。
 * 而 Windows PowerShell 5.1 跑在 .NET Framework 上，那个属性**被尊重**
 * （实测 `ShowNewFolderButton = $false` 后读回 `False`）。
 *
 * 因此本模块刻意绑定 `powershell.exe`（Windows PowerShell），
 * 并把"新建文件夹按钮必须关掉"当作一条**可核对的运行时事实**上报
 * （见 `FolderPickerOutcome.newFolderButtonHidden`）。
 *
 * ── 安全模型（每一条都有具体威胁）──
 *
 * | 措施 | 防的是什么 |
 * | --- | --- |
 * | 脚本是**固定常量**，不接受任何参数 | **绝不把用户数据插进 shell** —— 没有插值就没有注入面 |
 * | 用 `-EncodedCommand`（UTF-16LE base64）传递脚本 | 绕开 cmd/PowerShell 的引号与转义规则（Windows 上它们极易出错） |
 * | 起始目录经**子进程环境变量**传入（不是命令行） | 环境变量不经过任何 shell 解析；且它只是"从哪开始看" |
 * | `spawn` 用参数数组，**绝不** `shell: true` | 参数不会被交给 `cmd.exe` 解析 |
 * | 路径经 base64(UTF-8) 回传 | 中文/空格/引号目录名不会在路上被截断或解释 |
 * | 输出里**只有**那一行协议行被读取 | 子进程的其它输出（含 PowerShell 的 progress CLIXML）一律丢弃 |
 * | 结果**绝不**进日志、**绝不**进 HTTP 响应 | 绝对路径是本机布局信息（由调用方负责，见 §"调用方的义务"） |
 * | 单飞（同时只有一个对话框） | 并发请求不会弹出多个模态窗口把桌面锁住 |
 * | 硬超时（默认 5 分钟）+ 到点杀子进程 | 一个卡住的对话框不会永久占住一个隐藏子进程 |
 *
 * ── 调用方的义务（这个模块**不能**替调用方做的事）──
 *
 * 它返回一个**绝对路径**。调用方必须：
 *
 * 1. **绝不**把它写进任何响应体、HTML、日志或错误消息；
 * 2. 只把它当作 Node 侧读盘的输入，用完即弃（内存里）；
 * 3. 在比对时用**规范化后**的路径（Windows 大小写与分隔符不敏感）。
 *
 * 由 `tests/course-a1-workbench.test.ts` 与 `scripts/course-a1-workbench-proof.ts`
 * 分别从源码层与真实进程层守护。
 */

import { spawn } from "node:child_process";

/** 目录选取器可能出现的结局。**每一种都有独立的处置**。 */
export const FOLDER_PICKER_OUTCOMES = [
  /** 用户选了一个目录。 */
  "selected",
  /** 用户取消（关掉对话框或按取消）。**不是错误**。 */
  "cancelled",
  /** 平台不支持（非 Windows / 找不到 Windows PowerShell）。 */
  "unsupported_platform",
  /** 对话框起不来（组件缺失、被策略挡掉、桌面会话不可用）。 */
  "dialog_unavailable",
  /** 超时未选择 ⇒ 子进程被杀。 */
  "timeout",
] as const;
export type FolderPickerOutcome = (typeof FOLDER_PICKER_OUTCOMES)[number];

export interface FolderPickerResult {
  outcome: FolderPickerOutcome;
  /**
   * 选中的**绝对路径**。**只有 `outcome === "selected"` 时非 null。**
   *
   * ── 这是敏感值 ──
   *
   * 它泄漏本机目录布局（盘符、用户名、私有材料位置）。调用方**必须**
   * 遵守上面 §"调用方的义务"：绝不落盘、绝不进日志、绝不下发。
   */
  path: string | null;
  /** 人话原因（中文，面向 使用者）。`selected` / `cancelled` 时为简短说明。 */
  detail: string;
  /**
   * **运行时事实**：这个宿主是否真的关掉了"新建文件夹"。
   *
   * ── 为什么它必须被上报，而不是假设 ──
   *
   * Microsoft 文档说 .NET Core 3.1+ **无视** `ShowNewFolderButton`。
   * 也就是说"关掉它"这件事**取决于宿主运行时**，而宿主可能变
   * （将来装了 PowerShell 7、或换成 .NET Core 的宿主）。
   * 与其写一句"我们设了 false"就当作成立，不如把**读回的值**如实上报：
   * 它不是 `true` 时，人就知道这个宿主没兑现约束。
   *
   * 只有 `selected` / `cancelled`（即对话框真的起来过）时才有值。
   */
  newFolderButtonHidden: boolean | null;
}

/**
 * 子进程协议标记。
 *
 * 协议行形如：`CET6PICKER\t<outcome>\t<base64(utf8(status-line))>\t<nofolder>`
 * 用制表符分隔（目录名可能含空格，因此不能用空格分隔）。
 */
const PROTOCOL_MARKER = "CET6PICKER";

/**
 * 传给子进程的起始目录环境变量名。
 *
 * ── 为什么走环境变量而不是命令行参数 ──
 *
 * 命令行参数要经过 cmd / PowerShell 的引号规则（而 Windows 上反斜杠不是
 * 转义字符，这条规则极易写错）。环境变量**不经过任何 shell 解析**，
 * 因此"路径里有引号/`$()`/分号"这件事在这里不构成问题。
 *
 * 即便如此，本模块仍然把它当**不可信输入**：它只被赋给
 * `SelectedPath`，不参与任何字符串拼接、不被求值。
 */
const START_DIR_ENV = "CET6_PICKER_START_DIR";

/**
 * **预检模式**开关（环境变量，值必须是 `"1"`）。
 *
 * ── 它是什么 ──
 *
 * 让**同一个** `PICKER_SCRIPT` 在**真实初始化与全部必需赋值之后**、
 * `ShowDialog()` **之前**退出，并回传一份结构化的预检结果。
 * 它**绝不创建也绝不显示任何窗口**。
 *
 * ── 它为什么必须内建在同一个脚本里，而不是另写一份 ──
 *
 * 早先的自动化门禁**从未执行过真实的 `PICKER_SCRIPT`**：那条"真实子进程"
 * 用例用的是**自带的 inline 替身脚本**，于是脚本里一个在目标宿主上
 * 不存在的属性赋值（`.NET Framework 4.8` 没有 `UseDescriptionForTitle`）
 * 穿过了全部绿灯，只在 使用者 真实点击时才暴露。
 *
 * 若预检是**另一份**脚本，它同样会漂移 —— 它验证的将是它自己，而不是
 * 生产路径。因此开关做进同一个常量：**预检执行的就是生产代码本身**。
 *
 * ── 它为什么不是一个可远程触发的 HTTP 能力 ──
 *
 * 它只经**子进程环境变量**开启，而进入子进程的唯一入口是 Node 侧的
 * `runPickerPreflight()`（测试与本地诊断调用）。HTTP 端点不暴露任何
 * 传递该环境变量的能力，也没有对应的路由 —— 因此"远程开启预检"
 * 在结构上不存在。
 */
const PREFLIGHT_ENV = "CET6_PICKER_PREFLIGHT";

/**
 * 子进程脚本（**固定常量，零插值**）。
 *
 * ── 它为什么一行都不能"聪明" ──
 *
 * 这个脚本是**唯一**一处我们把本机路径交给另一个进程的地方。
 * 任何"按用户输入拼一段 PowerShell"的写法都会立刻打开注入面
 * （PowerShell 的 `$()`、反引号、双引号内插值都是可执行语法）。
 * 因此这里的原则是：**脚本是常量，数据只走环境变量与 stdout**。
 *
 * ── 它如何区分四种结局 ──
 *
 * | 情形 | 判定 |
 * | --- | --- |
 * | 用户取消 | `ShowDialog()` 返回 `Cancel` |
 * | 用户确认 | 返回 `OK` ⇒ 回传 `$d.SelectedPath` |
 * | 组件/桌面不可用 | `Add-Type` 或 `ShowDialog` 抛 ⇒ 回传 `dialog_unavailable` |
 * | 脚本本身没跑起来 | 子进程非零退出 / 没有协议行 ⇒ 由 Node 侧判 `dialog_unavailable` |
 *
 * 路径一律经 `base64(UTF-8)` 回传：中文目录名、空格、引号、
 * 甚至换行都不会被 stdout 的编码与分隔规则破坏。
 */
const PICKER_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$marker = "CET6PICKER"
function Emit([string]$outcome, [string]$payload, [string]$nofolder) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  [Console]::Out.WriteLine($marker + [char]9 + $outcome + [char]9 + $b64 + [char]9 + $nofolder)
  [Console]::Out.Flush()
}
$preflight = [Environment]::GetEnvironmentVariable("CET6_PICKER_PREFLIGHT") -eq "1"
try {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  # 关掉"新建文件夹"：本工具是只读检查，绝不在 使用者的课程目录里建东西。
  $dialog.ShowNewFolderButton = $false
  $dialog.Description = "选择要在本机检查的课程材料目录（只读，不会修改任何文件）"
  # ── 维护者注意：**不要**在这里加 $dialog.UseDescriptionForTitle ──
  # 那个属性只存在于 .NET Core 3.0+；本模块**刻意**绑定 .NET Framework 上的
  # Windows PowerShell 5.1（只有它尊重 ShowNewFolderButton）。赋值不存在的属性
  # 会在 $ErrorActionPreference = "Stop" 下抛出，被下方 catch 捕获 ⇒
  # 报 dialog_unavailable，且异常发生在 ShowDialog() 之前 ⇒ 窗口根本不会创建。
  # 这一条已由真实宿主上的无头预检守护（见 runPickerPreflight），
  # 且**不得**用宽泛 try/catch 掩盖。
  $start = [Environment]::GetEnvironmentVariable("CET6_PICKER_START_DIR")
  $startApplied = $false
  if ($start -and (Test-Path -LiteralPath $start -PathType Container)) {
    try { $dialog.SelectedPath = $start; $startApplied = $true } catch { }
  }
  # 运行时事实：宿主是否真的兑现了 ShowNewFolderButton = $false
  $honored = "unknown"
  try { if ($dialog.ShowNewFolderButton -eq $false) { $honored = "hidden" } else { $honored = "shown" } } catch { }

  if ($preflight) {
    # ── 预检分支：真实初始化与全部必需赋值**之后**、ShowDialog **之前**退出 ──
    # 它绝不创建或显示任何窗口，只核对"必需属性确实存在且可设"。
    # 因为上面那些赋值就是生产代码本身，任何"属性不存在"的赋值都会在
    # $ErrorActionPreference = "Stop" 下抛错并被下方 catch 捕获 ⇒ 预检失败。
    $required = @("ShowNewFolderButton", "Description", "SelectedPath", "RootFolder")
    $present = @($dialog.PSObject.Properties.Name)
    $missing = @()
    foreach ($name in $required) { if ($present -notcontains $name) { $missing += $name } }
    $descriptionSet = $false
    try { if ($dialog.Description -eq "选择要在本机检查的课程材料目录（只读，不会修改任何文件）") { $descriptionSet = $true } } catch { }
    $report = [ordered]@{
      host = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
      required = ($required -join ",")
      missing = ($missing -join ",")
      showNewFolder = $honored
      descriptionSet = $descriptionSet
      startRequested = [bool]($start -ne $null -and $start -ne "")
      startApplied = $startApplied
    } | ConvertTo-Json -Compress
    if ($missing.Count -eq 0 -and $honored -eq "hidden" -and $descriptionSet) {
      Emit "preflight_ok" $report $honored
    } else {
      Emit "preflight_failed" $report $honored
    }
    exit 0
  }

  $result = $dialog.ShowDialog()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Emit "selected" $dialog.SelectedPath $honored
  } else {
    Emit "cancelled" "" $honored
  }
} catch {
  # 预检模式下的失败必须是**独立的结局**（而不是被伪装成"用户取消"或
  # 静默吞掉）：调用方据此判定"这个脚本在目标宿主上跑不起来"。
  if ($preflight) {
    Emit "preflight_failed" $_.Exception.Message "unknown"
  } else {
    Emit "dialog_unavailable" $_.Exception.Message "unknown"
  }
}
`;

/** UTF-16LE base64（`-EncodedCommand` 要求的编码）。 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * 一条协议行的三个字段。
 *
 * ── 为什么把它抽出来（唯一实现）──
 *
 * 正常弹窗路径与**预检**路径读的是**同一个**协议契约。若两处各写一遍
 * 扫描逻辑，迟早会漂移成"一个认得出、另一个认不出"—— 而那种漂移会让
 * 预检给出与真实路径不一致的结论，比没有预检更糟。
 */
interface ProtocolLine {
  outcome: string;
  payload: string;
  noFolder: string;
}

/** 取**最后一条**协议行（PowerShell 的 progress / CLIXML 噪声可能混在前后）。 */
function findLastProtocolLine(stdout: string): ProtocolLine | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith(PROTOCOL_MARKER)) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    let payload = "";
    try {
      payload = Buffer.from(parts[2], "base64").toString("utf8");
    } catch {
      payload = "";
    }
    return { outcome: parts[1], payload, noFolder: parts[3] };
  }
  return null;
}

/** 解析协议行。**纯函数**（因此可以被单元测试穷举）。 */
export function parsePickerOutput(stdout: string): {
  outcome: FolderPickerOutcome | null;
  path: string | null;
  detail: string;
  newFolderButtonHidden: boolean | null;
} {
  const line = findLastProtocolLine(stdout);
  if (line === null) {
    return { outcome: null, path: null, detail: "子进程没有返回结果行。", newFolderButtonHidden: null };
  }
  const { outcome: rawOutcome, payload, noFolder: rawNoFolder } = line;
  const honored = rawNoFolder === "hidden" ? true : rawNoFolder === "shown" ? false : null;

  if (rawOutcome === "selected") {
    const path = payload.trim();
    if (path === "") {
      return {
        outcome: "dialog_unavailable",
        path: null,
        detail: "对话框返回了一个空路径。",
        newFolderButtonHidden: honored,
      };
    }
    return { outcome: "selected", path, detail: "已选择课程材料目录。", newFolderButtonHidden: honored };
  }
  if (rawOutcome === "cancelled") {
    return {
      outcome: "cancelled",
      path: null,
      detail: "没有选择目录（已取消）。",
      newFolderButtonHidden: honored,
    };
  }
  if (rawOutcome === "dialog_unavailable") {
    return {
      outcome: "dialog_unavailable",
      path: null,
      // 子进程的异常原文可能含路径 ⇒ 只作**内部**细节，调用方负责不下发原文
      detail: payload === "" ? "对话框无法启动。" : `对话框无法启动：${payload}`,
      newFolderButtonHidden: honored,
    };
  }
  return {
    outcome: null,
    path: null,
    detail: `无法识别的结果标记：${rawOutcome}`,
    newFolderButtonHidden: honored,
  };
}

/** 平台判定：只有 Windows 才有这条原生对话框。 */
export function isFolderPickerSupported(platform: string = process.platform): boolean {
  return platform === "win32";
}

/**
 * Windows PowerShell（5.1）的路径。
 *
 * ── 为什么是它，而不是 `pwsh` ──
 *
 * 只有 .NET Framework 上的 `FolderBrowserDialog` **尊重**
 * `ShowNewFolderButton`（Microsoft 文档：.NET Core 3.1+ 无视它）。
 * 本项目实测本机**没有** `pwsh`，而 `powershell.exe` 存在且
 * `-STA` 生效。
 *
 * 刻意**不**做成"优先 pwsh、退回 powershell"：那会让"新建文件夹按钮
 * 是否可关"变成一个随宿主而变的性质，而它恰好是本工具的一条硬约束
 * （只读检查不得在课程目录里建东西）。
 */
export function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** 同时只允许一个对话框（避免并发请求弹出多个模态窗口）。 */
let pickerInFlight = false;

/** 供测试核对/复位（**不改变任何安全语义**）。 */
export function isPickerInFlight(): boolean {
  return pickerInFlight;
}

export interface PickFolderOptions {
  /** 起始目录。**只作提示**：不存在时被忽略。 */
  startDirectory?: string | null;
  /** 超时（毫秒）。默认 300000（5 分钟）。 */
  timeoutMs?: number;
  /** 注入用（测试）：替换 spawn。默认用真实的 `node:child_process`。 */
  spawnImpl?: typeof spawn;
  /** 注入用（测试）：平台。 */
  platform?: string;
  /** 注入用（测试）：宿主可执行文件路径。 */
  executable?: string;
}

/**
 * 打开**操作系统原生**目录选择对话框，返回选中的路径。
 *
 * ── 它绝不抛异常 ──
 *
 * 每一个失败形态都变成一个有名字的 `outcome`。理由：调用方要对
 * "取消"、"平台不支持"、"对话框起不来"、"超时"给出**不同的**中文处置，
 * 而抛异常会把它们压成同一个 `catch`。取消尤其重要 —— 它不是错误，
 * 是用户正常操作，必须与失败分开。
 *
 * ── 绝不把路径插进 shell ──
 *
 * 脚本是常量；起始目录经**环境变量**；参数走数组且 `shell: false`。
 * 因此"用户数据出现在命令行上"这件事在本实现里不存在。
 */
export async function pickFolder(options: PickFolderOptions = {}): Promise<FolderPickerResult> {
  const platform = options.platform ?? process.platform;
  if (!isFolderPickerSupported(platform)) {
    return {
      outcome: "unsupported_platform",
      path: null,
      detail: "本机目录选择器目前只在 Windows 上可用。",
      newFolderButtonHidden: null,
    };
  }

  if (pickerInFlight) {
    return {
      outcome: "dialog_unavailable",
      path: null,
      detail: "已经有一个目录选择窗口开着，请先处理它。",
      newFolderButtonHidden: null,
    };
  }

  const runner = options.spawnImpl ?? spawn;
  const executable = options.executable ?? windowsPowerShellPath();
  const timeoutMs = options.timeoutMs ?? 300_000;

  pickerInFlight = true;
  try {
    return await new Promise<FolderPickerResult>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";

      const finish = (result: FolderPickerResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let child;
      try {
        child = runner(
          executable,
          /*
           * ── 参数数组，`shell: false`（默认）──
           *
           * 参数**绝不**交给 cmd.exe 解析。`-EncodedCommand` 的值是我们自己
           * 产出的 base64（字符集 `[A-Za-z0-9+/=]`），不含任何 shell 元字符。
           */
          ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand(PICKER_SCRIPT)],
          {
            // stdio 全走管道：stdin 关掉（脚本不读输入），stdout/stderr 只用于协议
            stdio: ["ignore", "pipe", "pipe"],
            // 不弹控制台窗口：对话框本身是独立窗口，控制台只会闪一下
            windowsHide: true,
            shell: false,
            env: {
              ...process.env,
              /*
               * **显式关闭预检模式。**
               *
               * 这一条是结构性的，不是防御性编程的客套：`...process.env`
               * 会把环境里**恰好存在**的 `CET6_PICKER_PREFLIGHT=1` 继承给
               * 子进程，于是"正常弹窗"这条路径会静默走进预检分支、
               * 直接退出而不显示窗口。虽然那种情况在 `parsePickerOutput`
               * 里会落到 `dialog_unavailable`（失败关闭，不会谎报成功），
               * 但"调用方以为在弹窗、脚本却没弹"是一个不该存在的耦合。
               *
               * 显式写 `"0"` 之后，"正常路径一定走到 ShowDialog"成为
               * **结构性**事实，与调用者的环境无关。
               */
              [PREFLIGHT_ENV]: "0",
              ...(options.startDirectory ? { [START_DIR_ENV]: options.startDirectory } : {}),
            },
          },
        );
      } catch (error) {
        finish({
          outcome: "dialog_unavailable",
          path: null,
          detail: `无法启动目录选择器：${(error as Error).message}`,
          newFolderButtonHidden: null,
        });
        return;
      }

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 尽力而为 */
        }
        finish({
          outcome: "timeout",
          path: null,
          detail: "目录选择窗口长时间没有回应，已结束这一次尝试。可以再点一次重试。",
          newFolderButtonHidden: null,
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => {
        finish({
          outcome: "dialog_unavailable",
          path: null,
          detail: `无法启动目录选择器：${error.message}`,
          newFolderButtonHidden: null,
        });
      });
      child.on("close", () => {
        const parsed = parsePickerOutput(stdout);
        if (parsed.outcome === null) {
          finish({
            outcome: "dialog_unavailable",
            path: null,
            /*
             * 子进程的 stdout/stderr 原文**不进** detail：它可能含本机路径
             * （PowerShell 的 CLIXML 错误里会带完整路径）。这里只给
             * 一个长度与计数级的事实，让人知道"子进程说话了但我们没听懂"。
             */
            detail:
              "目录选择器没有返回可识别的结果（可能是这台机器上的桌面会话或组件不可用）。" +
              `（子进程输出 ${stdout.length} 字符 / 错误输出 ${stderr.length} 字符）`,
            newFolderButtonHidden: null,
          });
          return;
        }
        finish({
          outcome: parsed.outcome,
          path: parsed.path,
          detail: parsed.detail,
          newFolderButtonHidden: parsed.newFolderButtonHidden,
        });
      });
    });
  } finally {
    pickerInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// 无头兼容性预检（headless compatibility preflight）
// ---------------------------------------------------------------------------

/** 预检结果。 */
export interface PickerPreflightResult {
  /**
   * 结局。
   *
   * | 值 | 含义 |
   * | --- | --- |
   * | `ok` | 生产脚本在**真实宿主**上完成了初始化与全部必需赋值 |
   * | `failed` | 脚本在宿主上跑不起来（属性不存在、组件缺失、异常） |
   * | `no_protocol_line` | 子进程没有回传可识别的协议行（含非零退出） |
   * | `spawn_error` | 子进程根本没能启动 |
   * | `timeout` | 预检超时（不应发生：预检不等人） |
   * | `unsupported_platform` | 非 Windows ⇒ 无此宿主 |
   */
  status: "ok" | "failed" | "no_protocol_line" | "spawn_error" | "timeout" | "unsupported_platform";
  /** 人话说明。**失败时不含绝对路径**（子进程异常原文可能带路径，因此不透传全文）。 */
  detail: string;
  /** 结构化预检报告（脚本回传的 JSON）；无法解析时为 null。 */
  report: Record<string, unknown> | null;
  /** 宿主是否真的把 `ShowNewFolderButton` 设为 false 并读回 false。 */
  newFolderButtonHidden: boolean | null;
  /** 子进程退出码（未拿到时为 null）。 */
  exitCode: number | null;
}

/**
 * 在**真实目标宿主**上执行生产 `PICKER_SCRIPT` 的**无头预检**。
 *
 * ── 它证明什么，**不**证明什么 ──
 *
 * 通过只意味着"**真实的对话框初始化代码在目标宿主上跑得起来**"
 * （属性存在、必需赋值成功、`ShowNewFolderButton` 确实被关掉）。
 *
 * 它**不**证明：窗口真的会显示、用户能选中目录、路径能正确回传、
 * 整条检查流程能走完。那四件事只有**真实 GUI 人工验收**能证明 ——
 * 因此在 使用者 真正走完之前，那条路径继续记为**未验证**。
 *
 * ── 为什么它复用 `pickFolder()` 的同一套调用形态 ──
 *
 * 同一个 `PICKER_SCRIPT` 常量、同一组命令行参数、同一个 `-EncodedCommand`
 * 编码、同样的 `shell: false` 与 `windowsHide`。唯一差别是**多一个环境变量**
 * 让脚本提前退出 —— 因此它验证的是生产路径的**真实**行为。
 */
export async function runPickerPreflight(
  options: {
    timeoutMs?: number;
    spawnImpl?: typeof spawn;
    platform?: string;
    executable?: string;
    /** 起始目录；预检会核对"传了就是否真的应用上"。 */
    startDirectory?: string | null;
  } = {},
): Promise<PickerPreflightResult> {
  const platform = options.platform ?? process.platform;
  if (!isFolderPickerSupported(platform)) {
    return {
      status: "unsupported_platform",
      detail: "本机目录选择器目前只在 Windows 上可用。",
      report: null,
      newFolderButtonHidden: null,
      exitCode: null,
    };
  }

  const runner = options.spawnImpl ?? spawn;
  const executable = options.executable ?? windowsPowerShellPath();
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<PickerPreflightResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result: PickerPreflightResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = runner(
        executable,
        // 与 `pickFolder()` **逐字相同的参数形态**（唯一差别是环境变量）
        ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand(PICKER_SCRIPT)],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          env: {
            ...process.env,
            // 预检开关 + 起始目录（都不经 shell 解析）。
            //
            // 起始目录**显式清空**（未提供时）：否则环境里恰好存在的
            // `CET6_PICKER_START_DIR` 会让预检报告一个调用方没要求的
            // `startApplied`，使结果依赖环境而不是输入。
            [PREFLIGHT_ENV]: "1",
            [START_DIR_ENV]: options.startDirectory ?? "",
          },
        },
      );
    } catch (error) {
      finish({
        status: "spawn_error",
        detail: `无法启动 PowerShell 宿主：${(error as Error).message}`,
        report: null,
        newFolderButtonHidden: null,
        exitCode: null,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 尽力而为 */
      }
      finish({
        status: "timeout",
        detail: "预检超时（预检不需要任何人工操作，超时说明宿主无响应）。",
        report: null,
        newFolderButtonHidden: null,
        exitCode: null,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      finish({
        status: "spawn_error",
        detail: `无法启动 PowerShell 宿主：${error.message}`,
        report: null,
        newFolderButtonHidden: null,
        exitCode: null,
      });
    });
    child.on("close", (code: number | null) => {
      const line = findLastProtocolLine(stdout);
      if (line === null) {
        finish({
          status: "no_protocol_line",
          // 只给计数级事实：子进程输出可能含本机路径
          detail:
            "生产脚本没有回传可识别的预检结果（宿主可能缺少 Windows Forms 组件）。" +
            `（退出码 ${code ?? "未知"}；输出 ${stdout.length} 字符 / 错误 ${stderr.length} 字符）`,
          report: null,
          newFolderButtonHidden: null,
          exitCode: code,
        });
        return;
      }

      const honored = line.noFolder === "hidden" ? true : line.noFolder === "shown" ? false : null;

      if (line.outcome === "preflight_ok") {
        finish({
          status: "ok",
          detail: "生产脚本在目标宿主上完成了初始化与全部必需赋值（未显示任何窗口）。",
          report: safeParseJsonObject(line.payload),
          newFolderButtonHidden: honored,
          exitCode: code,
        });
        return;
      }
      if (line.outcome === "preflight_failed") {
        finish({
          status: "failed",
          /*
           * ── 为什么这里**故意**保留异常原文（而 `pickFolder` 不透传）──
           *
           * 这是**开发者/测试**路径，不是面向 使用者的界面。失败原因
           * （例如"找不到属性 UseDescriptionForTitle"）正是这条门禁要报告的
           * 东西；把它抹掉会让测试只能报"失败"而说不出为什么。
           *
           * 它仍然**不进**任何 HTTP 响应、不进 使用者 可见文案 ——
           * 预检没有暴露给端点（见 PREFLIGHT_ENV 的说明）。
           */
          detail: line.payload === "" ? "预检失败（脚本未给出原因）。" : line.payload,
          report: safeParseJsonObject(line.payload),
          newFolderButtonHidden: honored,
          exitCode: code,
        });
        return;
      }

      finish({
        status: "failed",
        detail: `预检返回了意外结局：${line.outcome}`,
        report: safeParseJsonObject(line.payload),
        newFolderButtonHidden: honored,
        exitCode: code,
      });
    });
  });
}

/** 把可能是 JSON 或纯文本的 payload 解析成对象；失败返回 null。 */
function safeParseJsonObject(payload: string): Record<string, unknown> | null {
  const text = payload.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
