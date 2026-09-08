# TermLens 架构设计文档（design.md）

版本：v1.0　日期：2026-09-01
上游依据：`docs/requirements.md` v1.0，`docs/任务文档.md` C-01~C-18 / D1~D12

---

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Electron 33 | 决策 D2；Windows 透明覆盖层、全局快捷键、屏幕捕获能力成熟 |
| 主进程语言 | TypeScript (Node 24) | 已装 Node 24.19.0 LTS |
| 渲染层 | React 18 + TypeScript | 后续手机端可复用组件逻辑 |
| 构建 | Vite 5 + electron-vite | 快速 HMR，主/预加载/渲染三段构建 |
| 状态管理 | Zustand | 轻量，避免 Redux 样板 |
| 样式 | Tailwind CSS + CSS Variables | 主题切换与高对比度模式（NFR-7） |
| 本地数据库 | better-sqlite3 | 决策 D10；同步 API 适合主进程 |
| Key 加密 | Electron safeStorage (DPAPI) | 决策 D10，禁止明文 |
| OCR | Windows.Media.Ocr（优先） / Tesseract.js（降级） | 决策 D9；离线免费 |
| 屏幕捕获 | desktopCapturer + ffmpeg-static | 录屏与合流 |
| 音频采集 | Web Audio API + naudiodon（系统声音） | 麦克风 + 系统混音 |
| 文档导出 | docx / markdown-it / puppeteer-core(PDF) | FR-3.5 |
| 测试 | Vitest + Playwright(E2E) | |
| 打包 | electron-builder (nsis, x64 + arm64) | NFR-10 |
| 包管理 | npm | 决策 D12 |

---

## 2. 进程与窗口模型

```
┌─────────────────────────── Main Process ───────────────────────────┐
│  AppKernel                                                         │
│   ├── ConfigService        配置中心 + safeStorage 加密              │
│   ├── ModeService          双形态开关（Public / Developer）C-13/14  │
│   ├── ProviderRegistry     LLM/ASR Provider 池                     │
│   ├── TermEngine           术语识别 + 三级瀑布解释（D6）           │
│   ├── OcrService           Windows OCR / Tesseract 降级            │
│   ├── CaptureService       截屏 / 录屏 / 录音                       │
│   ├── MeetingDetector      会议进程与音频活跃度检测（FR-5.1）      │
│   ├── Repository (SQLite)  数据持久层，接口化以备云同步（FR-8.1）  │
│   ├── SyncService          导出/导入 + WebDAV/S3（FR-8.2/8.3）      │
│   ├── HotkeyService        全局快捷键                               │
│   └── WindowManager        窗口生命周期                             │
└────────────────────────────────────────────────────────────────────┘
        │ IPC (contextBridge, 白名单通道, 无 nodeIntegration)
        ▼
┌─────────── Renderer Windows ───────────┐
│ 1. MainWindow      主界面（工作台）     │
│ 2. OverlayWindow   全屏透明标注层       │
│ 3. HudWindow       悬浮小窗（口述/解题）│
│ 4. PopoverWindow   术语简释浮层         │
└────────────────────────────────────────┘
```

窗口关键属性：

| 窗口 | frame | transparent | alwaysOnTop | 鼠标穿透 | 说明 |
|---|---|---|---|---|---|
| MainWindow | 有 | 否 | 否 | 否 | 工作台，含转写、排版、阅读器、设置 |
| OverlayWindow | 无 | 是 | screen-saver | `setIgnoreMouseEvents(true, {forward:true})` | 术语区域动态放行（FR-6.6） |
| HudWindow | 无 | 是 | screen-saver | 否 | 录音状态、解题结果小窗 |
| PopoverWindow | 无 | 是 | screen-saver | 否 | 悬停简释；跟随鼠标定位 |

防录屏（FR-6.7）：`win.setContentProtection(true)`，底层走 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，仅在开发者模式且开关开启时生效，默认关闭。

---

## 3. 目录结构

