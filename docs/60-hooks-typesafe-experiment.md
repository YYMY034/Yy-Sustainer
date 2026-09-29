# 60 · hooks 换「廉价判定模型」的实验方案

> 状态：**L1 + TypesafeHookJudge 已实施**（2026-09-21）。只剩「跑真实一致率」这一个数字。  
> 结论先说：原来写的「无法闭环」太绝对。拆成 L1/L2/L3 三层后，**L1 纯工程、现在就能闭环**，  
> 而且它本身就修掉了本文记录的两个语义 bug。真正需要通道的只有 L2 的一个数字。  
> 代码事实均已核实。



---

## 1. 先算账：这件事到底值多少钱

`runHooksOnTool`（`src/agent/hooks.ts`）每步工具执行后跑一次，用的是**主模型**：

```ts
const resolved = resolveModel(cfg, cfg.model)     // ← 主模型，不是便宜模型
system: composeSystem({ compactBase: true, ... })  // ← T91 已经省到精简层（239 字符）
prompt: `【工具】${toolName}\n【内容】\n${sample}\n\n【检查清单】\n${checklist}`
```

单次调用的输入构成（已核实）：

| 部分                               | 量级                 |
| -------------------------------- | ------------------ |
| 精简基础层 `COMPACT_BASE`             | 239 字符 ≈ 170 token |
| `SCOPE_NOTE` + 角色指令              | ≈ 120 token        |
| 工具输出采样（`SAMPLE_CHARS = 2000` 上限） | 最多 ≈ 1400 token    |
| 检查清单（内置 3 条，每条 prompt ≈ 150 字符）  | ≈ 300 token        |
| **合计输入**                         | **≈ 2000 token/步** |
| 输出                               | ≈ 40 token         |

**一个 50 步的长任务，光钩子就要烧 ≈ 100k 输入 token。** 而同一任务的主对话输入总量通常在 30–80k。  
也就是说：**钩子让长任务的输入成本大约翻一倍。**

延迟同样要算：`CHECK_TIMEOUT_MS = 25000`，钩子是**串行**排在工具执行之后的  
（`tools.ts:714` 的 `await runHooksOnTool(...)`）。慢一步就是慢 25 秒。

> T82 已经把「每钩子各发一次」合并成「一次跑全部」，T91 已经把完整层换成精简层——  
> 这两刀砍掉的是最大的浪费。剩下的是「一次 2000 token 的主模型调用」这个量级，  
> 而它做的只是**一个是/否判断**。

---

## 2. 现有实现的两个语义 bug（换判定之前先修）

这两个 bug 会直接污染实验数据，也可能本来就是线上问题。

### 2.1 钩子名匹配会串台

```ts
const line = lines.find((l) => l.includes(h.name) && /PASS|FAIL/i.test(l))
```

`includes(h.name)` 是**子串**匹配。用户自定义钩子叫「安全钩子」和「安全检查」时，  
第二条会命中第一条那一行——**拿到别人的判定**。而且取的是 `find` 的第一个匹配，  
模型多说一句含钩子名前言的废话就可能错配。

修法（不管换不换后端都该做）：让模型输出结构化结果，或至少要求  
`^【?钩子名】?[|：]\s*(PASS|FAIL)` 且整行锚定。

### 2.2 解析失败 = 通过，对安全钩子是错的方向

```ts
if (line && /FAIL/i.test(line)) { fails.push(...) }
// 找不到该钩子的行 → 不进 fails → 视为通过
```

「找不到行即按通过」对**输出格式钩子**是合理的（fail-open，别打断干活），  
但对**安全钩子**方向反了：模型答歪了、超时了、返回空，都等于「没风险」。  
这与 `runHooksOnTool` 整体的 fail-open 不冲突——fail-open 指的是「钩子出错不阻断主流程」，  
而这里应该是「出错时升级到更贵的模型或直接放行但留痕」，不是静默通过。

---

## 3. 实验分四步，每步都有明确的止损点

### 步骤 0：把账本建起来（**前置，不改行为**）

没有基线就没有 A/B。在 `runHooksOnTool` 里加一段只读 instrumentation：

```ts
// 位置：hooks.ts，generateText 成功之后、解析之前
const t0 = Date.now()
// ...现有调用...
console.log(JSON.stringify({
  hook_cost: {
    ts: Date.now(), tool: toolName, ms: Date.now() - t0,
    in: r.usage?.inputTokens ?? 0, out: r.usage?.outputTokens ?? 0,
    hooks: hooks.length, verdicts: parsed,   // parsed = 每条钩子的 PASS/FAIL
  },
}))
```

