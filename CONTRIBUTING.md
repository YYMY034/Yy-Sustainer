# 参与贡献

Yy Sustainer 是一个本地优先的 AI agent 运行时（Windows 优先，TypeScript 全栈）。欢迎 issue 和 PR。

## 环境

1. Node.js ≥ 20，`npm i`
2. 配置模型：`~/.yyagent/config.json`（任意 OpenAI 兼容端点），或参考 [README](../README.md) 从源码运行
3. 常用命令：`npm run typecheck`（类型检查）、`npm test`（单测）、`npm run gateway`（网关）、`npm run tui`（TUI）

## 改动纪律（重要）

这个仓库的回归不靠人工记忆，靠**钉死的断言**。改任何子系统前先读 `AGENT-WHITEPAPER.md` 第八章「系统规范」
（必须/禁止/不变量清单）。PR 请遵守：

- 改公共模块（`src/util/**`、`src/session/**`、`src/agent/prompt.ts`、权限、提示词装配）必须跑
  `npm run test:all`（全量 check + 单测），不能只跑单个脚本
- 修 bug 或改行为时**新增或更新回归断言**（`scripts/check-*.mjs` 前缀会被全量跑批器自动收录）；
  断言要「见它红过」才算数（造错 → 报红 → 还原）
- 失败信息必须带实际值；每类断言要有反向用例（错误的方法/路径不得接管）
- 网关路由增删后跑 `npx tsx scripts/probe-routes.ts --check`；配置字段增删后跑
  `npx tsx scripts/probe-config.ts --check`（文档与代码不许漂移）
- 提交信息用中文一行说明「改了什么、为什么」

## 提 issue

- Bug 报告请附「诊断导出」的 JSON（设置页 → 数据与安全 → 下载诊断；已脱敏，不含密钥与对话内容）
- 功能建议先说场景再说方案