```
src/
├── main/                       主进程
│   ├── index.ts
│   ├── kernel/                 AppKernel, WindowManager, HotkeyService
│   ├── config/                 ConfigService, schema, secureStore
│   ├── mode/                   ModeService（双形态）
│   ├── providers/              LLM/ASR 适配器
│   │   ├── types.ts
│   │   ├── openai-compatible.ts
│   │   ├── anthropic.ts
│   │   ├── gemini.ts
│   │   ├── asr/               whisper-compatible.ts 等
│   │   └── registry.ts
│   ├── term/                   术语引擎
│   │   ├── engine.ts           三级瀑布编排
│   │   ├── detector.ts         词库 AC 自动机 + LLM 抽取
│   │   ├── explainer.ts        简释/详解/追问
│   │   ├── thread.ts           会话线程 + 面包屑（D11）
│   │   └── lexicon/            领域词库（marxism.json 等）
│   ├── ocr/                    OcrService + winrt 绑定 + tesseract 降级
│   ├── capture/                截屏 / 录屏 / 录音 / ffmpeg 合流
│   ├── meeting/                MeetingDetector + 三态策略
│   ├── study/                  FR-2 题目学习
│   ├── format/                 FR-3 排版 + 导出器
│   ├── solve/                  FR-6 自动解题（开发者模式）
│   ├── data/                   Repository 接口 + sqlite 实现 + migrations
│   ├── sync/                   SyncService（导出导入 / WebDAV / S3）
│   └── ipc/                    通道定义与注册（单一来源）
├── preload/                    contextBridge 白名单桥
├── renderer/
│   ├── main-window/            工作台各页面
│   ├── overlay/                标注层
│   ├── hud/                    悬浮小窗
│   ├── popover/                简释浮层
│   ├── components/             TermMark, TermPopover, TermDetailPanel,
│   │                           Breadcrumb, ProviderForm, ThreeStateSwitch...
│   ├── stores/                 Zustand
│   └── styles/
└── shared/                     跨进程共享：类型、常量、纯函数
```

`shared/` 与 `providers/`、`term/`、`data/` 保持零 Electron 依赖，供未来手机端直接复用（NFR-9）。

---

## 4. 核心机制设计

### 4.1 术语引擎三级瀑布（FR-4.10 / D6）

```
输入文本
  │
  ├─1─► Lexicon 精确匹配（Aho-Corasick 多模式匹配，O(n)）
  │       命中 → 直接返回本地解释（<10ms，离线可用）
  │
  ├─2─► SQLite 缓存查询（key = sha256(term + domain + level)）
  │       命中 → 返回缓存解释（<50ms）
  │
  └─3─► LLM 抽取 + 生成
          ① 抽取：一次调用返回术语列表 + 字符区间 + 领域标签
          ② 解释：批量生成简释（brief）；详解（detail）按需懒加载
          ③ 回写 Lexicon 候选池与 SQLite 缓存
```

术语数据结构：

```ts
interface Term {
  id: string;
  surface: string;          // 原文表面形式
  canonical: string;        // 规范名
  domain: string;           // 'marxism' | 'ai' | 'economics' | ...
  range: [number, number];  // 文本字符区间（阅读器模式）
  bbox?: Rect;              // 屏幕坐标（OCR 模式）
  confidence: number;
  source: 'lexicon' | 'cache' | 'llm';
}

interface Explanation {
  termId: string;
  brief: string;                    // FR-4.3 悬停简释
  detail?: {                        // FR-4.4 点击详解
    definition: string;
    background: string;
    keyPoints: string[];
    related: string[];
  };
  level: 'beginner' | 'intermediate' | 'expert';  // FR-4.12
  subTerms: Term[];                 // FR-4.6 详解正文中的子概念
}
```

### 4.2 递归下钻与会话线程（FR-4.5~4.7 / D11）

```
ConceptThread {
  threadId
  path: Term[]            // 面包屑：父 → 子 → 孙，无层数上限
  messages: Message[]     // 该线程的追问历史
  parentThreadId?: string
}
```

