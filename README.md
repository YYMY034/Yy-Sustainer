# Yy Sustainer

独立的本地 TUI AI agent：任务自动化 + 编码 + 长期记忆 + 定时任务，零 opencode 依赖。

## 快速开始

```powershell
# 1. 安装依赖
npm i

# 2. 配置模型（~/.yyagent/config.json）
{
  "providers": {
    "my": { "baseURL": "https://api.example.com/v1", "apiKey": "sk-..." }
  },
  "model": "my/model-id"
}

# 3. 启动
npm run tui          # TUI 交互界面
npx tsx src/cli.ts run "查当前时间并报告"   # 无头执行
npm start            # 定时任务守护进程（配 pm2 常驻）
```

npm link 后可用全局命令 `yyagent`。

## TUI 功能

| 功能 | 操作 |
|---|---|
| 对话 | 直接输入，Enter 发送 |
| 会话列表（左侧） | Tab 聚焦侧栏 → ↑↓ 选择 → Enter 打开 |
| 切换侧边栏 | Ctrl+B |
| 搜索对话 | `/search <关键词>`（过滤侧栏） |
| 新对话 | `/new` |
| 切换工作目录 | `/cwd <路径>` |
| 本会话模型 | `/model <provider/模型ID>` |
| 添加自己的模型 | `/model add <通道名> <baseURL> <apiKey> <模型ID>` |
| 通道列表 | `/models` |
| 定时任务 | `/tasks` 查看 · `/task run <名称>` 立即执行 |
| 插件状态 | `/plugins` |
| 退出 | `/exit` 或 Ctrl+C |

## 扩展点

| 扩展 | 位置 | 说明 |
|---|---|---|
| 模型 | `~/.yyagent/config.json` | 任意 OpenAI 兼容端点；TUI 内 `/model add` |
| 插件（自定义工具） | `~/.yyagent/plugins/*.ts` | 导出 `{ tools: { 名字: aiTool({...}) } }`，自动加载 |
| 上下文注入 | `~/.yyagent/injections/context.ts` | 导出 `inject(ctx)` 返回拼接文本（**留给用户自己写**） |
| 子智能体角色 | `~/.yyagent/agents/*.md` | frontmatter `name/description` + 正文为 system prompt；内置 researcher/coder/reviewer |
| 长期记忆 | `~/.yyagent/memory/` | 工具 `memory_save/search/read` 自动维护 |
| 定时任务 | `yyagentd.config.json` | cron 表达式 + 提示词 + 模型 |

## 目录结构

```
src/
  cli.ts             入口路由（tui / run / serve）
  main.ts            定时任务守护进程
  agent/
    loop.ts          agent 循环（AI SDK tool-calling）
    tools.ts         内置工具 + delegate 多智能体派发
    memory.ts        长期记忆
    personas.ts      子智能体角色
    permissions.ts   危险命令拦截
    prompt.ts        系统提示词
    inject.ts        上下文注入接口（用户实现）
    config.ts        模型配置
  plugins/loader.ts  插件加载器
  session/store.ts   会话持久化
  tui/App.tsx        TUI（Ink）
bin/yyagent.js       npm bin 入口
```

## 架构说明

- 引擎：Vercel AI SDK（任意 OpenAI 兼容端点）
- 多 agent：主 agent 通过 `delegate` 工具把子任务派发给角色子智能体，可并行
- 权限：无人值守场景禁止 sudo / rm -rf / 提权 / 密钥赋值
- 记忆：文件式（`~/.yyagent/memory`），跨会话持久

---

## 补充说明（2026-09 更新）

### 项目定位

Yy Sustainer 是一个本地优先的 AI agent 运行时，覆盖三种使用形态：

- **TUI 交互**（`npm run tui`）：终端里的对话式任务自动化 + 编码
- **无头执行**（`npm run agent run "<prompt>"`）：脚本化 / CI / 定时触发
- **守护进程**（`npm start` + pm2）：按 cron 调度定时任务

除终端外还提供 Electron 桌面壳（`npm run client`）与 Web 网关（`npm run gateway`）。

### 完整目录结构

```
yyagentd/
  src/                        TypeScript 源码
    cli.ts                    入口路由（tui / run / serve / gateway）
    main.ts                   守护进程入口（start / list / run）
    gateway.ts                Web 网关（REST / SSE 暴露 agent 能力）
    agent/                    agent 核心
      loop.ts                 主循环（AI SDK tool-calling）
      tools.ts                内置工具集（bash/read/write/edit/glob/grep/...）
      memory.ts               长期记忆读写
      personas.ts             子智能体角色加载
      permissions.ts          危险命令拦截
      prompt.ts               系统提示词
      inject.ts               用户上下文注入接口
      config.ts               模型通道配置
    plugins/loader.ts         用户插件加载器
    session/store.ts          会话持久化
    mcp/                      MCP 客户端集成
    tui/                      Ink TUI（React + Ink）
  electron/                   Electron 桌面壳
  web/                        Web 前端（配合 gateway）
  bin/yyagent.js              npm bin 入口（全局 `yyagent` 命令）
  scripts/                    辅助脚本
  logs/                       运行日志
  AGENT-WHITEPAPER.md         架构与交接白皮书（设计取舍、踩坑、下一个 agent 该看什么）
  ecosystem.config.cjs        pm2 守护配置
  yyagentd.config.json        定时任务定义
```

### 常用 npm 脚本

| 命令 | 作用 |
|---|---|
| `npm run tui` | 启动终端交互界面 |
| `npm run agent run "<prompt>"` | 无头执行一条 prompt |
| `npm run client` | 启动 Electron 桌面客户端 |
| `npm run gateway` | 启动 Web 网关（供 `web/` 前端调用） |
| `npm start` | 启动定时任务守护进程（配合 pm2） |
| `npm run list` | 列出已注册的定时任务 |
| `npm run run <name>` | 立即执行一次指定定时任务 |
| `npm run typecheck` | TypeScript 类型检查 |

### 关键配置文件

| 文件 | 作用 |
|---|---|
| `~/.yyagent/config.json` | 模型通道与默认模型（`providers` + `model`） |
| `yyagentd.config.json` | 定时任务列表（`cron` / `prompt` / `cwd` / `enabled`） |
| `ecosystem.config.cjs` | pm2 守护配置（重启策略、日志路径、日志合并） |
| `tsconfig.json` | TypeScript 编译配置 |
| `package.json` | 依赖 + scripts + `files` 白名单 |

### 用户数据目录（首次运行自动创建）

```
~/.yyagent/
  config.json          模型配置（providers + 默认 model）
  sessions/            会话历史（TUI 左侧列表）
  memory/              长期记忆（user / project 分层）
  agents/              子智能体角色 .md（内置 researcher / coder / reviewer / explore）
  plugins/             用户自定义工具 .ts（导出 `tools`）
  injections/          用户上下文注入 .ts（导出 `inject(ctx)`）
  db/                  场景数据库（notes / contacts / knowledge）
```

### 用 pm2 常驻守护进程

```powershell
# 安装 pm2（一次性）
npm i -g pm2

# 启动守护进程
pm2 start ecosystem.config.cjs --env production

# 观察日志
pm2 logs yyagentd

# 关机/重启后自动拉起
pm2 save
pm2 startup
```

守护进程读取 `yyagentd.config.json`，按 `cron` 表达式调度；`enabled: false` 的任务不会跑。

### 更多细节

架构设计取舍、踩坑记录、给下一个接手的 agent 的完整指南见同目录 **`AGENT-WHITEPAPER.md`**——那是下一个接手的人应该先读的第一份资料。
