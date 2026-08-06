# ⚡ Spurh — AI Native Developer Toolbox

> 别找工具，直接粘贴。Spurh 自动识别你的内容，把结果放回你的指尖。

**Spurh** 是一个面向开发者的 **本地优先 · 插件优先 · AI 原生** 桌面工具箱。粘贴任意内容，Dispatcher 立即识别意图并选择最佳工具；SQL、SSH、网络、日志等重型能力以产品级面板呈现。

![首页](screenshots/01-home-json.png)

---

## ✨ 为什么是 Spurh

| 特性 | 说明 |
|---|---|
| 🧠 **智能 Dispatcher** | 粘贴即路由：JWT / JSON / Cron / 时间戳 / Base64 自动识别，置信度排序 + 手动覆盖 |
| 🔌 **插件优先** | 内置 13 个插件共用同一 `SpurhPlugin` 协议，第三方能力即插即用 |
| 🗄️ **数据库管理** | MySQL / PostgreSQL / SQLite：库表浏览、数据编辑、SQL 查询（高亮/补全/格式化/历史）、表设计器、CSV 导出 |
| 🖥️ **SSH 远程终端** | xterm.js 多标签终端、会话持久化、快捷命令、文件传输、主机资源监控 |
| 🤖 **AI 原生** | OpenAI 兼容流式接入（OpenAI/DeepSeek/Qwen/Gemini/Ollama 等），本地失败一键 AI 修复 |
| 🔒 **本地优先 · 安全** | 凭据存系统钥匙串（Windows Credential Manager / macOS Keychain / Linux Secret Service），数据库连接支持 TLS |
| 🎨 **极致体验** | 深色/浅色主题、全局快捷键、命令面板（Ctrl+K）、剪贴板历史（Ctrl+Shift+V）、零多余 UI |

## 📸 界面一览

| 场景 | 截图 |
|---|---|
| 首页 · JSON 格式化与树视图 | ![首页](screenshots/01-home-json.png) |
| 智能 Dispatcher 识别 | ![Dispatcher](screenshots/06-dispatcher.png) |
| SQL 表数据浏览 | ![SQL 表数据](screenshots/02-sql-table-data.png) |
| SQL 编辑器（高亮 + 格式化） | ![SQL 编辑器](screenshots/03-sql-editor.png) |
| SSH 远程终端 | ![远程终端](screenshots/04-remote.png) |
| 设置面板 | ![设置](screenshots/05-settings.png) |

## 🛠️ 内置工具

| 类别 | 工具 |
|---|---|
| 数据 | JSON / XML 格式化压缩、JSONPath、文本统计处理、行去重/排序/大小写 |
| 编码 | Base64、URL、Hex、Unicode、HTML 编解码 |
| 安全 | AES-256-GCM、RSA 密钥、JWT 编解码/验签/生成、MD5/SHA/HMAC |
| 开发 | 正则测试/替换/解释、Cron 解析（Quartz 扩展）、随机生成、时间戳、日志分析 |
| 专业面板 | 数据库管理、SSH 远程终端、网络工具（端口/DNS/TCP-UDP/路由追踪/IP 归属地）、剪贴板历史 |

## 🚀 快速开始

要求：**Node.js 20+、Rust 1.80+**，以及对应平台的 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
# 安装依赖
npm install

# 浏览器模式（仅前端，部分系统能力不可用）
npm run dev

# 桌面应用（完整能力）
npm run tauri dev

# 质量检查
npm run check      # svelte-check
npm test           # vitest
npm run build      # 前端生产构建
```

> 数据库与 SSH 的密码/API Key 保存在**系统钥匙串**，不落盘明文。

## 🔌 插件开发

插件通过 `SpurhPlugin` 协议接入：声明元信息、动作列表、同步检测器与可异步执行器。运行时负责隔离异常、限制执行时间并以统一结果结构交给 UI。

```ts
const plugin: SpurhPlugin = {
  id: 'acme.example',
  name: 'Example',
  description: 'Example plugin',
  icon: 'EX',
  version: '0.1.0',
  actions: [{ id: 'run', label: '运行', description: '处理输入' }],
  detect: (input) => input.startsWith('example:')
    ? { confidence: 0.9, reason: '检测到 example 前缀' }
    : null,
  execute: (_action, input) => ({ output: input.slice(8) }),
};

runtime.register(plugin);
```

协议位于 `src/lib/plugins/types.ts`，运行时位于 `src/lib/plugins/runtime.ts`。

## ⌨️ 常用快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+Space` | 全局唤起 / 聚焦 Dispatcher |
| `Ctrl+K` | 命令面板 |
| `Ctrl+Shift+V` | 剪贴板历史 |
| `Ctrl+Enter` / `F5`（SQL） | 执行 SQL（有选中只执行选中） |
| `Ctrl+Space`（SQL） | 关键字 / 表名 / 字段补全 |
| `Ctrl+F`（SQL） | 聚焦当前页筛选 |
| `Ctrl+S`（SQL） | 保存数据/表结构 |
| `Ctrl+L` / `Ctrl+Shift+C` / `Ctrl+Shift+V`（终端） | 清屏 / 复制 / 粘贴 |
| `Alt+1..8` | 快速切换工具 |

## 🏗️ 技术栈

- **桌面壳**：Tauri 2（Rust）· 托盘 / 全局快捷键 / 右键菜单 / 开机启动
- **前端**：Svelte 5（runes）+ TypeScript + Vite 8
- **后端能力**：rusqlite / mysql / postgres（TLS）、russh（SSH + TOFU known_hosts）、reqwest（流式 AI）、arboard（剪贴板）、keyring（系统钥匙串）
- **终端**：xterm.js + fit-addon

## 📁 目录结构

```
spurh/
├─ src/                  # 前端（Svelte 5）
│  ├─ lib/plugins/       # 插件协议与内置插件
│  ├─ lib/panels/        # SQL / SSH / 网络 / 日志 / 剪贴板面板
│  ├─ lib/components/    # 结果视图 / JSON 树
│  └─ App.svelte         # Dispatcher 与主界面
├─ src-tauri/            # Rust 后端（Tauri 2）
│  └─ src/               # sql / ssh / net / clipboard / secrets / lib
├─ screenshots/          # 界面截图
├─ website/              # 独立官网首页（单 HTML）
└─ docs/DESIGN.md        # 产品与技术设计
```

## 🧪 质量

- `svelte-check`：0 错误 0 警告
- `vitest`：73 个单元测试（插件运行时 / 结果视图 / 远程解码 / SQL 高亮 / SQL 格式化）
- `cargo clippy -D warnings`：通过

## 📄 License

MIT
