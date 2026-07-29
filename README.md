# Spurh

> 别找工具，直接粘贴。

Spurh 是一个面向开发者的本地优先、插件优先桌面工具箱。v0.1 只验证一条核心体验：粘贴内容后，Dispatcher 自动识别意图、选择插件并在同一工作区返回结果。

## v0.1 范围

- Dispatcher：本地内容识别、置信度排序与手动兜底
- Plugin Runtime：注册、卸载、动作校验、错误隔离与执行超时
- 内置工具插件：JSON、时间戳、文本处理、随机生成、JWT、Cron、Base64/Hex、URL 编码、SHA 摘要、正则表达式
- UI：默认明亮主题、全局 Dispatcher、工具独立 Session、输入即处理、工具专属结构化结果视图
- AI：OpenAI-Compatible 配置、远程模型列表、实时流式处理；JSON 支持 AI 修复后应用
- 设置：主题、开机启动、系统托盘、AI 模型、作者与版本信息统一管理
- Desktop：Tauri 2 + Svelte 5 + TypeScript

每个工具保存自己的输入、选项和结果，切换工具不会串数据。所有确定性操作会在输入后自动执行，不需要额外的“运行”按钮。未配置 AI 时，确定性工具仍可离线使用；只有用户明确点击“AI 处理”才会把当前内容发送到已配置的模型端点。等待期间界面会实时显示服务商返回的过程或响应流，完成后仍使用与本地结果相同的结果组件。SQLite、WASM Host、剪贴板监听、全局快捷键和系统右键集成不进入 v0.1。

## 开发

要求 Node.js 20+、Rust 1.80+，以及对应平台的 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm run dev
```

桌面开发：

```bash
npm run tauri dev
```

质量检查：

```bash
npm run check
npm test
npm run build
```

## 插件

插件通过 `SpurhPlugin` 契约接入。每个插件声明元信息、动作列表、同步检测器和可异步执行器。运行时负责隔离检测异常、限制执行时间并以统一结果结构交给 UI。

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

插件协议位于 `src/lib/plugins/types.ts`，运行时位于 `src/lib/plugins/runtime.ts`。

## License

MIT