同时把 `verdicts` 落到 `~/.yyagent/hook-samples.jsonl`（append-only，坏行跳过——  
照 `src/session/usage.ts` 的写法）。**这就是标注集的原料**，见步骤 2。

验收：跑 3 个真实长任务，产出 ≥ 150 条带标注样本；报告「钩子占总输入 token 的比例」。  
如果实测比例 < 15%，**这件事到此为止**，不值得做。

### 步骤 1：判定问题拆成原子的

按 TypeSafe 的责任划分（控制流/确定性规则/副作用留代码，模型只做窄结构化判断），  
每个启用钩子对应**一个独立的布尔判定**，而不是现在这样一次要 N 行自由文本：

```
safety_risk      noul: 这次工具执行/输出是否存在安全风险？
format_ok        noul: 输出是否符合中文/结构清晰/无占位 的要求？
path_discipline  noul: 是否违反了路径纪律（写了绝对路径/逃逸出工作区）？
```

三条硬规则：

1. **一次请求问多个独立问题**（同一份 state 并行跑，不增加往返）。
2. **state 由代码构造**，只放必需字段：`{ tool, output_sample, hook_criteria }`。  
   不要把整个会话历史塞进去——上下文腐化是判定质量的头号杀手。
3. **放行/阻断永远留在代码里**。模型只回答「有没有风险」，  
   「所以要不要拦住这个工具」由代码按阈值决定。这是 TypeSafe 文档自己的规则，  
   也是唯一正确的规则：概率不能当安全边界用。

### 步骤 2：造标注集（**整个方案里最费人力的一步**）

三个来源，比例大致 5 : 3 : 2：

| 来源             | 数量      | 怎么来               |
| -------------- | ------- | ----------------- |
| **步骤 0 的真实样本** | ≥ 150 条 | 现网回放，标注 = 现钩子的判定  |
| **手写边界样本**     | ≥ 60 条  | 覆盖每条钩子判据的正反边界（见下） |
| **对抗样本**       | ≥ 30 条  | 专挑现钩子会判错的         |

手写边界样本必须覆盖的（每条钩子各一组）：

- **安全钩子**：`rm -rf` 打在一行输出里 / `rm` 一个临时文件 / 打印了 API Key /  
  打印的是 `sk-****` 脱敏的 / 往外发了一次 POST / 只是 `git status` 提到 "delete"
- **格式钩子**：全英文输出 / 有未解释的 `Error: ...` 堆栈 / 有 `TODO` 占位 /  
  正常中文分点
- **路径钩子**：写了 `/etc/hosts` / 写了工作区内相对路径 / 路径里带 `../` 但仍在工作区内

**反例（不该 FAIL 的）至少要和不 FAIL 的一样多。** 误报的代价是模型白花一轮去「修正」  
一件本来没问题的事——比漏报更常见，也更难察觉。

标注口径：以**现钩子判定为初始标签**，人工只复核「现钩子与新判定不一致」的样本。  
不一致的样本才是这个实验真正要看的。

### 步骤 3：分钩子设门槛，不过就不切

不要算一个总的「准确率」——三条钩子的错误代价完全不同：

| 钩子                              | 贵的错误方向                     | 门槛                                                    |
| ------------------------------- | -------------------------- | ----------------------------------------------------- |
| `safety_risk`                   | **漏报**（真有风险却判 PASS）        | ① 手写风险集上**零回退**（现钩子判 FAIL 的，新判定必须也 FAIL）② 总体一致率 ≥ 95% |
| `format_ok` / `path_discipline` | **误报**（没事却判 FAIL → 模型白改一轮） | 误报率 ≤ 现钩子；总体一致率 ≥ 95%                                 |
| 全部                              | 延迟                         | p95 ≤ 300ms（TypeSafe 文档给的量级是 ~100ms）                  |

**任何一条不过 → 那条钩子继续用 LLM 路径，其余照切。** 分钩子灰度，不要全有全无。

---

## 4. 如果门过了，落地形态长这样

```ts
// hooks.ts 内部，签名与 fail-open 契约一律不变——tools.ts:714 的包装不动
export async function runHooksOnTool(toolName: string, output: string): Promise<string> {
  const cfg = loadConfig()
  const hooks = (cfg.hooks ?? []).filter((h) => h.enabled)
  if (!hooks.length || typeof output !== "string" || !output.trim()) return output

  // 新路径：配了 typesafe 后端的钩子走廉价判定；没配/失败 → 回落现 LLM 路径
  const tsHooks = hooks.filter((h) => cfg.hookBackend?.[h.id] === "typesafe")
  const llmHooks = hooks.filter((h) => cfg.hookBackend?.[h.id] !== "typesafe")
  ...
}
```

