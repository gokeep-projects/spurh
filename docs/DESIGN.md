# Spurh v0.1 产品与技术设计

## 产品判断

Spurh 的第一版不以工具数量取胜，只打磨三个能力：

1. AI Dispatcher：用户提供内容，系统识别“这是什么、可以做什么”。首个版本先用确定性的本地规则完成，快速、可解释、离线可用；LLM 只作为后续的低置信度兜底。
2. 插件系统：识别器和执行器都属于插件，内置能力与第三方能力使用同一协议。先稳定 TypeScript 契约，再引入 WASM Host，避免过早固化 ABI。
3. 极致 UI：单一输入入口、即时识别反馈、明确的下一步、零页面跳转。首屏必须在没有教程的情况下可理解。

## 核心流程

```text
用户输入
  → 所有插件并行语义检测（v0.1 为本地同步规则）
  → Dispatcher 按 confidence + priority 排序
  → 自动选择最佳插件，允许用户手动覆盖
  → Plugin Runtime 校验动作并隔离执行
  → 统一 PluginResult 渲染到工作区
```

## 首版边界

### 必须完成

- 输入后 50ms 内给出本地检测结果
- 检测结果可解释，展示匹配原因和置信度
- 单个插件检测失败不影响 Dispatcher
- 单个插件执行失败或超时不影响应用
- JSON、JWT、Cron、Base64、URL、Hash、Regex、时间戳覆盖首版常用场景，但不继续堆叠长尾工具
- 每个工具维护完全独立的 Session；Dispatcher 输入不属于任何工具
- 确定性转换输入即执行，不提供多余的“运行”确认
- UI 支持键盘操作、响应式布局和 reduced-motion
- 桌面壳不申请非必要权限

### 明确后移

- LLM Provider 管理、流式输出与 Tool Calling
- SQLite 与历史记录
- WASM 沙箱、插件签名、商店与自动更新
- 剪贴板常驻监听、全局快捷键、右键菜单、文件关联
- YAML、XML、Base64、Hash、Regex 等更多工具

## 关键修改建议

原设计中的 `<300ms` 启动、`30–60MB` 空闲内存和 `<30MB` 安装包应改为基准目标，而不是未经测量的发布承诺。建立 CI 性能基线后，再把 P50/P95 与平台差异写入验收标准。

“AI Dispatcher”不应等同于“每次调用大模型”。确定内容优先用本地规则识别；只有当最高置信度低于阈值时，且用户配置并允许联网，才调用 AI Gateway。这样才能同时兑现低延迟、Local First 和 AI Native。

WASM 的“热加载”与“独立进程/WASM”不是同一隔离等级。v0.2 需要先定义 capability 权限（网络、文件、剪贴板）、资源配额、插件签名和 ABI 版本，再选具体运行方式。

## 里程碑

- v0.1：Dispatcher + TypeScript Plugin Runtime + 八个核心插件 + 独立 Session 工作台 + 可选 AI 分析 + Tauri 壳
- v0.2：WASM Host、capability 权限模型、SDK 与一个第三方示例插件
- v0.3：可选 AI Gateway，用于低置信度意图识别和自然语言生成
- v0.4：SQLite 历史/设置与系统集成

每个里程碑都要求独立可用，不以未来模块补齐当前体验。