下钻时新建子线程，system prompt 注入完整 path 作为上下文，确保「剩余价值 → 可变资本 → 劳动力商品」这条链上的解释始终贴合上游语境，不跑偏。面包屑点击任一节点即切回对应线程。

### 4.3 双形态隔离（C-13 / C-14 / FR-6.1~6.2）

```
ModeService
  mode: 'public' | 'developer'
  unlock(passphrase): 版本号连点 7 次触发输入框，校验通过写入加密配置
```

隔离手段（编译期 + 运行期双保险）：
1. 路由与菜单表按 mode 过滤，developer 项在 public 下不注册。
2. 开发者相关 IPC 通道在 public 模式下不注册 handler，即使被调用也直接拒绝。
3. 全局快捷键在 public 模式下不绑定。
4. 托盘菜单动态重建。
5. 构建时可选 `--public-only` 产物，直接 tree-shake 掉 `solve/` 与 overlay 开发者路径。

### 4.4 全屏 OCR 标注管线（FR-6.5 / NFR-2）

```
快捷键触发 / 定时轮询
  → desktopCapturer 抓当前屏
  → 图像预处理（灰度 + 二值化 + DPI 归一化）
  → Windows.Media.Ocr → words[] with bbox
  → 行重组（按 y 聚类 + x 排序）得到可读文本 + 字符到 bbox 的映射
  → TermEngine 识别术语（返回字符区间）
  → 区间映射回屏幕 bbox
  → OverlayWindow 渲染标注矩形（加深色块 / 描边）
  → 鼠标进入某 bbox → 局部放行鼠标事件 → PopoverWindow 显示简释
```

性能措施：分块 OCR + 帧差跳过（画面未变则复用上轮结果）+ Worker 线程池 + DPI 感知（`per-monitor-v2`）。

### 4.5 会议自动录制（FR-5 / 三态开关）

```
MeetingDetector（2s 轮询）
  条件 A: 前台或活跃进程 ∈ {Zoom.exe, Teams.exe, feishu.exe, DingTalk.exe, wemeetapp.exe, WeChat.exe}
  条件 B: 系统音频会话活跃（WASAPI 峰值 > 阈值持续 3s）
  A && B → 判定会议开始

策略矩阵
  auto   → 弹 5s 可取消通知（FR-5.4）→ 开始录音/录屏
  manual → 仅提示「检测到会议，点击开始录制」
  off    → 不检测不提示

停止：进程退出 或 音频静默 > 60s → 停止 → 落盘 → 触发后处理链
后处理链：录音 → FR-1 转写 → FR-3 会议纪要排版 → FR-4 术语标注（FR-5.8）
```

录音与录屏各自独立三态开关。首次启用弹合规提示（FR-5.9）。

### 4.6 Provider 抽象层（FR-7 / D4）

```ts
interface ChatProvider {
  id: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;   // 统一流式
  vision?(req: VisionRequest): AsyncIterable<ChatChunk>;
  test(): Promise<TestResult>;                         // FR-7.4
}

interface AsrProvider {
  transcribe(audio: AudioSource, opts): AsyncIterable<TranscriptChunk>;
}

interface ProviderConfig {
  id: string; name: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  baseUrl: string;      // 用户可改（C-08）
  apiKey: string;       // safeStorage 加密
  model: string;
  timeoutMs: number; maxRetries: number;
  temperature?: number; maxTokens?: number;
}
```

三协议差异由适配器内部消化：Anthropic 走 `/v1/messages` 与 `x-api-key` 头，Gemini 走 `:streamGenerateContent` 与 `key` 查询参数，OpenAI 兼容走 `/chat/completions` 与 Bearer。对上层统一暴露同一份流式接口。

功能级路由（FR-7.3）：

```
featureBindings: {
  termBrief:   providerId   // 便宜快模型
  termDetail:  providerId
  solve:       providerId   // 强模型 / 视觉模型
  study:       providerId
  format:      providerId
  asr:         providerId
  chat:        providerId
}
```

### 4.7 数据层与跨设备同步（FR-8 / D7）