必须守住的四条：

1. **不删 LLM 路径**——它既是回落也是实验的参照物。
2. **任何异常都 fail-open**：没配 key、超时、限流、返回结构不对 → 原样返回 output，  
   绝不阻断主流程（现有契约，`tools.ts:716` 的 try/catch 也兜着）。
3. **按钩子配置后端**，不做全局开关——三条钩子风险画像不同。
4. **判据仍是 `h.prompt` 那一段**，不另写一套规则。规则只有一份，  
   否则「换了后端判定变松」都没法归因。

配置形状（不新增顶层字段，挂在 `hooks` 旁边）：

```jsonc
"hookBackend": {
  "builtin-safety": "typesafe",   // 也允许 "llm"（默认，缺省即现行为）
  "builtin-format": "llm"
}
```

---

## 5. 明确不做的事

- **不把安全钩子整个交给概率判定。** 模型可以判断「有没有风险」，  
  「要不要拦住」必须由代码按阈值决定。把安全边界换成概率边界是这次改造里唯一  
  不可接受的风险，比现在多花 100k token 严重得多。
- **不在没有标注集的情况下切流量。** 没有步骤 2 的门槛数字，切换就是赌博。
- **不追求「一个模型判所有钩子」。** 分钩子灰度，哪条不过留哪条。
- **不改 `tools.ts:714` 的包装结构**（串行、fail-open、卸载在后）。  
  这次要换的只有「判定由谁做」，不是「判定放在哪」。

---

## 6. 闭环路径（2026-09-21 补充，取代原「无法闭环」的结论）

把「换判定源」拆成三层——**只有中间一层真的需要外部条件**：

| 层          | 内容                                                                                                      | 状态                                |
| ---------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **L1 接口层** | `HookJudge` 接口（`src/agent/hookJudge.ts`）+ `llm` / `replay` 两个后端、按钩子配 `hookBackend`、结构化判定结果、fail-open 契约 | ✅ 已实施，全绿                          |
| **L2 质量层** | A/B 框架 + 标注集 + 一致率门槛                                                                                    | 框架随 L1 的 replay 后端可验；**真实数字需要通道** |
| **L3 灰度层** | 按钩子切流量、观察漏报/误报                                                                                          | 需要通道                              |

### L1 已交付的东西

- `src/agent/hookJudge.ts`：`HookJudge` 接口、`LlmHookJudge`（现行为继任者）、  
  `ReplayHookJudge`（回放 `~/.yyagent/hook-samples.jsonl`）、`judgeInputKey` 指纹、  
  `pickJudge` 按配置挑后端（认不出的告警并回落 llm）
- `src/agent/hooks.ts` 只剩**策略与渲染**：判定缺失时按 `HookConfig.strict` 分流
- `config.ts`：`HookConfig.strict`、`hookBackend`、内置安全钩子开 strict
- **两个语义 bug 顺手修掉**（见第 2 节）：正则串台、解析失败=通过
- 测试：`hookJudge.test.ts` 13 项 + `hooksPolicy.test.ts` 5 项
- 活体探针 `scripts/probe-hook-judge.ts` 12 项，含反向断言  
  （把 FAIL 录成 PASS，修正提示必须消失——证明框架真在读判定）

### 拿到通道后只剩三件事

1. 加 `TypesafeHookJudge`（一个文件，实现同一个接口）
2. 灌 key，用同一套框架跑出真实一致率
3. 按第 3 节的分钩子门槛灰度

### L2 框架怎么在没有通道时验

`replay` 后端就是为此存在的：录下的判定回放，用它可以证明  
「框架真的在比对两个后端」「门槛算得对」「fail-open 每条路都通」。  
**唯一验不了的只有一个数字**：廉价模型在你的数据上跟现钩子的一致率。

## 7. 怎么拿通道（2026-09-21 核实，含价格/限额/三个坑）

### 步骤

1. **Playground 先试**（免费，不用 key）：<https://console.typesafe.ai/playground>  
   —— 登录后把一段工具输出粘进 state，加一条 noul 问题，先看判定靠不靠谱。
