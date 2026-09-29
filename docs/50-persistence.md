# 50 · 运行时状态落盘方案：bgTasks 与 undoSnapshots

> 状态：**B0 / B1 / B2 / B3 全部已实施**（B0/B1/B2 于 2026-09-20 同轮落地，B3 前端按钮置灰于 2026-09-21，见白皮书 10.22）。本文保留设计取舍记录；实施结果与两个「测试逮到的真 bug」见白皮书 10.18。
> 本文只做设计与取舍记录，不动代码。实施时按第 6 节的顺序分批落地，每批独立可回滚。

---

## 1. 为什么要单独出方案

前几轮（T93 P0/P1/P2）修的都有同一个形状：**东西写好了，就是没接上**。
这一项不一样——它要新增的是**把用户文件的内容复制到 `~/.yyagent/`** 这件事本身。
所以先讲清楚代价，再决定做到哪一档。

两个目标的收益差得很远，必须分开决策：

| 目标 | 现状 | 丢了什么 | 风险 |
|---|---|---|---|
| **bgTasks 落盘** | `src/agent/tools.ts:87` 的 `Map<string, BgTask>` | 只有**元数据**（pid/命令/日志路径/开始时间/退出码）。日志文件本来就在磁盘上 | 极低——不含用户文件内容 |
| **undoSnapshots 落盘** | `src/gateway.ts:110` 的 `Map<sessionId, Map<ts, FileEdit[]>>` | **改前的完整文件内容**（`FileEdit.snapshot`） | 高——等于把工作区文件复制一份到 `~/.yyagent/` |

结论先给出：**bgTasks 直接做；undoSnapshots 做，但默认关、按档位、带硬上限。**

---

## 2. 现状（核实过的调用点，不是读注释）

### 2.1 bgTasks

- `interface BgTask { pid, command, logFile, startedAt, done, exitCode }`（`tools.ts:78`）
- `const bgTasks = new Map<string, BgTask>()`、`let bgSeq = 0`（`tools.ts:87-88`）
- `startBackground()`（`tools.ts:92`）：`spawn("powershell.exe", …)`，
  **没有 `detached: true`**；stdout/stderr 管道接到 `~/.yyagent/bg/bg-N.log`
- 清理：`sweepOldFiles(logDir, { keep: 50, maxAgeMs: 7d, suffix: ".log" })`（`tools.ts:100`）
  —— **只扫 `.log`**，所以任何非 `.log` 的索引文件不会被误删，但也意味着它不会被清理
- 模型侧两个入口（`tools.ts:198` / `tools.ts:213`）：
  - `bg_read()` 无参 → 列内存 Map；查不到 → `未找到任务 ${id}`
  - `bg_read(task_id)` → 读日志尾部

**重启后的实际表现**：日志文件还在（7 天内），但 `bg_read()` 列出空、
`bg_read(task_id="bg-3")` 返回「未找到任务」。用户/模型看得到日志路径却拿不到上下文。

### 2.2 undoSnapshots

- `undoSnapshots: Map<sessionId, Map<ts, FileEdit[]>>`（`gateway.ts:110`）
- 采集：`fileTrack.ts:27 trackFileChange()` 在 write/edit **写盘前**读原全文
- 取走：`runTurn` 收尾 `takeFileEdits()` → `per.set(assistantMsg.ts, fileEdits)`（`gateway.ts:576`），
  每会话**最多留 10 轮**，超出删最旧（`gateway.ts:578`）
- 落库的 `StoredMessage.fileEdits` **只有 `{path, kind}`，不含 snapshot**——
  所以前端「修改 N 个文件 + 撤销」按钮在重启后必然失败
- 恢复：`POST /api/sessions/undo-files`（`gateway.ts:2245`），
  查不到时的文案已经点明了病因：`没有该轮的文件快照（可能已撤销或来自更早的会话进程）`

---

## 3. 顺带发现的两个前置 bug（不管要不要落盘都该修）

这两条是这次核实代码时撞上的，都跟本节主题直接相关：

**① `trackFileChange` 读原文件没有大小上限**（`fileTrack.ts:32`）

```ts
const before = … existsSync(absPath) ? readFileSync(absPath, "utf8") : null : null
```

`read` 工具有 `MAX_READ_BYTES = 8MB` 护栏，这里没有。模型 edit 一个几百 MB 的文件
（日志、数据库、`node_modules` 里的产物）→ 整个进程被撑爆。
**这是现存 bug，不是落盘带来的。** 落盘后它会从「OOM」变成「磁盘打满」，所以必须先修。

修法：超过阈值的文件**不采快照**，但仍在 `fileEdits` 里记一条
`snapshot: null` + `skipped: "too-large"`，让前端能说「这轮改的 X 因为太大没有可撤销的快照」，
而不是假装撤成功了。

**② `bgSeq` 重启归零，id 会复用**（`tools.ts:88`）