SQLite 表：

| 表 | 用途 |
|---|---|
| `terms` | 术语规范表 |
| `explanations` | 解释缓存（term+domain+level 唯一键） |
| `threads` / `messages` | 追问会话与面包屑路径 |
| `transcripts` | 转写稿 |
| `documents` | 排版结果 |
| `study_items` | 题目与解答历史 |
| `recordings` | 录音录屏元数据 |
| `settings` | 非敏感配置（Key 走 safeStorage 独立文件） |
| `sync_meta` | 同步版本向量与冲突记录 |

Repository 接口化，本地 SQLite 为默认实现；SyncService 提供导出/导入全量包（FR-8.2）与 WebDAV/S3 端到端加密同步（FR-8.3），冲突用「最后写入优先 + 保留冲突副本」（FR-8.4）。手机端复用同一 Repository 协议与数据格式（FR-8.5）。

### 4.8 安全与隐私（NFR-5 / NFR-6）

- `contextIsolation: true`，`nodeIntegration: false`，`sandbox: true`，预加载仅暴露白名单方法。
- CSP 禁止内联脚本与远程脚本。
- IPC 全部参数做 schema 校验（zod），拒绝越权通道。
- API Key 仅在主进程解密使用，绝不下发渲染进程；UI 只显示掩码。
- 用户内容默认仅本地；唯一外发目标是用户自己配置的 LLM 端点。
- 会议录制强制合规提示。

### 4.9 无障碍（NFR-7）

- 术语标注为 `<mark role="button" tabindex="0" aria-describedby>`，`Tab` 遍历、`Enter` 展开、`Esc` 关闭。
- 浮层 `role="dialog"` + 焦点陷阱 + `aria-live="polite"` 播报简释。
- 标注配色满足 WCAG 2.1 AA 对比度（≥4.5:1），提供高对比度与色盲友好主题；不以颜色作为唯一区分手段（同时加下划虚线）。
- 完整 WCAG 合规仍需人工辅助技术实测与专家评审，代码层只能保证结构与对比度达标。

---

## 5. 关键风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Windows.Media.Ocr Node 绑定不稳定 | 全屏模式不可用 | 双引擎：优先 winrt，失败自动降级 Tesseract.js；接口一致 |
| OCR 坐标随 DPI/缩放漂移 | 标注错位 | per-monitor-v2 DPI 感知 + 按显示器缩放系数校正 + 帧差校验 |
| LLM 术语抽取误报 | 满屏乱标 | 置信度阈值 + 词库白名单优先 + 停用词表 + 用户可一键忽略某术语 |
| 系统声音采集需额外原生模块 | 会议录音只有麦克风 | 优先 `desktopCapturer` 的 loopback；不可用时提示并降级为仅麦克风 |
| 防录屏能力被误用于作弊 | 合规风险 | 默认关闭、隐藏在开发者模式、首次开启显示用途与责任提示 |
| Token 成本失控 | 用户费用高 | 三级瀑布 + 批量抽取 + 缓存 + 用量统计与预算告警 |
| 双形态泄漏 | 对外形态暴露解题功能 | 编译期裁剪 + 运行期 IPC 拒绝 + 菜单/快捷键不注册，三重保险 + 自动化检查用例 |

---

## 6. 实施阶段

| 阶段 | 内容 | 交付物 |
|---|---|---|
| P0 | 骨架 + 配置中心 + Provider 三协议 + 数据层 | 可运行空壳，能连通任意模型 |
| P1 | FR-4 术语引擎 + 内置阅读器精准标注 + 悬停/详解/追问/下钻 | 核心差异化能力可演示 |
| P2 | FR-1 语音转写 + FR-3 自动排版 | typeless 底座成形 |
| P3 | FR-2 题目学习 + FR-5 会议自动录制 | 对外形态完整 |
| P4 | FR-6 开发者模式（解题 / 全屏 OCR / 防录屏 / AI 聊天） | 双形态完整 |
| P5 | FR-8 同步 + 测试 + 打包 | 可分发安装包 |