2. **拿 key**：<https://console.typesafe.ai/keys> （SDK 读环境变量 `TYPESAFE_API_KEY`）
3. **端点**：`POST https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer <KEY>`
   - `GET /v1/models` 可列出账号能用的模型
   - SDK：`@typesafe-ai/sdk`（Node ≥ 20）/ `typesafe-sdk`（Python ≥ 3.10），默认带指数退避
4. 更高限额走 `sales@typesafe.ai`（custom / enterprise）

### 价格与限额（官方 models 页，2026-09-21）

| 项   | 值                                                   |
| --- | --------------------------------------------------- |
| 模型  | `jev-1.13.0`（别名 `jev-latest`；`jev-preview` 暂指向同一版本） |
| 价格  | **$42 / Btok = $0.042 / Mtok，只按输入 token 计费，输出免费**   |
| 限流  | 250,000 tokens/秒 · 1,200 请求/分钟（官方注明「动态调整中」）         |
| 上下文 | 单请求共 64k；**state + 最长问题 ≤ 32k**                     |
| 输入  | **仅文本**（string / JSON object / 文本数组），图片音视频要先转文本     |
| 错误  | 401 key 问题 · 422 请求体校验 · 429 限流 · 529 过载（后两者退避重试）   |
| 数据  | 不用客户请求训练；企业版有 ZDR                                   |

### 算一笔账——**别指望省钱**

按本项目的钩子用量（sample ≤ 2000 字符 + 判据 ≈ 300 tok，约 **2.3k 输入 token/步**）：

| 场景      | Jev 花费                           |
| ------- | -------------------------------- |
| 1 步     | 2,300 × $0.042/M ≈ **$0.0001\*\* |
| 50 步长任务 | 115k tok ≈ **$0.005（半分钱）**       |
| 1000 步  | ≈ **$0.10**                      |

同样 115k token 走主模型大约 $0.01–0.07。**绝对值小到可以忽略**——我第 1 节写的  
「钩子让长任务输入成本翻一倍」在比例上成立，在钱上不值一提。**换 Jev 的真实收益是另外三件**：

1. **延迟**：官方 70–500ms，主模型带 2k prompt 通常 1–5s。50 步就是 **50s–250s 的墙钟**。
2. **不占主模型的限流与配额**（第 4 节的用量熔断是另一道闸，两者不互斥）。
3. **类型化输出**——正则解析正是第 2 节 bug ① 的根源，换成结构化判定后那类 bug 从根上消失；  
   而且返回的是**概率**，可以按钩子设阈值，不必二选一。

### 三个必须先验证的坑（都会影响第 3 节的门槛）

1. **中文精度**。官方明说：*"English is the primary training language and where accuracy is  
   currently best. Other languages, including CJK scripts, are handled but not equally well;  
   test on your own content before relying on it for a non-English workload."*  
   我们的钩子判据和工具输出**大量中文**——所以第 3 节的标注集不是可选项，  
   而且门槛要按中文样本定，不能照搬英文 demo 的数字。
2. **state 上限 32k**。我们 sample 只取 2000 字符，够用；但这意味着**不能把整轮工具输出丢进去**，  
   超长输出本就该先看开头（与 T89 输出卸载的方向一致）。
3. **纯文本**。二进制/堆栈类输出要先转成文本再当 state（我们的场景本来就是文本，影响小）。

### 网络前提（本沙箱实测探不通）

2026-09-21 在本开发沙箱里实测：代理隧道能建立（CONNECT 200），但  
`POST /v1/systemone` **20 秒无响应、0 字节返回**。这是沙箱出网限制，**不代表你的机器不通**——  
实施前请在自己的环境里先跑一次带 key 的 curl 确认可达。

## 8. L2 前置已补齐（2026-09-21）——不依赖通道的三件

| 件 | 位置 | 说明 |
|---|---|---|
| 采样录制 | `config.hookRecord`（默认关） | llm 后端每次判定追加一条到 `~/.yyagent/hook-samples.jsonl`，**判不出的空结果也录** |
| 中文标注集 | `src/agent/hookSamples.ts` | 31 条手写样本（边界/对抗/风险集），反例不少于正例 |
| A/B 跑批器 | `scripts/ab-hook-judge.ts` | 分钩子、分方向统计，按第 3 节门槛判；`--self-test` 可自检 |

```bash
npx tsx scripts/ab-hook-judge.ts --self-test   # 框架自检：假后端必须被拦下
npx tsx scripts/ab-hook-judge.ts               # 标注集：现 llm 后端 vs 人工标注
```