重启后 `bgSeq` 从 0 开始 → 新任务又是 `bg-1`。一旦落盘，这条新记录会**覆盖**旧 `bg-1` 的记录，
而 `bg-1.log` 可能还在（7 天保留期）→ 模型读到的是错配的日志。
修法：启动时从磁盘记录里取 `max(id)` 回填 `bgSeq`。

---

## 4. 方案 A：bgTasks 落盘（建议直接做）

### 4.1 存储

新模块 `src/agent/bgStore.ts`，文件 `~/.yyagent/bg/tasks.json`：

```ts
interface BgTaskRec {
  v: 1
  id: string            // bg-N
  pid: number
  command: string       // 模型给的命令原文（只存不执行）
  logFile: string       // 服务端构造：~/.yyagent/bg/bg-N.log
  cwd: string
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  /** 重启后对不上进程的：进程可能还活着，但本进程已无从得知退出码 */
  orphaned?: boolean
}
```

**为什么放 `bg/` 而不是新目录**：日志和索引天然一对一分不开，放一起清理规则可以统一。
`sweepOldFiles` 只扫 `.log`，所以 `tasks.json` 不会被它误删——清理规则自己写（见 4.3）。

### 4.2 写入时机

| 时机 | 动作 |
|---|---|
| `startBackground()` | append 一条（原子整文件写，见 4.4） |
| child `exit` | 回填 `endedAt` / `exitCode` |
| 网关启动 | 载入；把 `orphaned` 置位（见下） |

**orphaned 判定**：记录存在但本进程没有对应内存条目。此时**不能**断言进程已死——
Windows 上没有 `detached`，父进程退出后子进程是否存活本就没有保证。
所以只标 `orphaned: true`，UI/模型侧显示「状态未知（网关重启过）」。
**明确不猜**：不写 `exitCode: null` 冒充「已结束」，那会让模型以为任务失败了。

### 4.3 保留与清理

- 记录数上限 **200 条**，超出删最旧（与 `sweepOldFiles` 的 `keep` 同思路）
- 同时遵守日志的寿命：**记录比日志活得更久没有意义**——日志被扫掉时，对应记录一并删
- 节流：和现在一样 5 分钟一次，不做成每次起任务的固定开销

### 4.4 写盘方式

整文件 `writeAtomic`（tmp + rename）。理由同 checkpoint：半截 JSON 比没有更糟。
这里**不需要文件锁**——同一个 id 只可能被一个进程写（启动时回填 `bgSeq` 后不会撞 id）。

### 4.5 模型侧行为变化

`bg_read()` 无参 → 列**磁盘记录 ∪ 内存记录**（按 `startedAt` 倒序）。
`bg_read(task_id)` → 先查记录拿到 `logFile`，再读日志；记录和日志都没有才说「未找到」。

**注意**：这让模型在重启后仍能读到**重启前**启动的后台任务输出。
这是本次改动唯一的行为变化，收益也正在这里——但它同时意味着
「网关重启前跑的某个命令，重启后还能被读」。这些日志本来就在磁盘上、本来就在 7 天保留期内，
所以这不是新增暴露面，只是把已有的东西接上。

---

## 5. 方案 B：undoSnapshots 落盘（分档，默认关）

### 5.1 先定安全规则（这些是硬约束，不是可选项）

1. **绝不快照 `~/.yyagent/` 内部的路径。** 那里有 `.master.key`、`config.json`、
   `sessions/`（含附件）。快照它们 = 把密钥复制一份到另一个位置，还可能导致递归。
2. **单文件上限**（默认 512 KB）与**单轮上限**（默认 2 MB）。超过就不采快照，
   记 `skipped: "too-large"`（见第 3 节 ①）。
3. **总预算**（默认 64 MB）。超出按最旧优先淘汰。
4. **原子写 + 版本号**。读不出来/版本不符 → 当作没有，回落到内存路径。
5. **默认不启用。** 配置 `undo.persist` 缺省 `false`，行为与今天完全一致。
   要用的用户在 `config.json` 里显式打开——**打开前应该知道自己同意了什么**
   （工作区文件内容会复制到 `~/.yyagent/`）。

### 5.2 配置

```jsonc
// ~/.yyagent/config.json
"undo": {
  "persist": false,          // 默认关。true = 快照落盘，重启后仍可撤销
  "maxTurnBytes": 2097152,   // 单轮上限
  "maxTotalBytes": 67108864, // 总预算，超出淘汰最旧
  "keepDays": 7              // 与 bg 日志一致的寿命
}
// 单文件上限**没有**做成配置项——它沿用采集侧的 MAX_SNAPSHOT_BYTES（进程安全线）。
// 为同一个限制开两个入口，迟早会漂（config.longTask 就是这么来的）。
```

字段必须**被真正读到**（`loadConfig().undo`），不能重蹈 `config.longTask` 的覆辙——
那条的教训是「写了两份来源，其中一份没人读」。落地时用静态断言钉住：
`gateway.ts` 里必须出现 `loadConfig().undo`，且 `config.ts` 里只能有一处定义。

### 5.3 存储布局

```
~/.yyagent/snapshots/
  <sessionId>/
    <assistantMsgTs>/            # 一轮一个目录，ts 即前端的撤销按钮参数
      index.json                 # { v, sessionId, ts, files: [{path, kind, skipped?}] }
      <sha1(path) 前 16 位>.snap  # 快照明文；snapshot=null（新建）的不建文件
```

- **内容寻址**（复用 `attachments.ts` 的思路）：同一文件在同一轮被多次 edit 只存一份
- **路径只进 `index.json`，不进文件名**——避免 Windows 路径字符/长度问题，
  也避免把工作区目录结构泄露到文件名里
- **不设权限位特殊处理**：沿用 `~/.yyagent` 的默认权限。`.master.key` 已被 5.1-1 排除，
  其余文件与 T83 备份里已有的东西同级

### 5.4 恢复路径：一处定义，两个来源

现在的风险是「内存一份、磁盘一份」写出两套恢复逻辑。做法是**收敛成一个函数**：

```ts
resolveUndoTarget(sessionId, ts): { edits: FileEdit[]; source: "memory" | "disk" } | undefined
```

`POST /api/sessions/undo-files` 只调它。查不到时返回的文案要**说清是哪种情况**：

- 内存有 → 正常撤
- 内存没有、磁盘有 → 正常撤，并在 notice 里注明「来自重启前的快照」
- 都没有 → 区分「已撤销过」和「这一轮没有可撤销的快照（可能文件太大被跳过 /
  超过保留期 / 从未启用落盘）」。现在那句「可能已撤销或来自更早的会话进程」
  把这三种混成一句，用户没法行动。

### 5.5 与 T83 自动备份的关系

**默认不把 `snapshots/` 加进 `backup.ts` 的 `ITEMS`。** 理由：

- 备份的语义是「数据资产」；快照是**派生数据**（工作区文件的副本），真丢了可以从工作区现状推断
- 加进去会让备份体积最多翻倍，而 T83 的 `keep` 是**份数**不是字节数——体积翻倍比份数翻倍更难预料
- `bg/` 同理不加

这一点要写进白皮书 8.5，否则下一个人会以为是漏了。

---

## 6. 实施顺序（每批独立可回滚）

| 批次 | 内容 | 回滚方式 |
|---|---|---|
| **B0** | 修第 3 节两个前置 bug：`trackFileChange` 大小上限 + `skipped` 标记；`bgSeq` 从磁盘回填 | 纯 bug 修复，无配置依赖 |
| **B1** | `bgStore.ts` + `startBackground`/`bg_read` 接线 + 启动扫描 | 删模块、`bg_read` 回退只读内存 |
| **B2** | `snapshots/` 存储 + `resolveUndoTarget()` + undo 端点改造 + `undo.persist` 配置（默认关） | 配置缺省即今天的行为；删目录即回到纯内存 |
| **B3** | 前端：撤销按钮在「有元数据无快照」时置灰并给原因，不再让用户点了才失败 | 前端改动，单独回退 |

**B2 是唯一有风险的批次**，建议单独一个回合、单独跑全量回归。

---

## 7. 验收与守卫

**活体探针**（不随 `run-all-checks` 跑，照 `probe-checkpoint-resume.ts` 的写法）：

- `probe-bg-resume.ts`：起真网关 → 起一个后台任务 → **杀网关** → 重启 →
  `bg_read()` 应列出重启前那条、`bg_read(task_id)` 应读到日志、记录标 `orphaned`
- `probe-undo-persist.ts`：隔离 HOME + `undo.persist: true` → 让模型改一个文件 →
  **杀网关** → 重启 → 撤销应成功；再验证「单文件超限被跳过」时按钮置灰且文案说清原因

**静态守卫**（进 `tests/longtask-wiring.test.ts` 同类）：

- `config.ts` 里 `undo` 只出现一处定义；`gateway.ts` 里必须出现 `loadConfig().undo`
  （防第二份来源）
- 恢复逻辑只有一处出口：`resolveUndoTarget` 之外不得再有第二份「按 ts 找快照」的代码
- 快照路径必须过 `~/.yyagent` 排除判定（反向断言：构造一个 `~/.yyagent/...` 路径必须被拒）
- 原子写不留 tmp；版本不符读不出来
- `bgSeq` 必须从磁盘记录回填（断言启动处有回填写法）

**必须见它红过**：摘掉 `~/.yyagent` 排除 → 探针/断言红；
把 `resolveUndoTarget` 复制成两份 → 静态守卫红。

---

## 8. 明确不做的事

- **不把后台任务改成 `detached`**。那会让任务真正脱离网关生命周期，收益（重启后继续跑）
  和代价（孤儿进程、输出管道在父进程死后行为未定义）都很大，值得单独一轮，不搭这次车。
- **不做快照的增量/压缩**。工作区文件已经在磁盘上，快照是副本；先靠 5.1 的上限控制，
  真到失控再谈。
- **不把 `snapshots/`、`bg/` 加进 T83 备份**（理由见 5.5）。
- **不做跨设备同步**。快照和后台日志都是本机派生数据。