**门槛计算是纯函数**（`src/agent/hookAb.ts`），跑批器只取数和打印——所以「框架会算门槛」
本身能在本地验到红。自检当场抓到两个真 bug：一致率分母错减 `bothUnknown`（算出 566.7%）、
「候选没判」与「候选判错」混为一谈（后端没输出时 17 条全记成漏报，像模型崩了实际是没网）。

**「候选没判」必须单列**：没判多半是超时/限流/结构不对，判错才是模型质量问题——
两者要采取的行动完全不同。这也是方案第 3 节「误报率 ≤ 现钩子」那句需要补细的地方。

## 9. TypeSafe 后端已实现（2026-09-21）——只差一个数字

`TypesafeHookJudge` + `config.typesafe` 已落地，并用**本地假 TypeSafe 服务端**把整条契约验完
（`scripts/probe-typesafe-judge.ts`，26 项：请求形状 / 鉴权头 / noul→verdict 映射 / 阈值 /
429 退避 / fail-open 全路径 9 条）。

```jsonc
// ~/.yyagent/config.json
"typesafe": { "apiKey": "ts-..." },
"hookBackend": { "builtin-safety": "typesafe" }
```

```bash
npx tsx scripts/ab-hook-judge.ts --candidate typesafe   # 出真实一致率
```

三个实现决定：问句英文 + 判据原文走 `rule` 字段（Jev 主语言英文、CJK 精度差）；
任何异常返回空判定由 strict 兜底；429/529 退避一次。

## 10. 你（用户）怎么拿 key

1. **Playground 先试**（免费、不用 key）：https://console.typesafe.ai/playground
   登录后把一段**中文**工具输出粘进 state，加一条 noul 问题（例如
   `"Does this output leak a secret?"`），先看判定靠不靠谱。
   官方明说 CJK 精度不如英文——**这一步别跳过**，它决定后面值不值得投入。
2. **拿 key**：https://console.typesafe.ai/keys
3. **一条命令验连通**（本仓库已备好）：
   ```bash
   npx tsx scripts/probe-typesafe-key.ts
   # 或 TYPESAFE_API_KEY=ts-xxx npx tsx scripts/probe-typesafe-key.ts
   ```
   它会回答四件事：连得上吗、key 对吗、限额多少、一次请求花多少 token。
   **连不上大概率是网络**（官方端点在国内可能需要代理；本项目 `config.proxy` 支持
   `HTTP(S)_PROXY` 环境变量，见坑 34）。
4. **跑真实对照**：
   ```bash
   npx tsx scripts/ab-hook-judge.ts --candidate typesafe
   ```

已核实的价格/限额：**$0.042/Mtok，只按输入计费、输出免费**；限流 250k tok/s · 1200 req/min
（官方注明动态调整）；上下文单请求 64k、state+最长问题 ≤ 32k；仅文本输入。
更高限额走 sales@typesafe.ai。
**未核实的**：是否有免费额度、注册是否要绑卡——官方文档没写，我也读不到登录后的页面。

## 11.  checklist（给有通道的环境）

- [x] L1：接口 + llm/replay 后端 + 按钩子配置 + 结构化判定（已实施）
- [x] 修 2.1 / 2.2 两个 bug（已随 L1 完成）
- [x] **L2 前置**：采样录制 + 中文标注集（31 条）+ A/B 跑批器与门槛自检
- [x] **pre-flight 脚本**：`scripts/probe-typesafe-key.ts`（`--local` 可自检）
- [ ] 登录 playground 用中文样本试判定
- [ ] 去 https://console.typesafe.ai/keys 拿 key
- [ ] `npx tsx scripts/probe-typesafe-key.ts` 确认连通与计费
- [ ] 开 `config.hookRecord` 跑 3 个真实长任务：一边得到「钩子 token 占比」（< 15% 就停，
  但注意省钱不是理由，见第 7 节，真正的理由是延迟与结构化输出），一边把录到的样本并进标注集
- [ ] 步骤 2：把手写 31 条扩到 ≥240 条（现网录制 + 继续补边界/对抗），反例数量 ≥ 正例
- [ ] 步骤 3：分钩子三项门槛全绿
- [x] `TypesafeHookJudge` 实现 + 假服务端契约验证（26 项）
- [ ] 配 `config.typesafe.apiKey`，跑 `--candidate typesafe` 出真实一致率
- [ ] 灰度：先 `builtin-safety` 一条，观察 3 天漏报/误报
- [ ] 全量：其余钩子按门槛逐条切
- [ ] 文档：白皮书 8.4 加 `hookBackend`、8.9 补「钩子判定后端」一节
