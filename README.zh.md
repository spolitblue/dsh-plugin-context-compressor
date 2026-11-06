# dsh-plugin-context-compressor

[English](README.md) | 中文

给 DeepSeek Harness 用的**面向模型的上下文压缩插件**。

## 为什么做这个

DSH 本身已经会压缩长对话：`@deepseek-ai/dsh-compaction-basic` 在 token 压力升高时自动压缩，
`@deepseek-ai/dsh-command-compact` 给人类一个 `/compact` 命令。两者都已挂在 `dsh-base` 里。

但 Harness **没有**提供任何让*模型自己*感知上下文压力并主动处理的接口。
compaction 包把这一点写成了已知限制：

> **Human command, not a model tool** —— 压缩只由 `/compact` 命令和自动压力触发；
> 没有注册任何面向模型的压缩工具。

于是长时间跑的任务只能干等自动阈值被跨过。这个插件补上这块缺口：
两个工具，让 agent 能测量自己的上下文并主动释放。

## 两个工具

### `context_status` —— 只读、可并行

测量当前对话表面，报告现在能压掉多少：

- 表面总 token，以及 system prompt 与消息的拆分；
- 是否挂载了压缩后端；
- `context_compress` 会替换的具体区间，以及会原样保留的尾部有多少；
- 可选列出逐个表面项（`seq` / `kind` / `tokens`），让模型看清是什么占满了上下文。

适合在开始一大段阅读或检索之前先判断要不要腾地方。

### `context_compress` —— 独占执行

通过已挂载的 `ctx.compaction` 后端，把对话中最早的一段安全区间替换成一条摘要检查点，
近期尾部原样保留。支持 `dryRun` 预演，不改动任何东西。

## 实现要点

一切走与后端无关的 compaction seam（`ctx.compaction`），因此本插件兼容任意后端，
自己也从不写 session 事件。

真正有意思的是**该调哪个操作**。seam 有两个入口，前置条件正好相反：

| 操作 | 前置条件 | 工具调用里能用吗 |
|---|---|---|
| `compactNow(agent, …)` | agent 必须**空闲**（走 `agent.runMaintenance`） | **不能** —— 工具调用发生在回合内，必定 `busy` 失败 |
| `compactRegion(start, end, agent, signal)` | session 必须有**开启的回合** | **能** —— 工具调用正处在回合内 |

所以面向模型的压缩器只能建立在 `compactRegion` 之上，并且选出的区间必须不能把某一步的
「assistant 工具调用 / 工具结果」配对切开。本插件用与自动路径相同的保留策略和配对规则来选区，
并复用 `@deepseek-ai/dsh-compaction` 公开的 `toolPairingBalancedBefore`，而不是自己重写配对折叠。

`context_compress` 另外**不**声明并发安全，因此工具注册表会以独占方式运行它，
绝不会和同批的工具调用争抢同一个表面。

## 配置

插件的 `Config` 在激活时校验，因此这些值写进你自己的 patch 层
（`$DSH_PROFILE_DIR/cordis.patch.yml`），升级不丢：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否注册这两个工具。关掉则插件挂着但不做事。 |
| `keepRecentTokens` | `20000` | `context_compress` 默认原样保留的近期尾部（token）。 |
| `minCompactTokens` | `2000` | 小于此值的区间直接拒绝，免得为省几百 token 白花一次摘要调用。 |
| `maxNodesListed` | `60` | `context_status` 里表面清单的行数上限。 |

模型可以在单次调用里覆盖 `keepRecentTokens` 与 `dryRun`。

## 安装

在 Harness Web UI 的 Plugin Manager 页面里指向本包目录，或用命令行：

```
dsh plugin --profile desktop add <本目录绝对路径>
```

安装 bundle 会把它加进 profile 的 `dsh.profile.bundles`，这正是让它的
`cordis.patch.yml` 层生效的原因。新装的 bundle 可以通过 HMR 激活；
替换已安装的包则需要重启。

### 兼容性

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-compaction` 的 `peerDependencies`
会与唯一运行中的 DSH 运行版本比对，不匹配会让 Harness **直接跳过该 bundle**。
当前锁定 `^0.2.0-rc.2`，即本插件构建并验证所针对的版本。DSH 升级时需要放宽。

这些 peer 声明同时也是插件 bare import 能被解析的原因：
DSH 只对 linked 包声明为 peer 的名字，才把它路由到运行时表。

## 测试

```
node --test "tests/*.test.js"
```

20 个单元测试覆盖纯逻辑层——区间选择（首部 system prompt 永不压缩、尊重保留预算、
绝不切开工具调用与结果、测量对不齐时退化为不动作）以及报告的算术与措辞。
不需要 Harness 会话即可运行。

## 已验证行为

针对 `dsh --profile cct-test`（从自带 `headless` 模板新建的一次性 profile）
配合压低保留预算的 overlay，做了端到端验证：

- 默认 20000 token 尾部时，`context_status` 对短对话报 `no-safe-range`；
  压低尾部后报 `compressible` 并给出区间与 token 数——两个方向都符合预期。
- `context_compress` 的 `dryRun` 预演准确且不改动任何东西。
- `context_compress` 真实提交了检查点：
  `Compressed 5 history items (~1,159 tokens) into one summary checkpoint (seq 28).
  The conversation surface is now ~1,616 tokens.`
- 插件激活无任何启动警告，进程 exit 0。

## 已知限制

- **极小区间可能摘要失败。** 自带后端会拒绝产出空文本的摘要，而近乎空的输入就可能触发。
  默认的 `minCompactTokens: 2000` 让工具避开这种情况；真遇上时插件会把失败
  当作模型可读的结果上报，而不是破坏会话。
- **压缩救不了当前这一步。** 释放出来的上下文对*下一次*请求生效，
  不会缩小正在组装的这一次请求。
- **摘要调用本身花 token。** 它复用对话自身的前缀以便命中 KV cache，但终究是一次模型调用。
- **没有区间参数。** 与程序化的 `compactRegion` 不同，工具只接受保留预算，
  不接受显式表面序号。若将来模型确实需要指定区间，这是一个合理的后续扩展。

## 目录结构

| 路径 | 作用 |
|---|---|
| [`index.js`](index.js) | 插件入口：`apply`/`inject`/`Config`、两个工具定义、表面读取、区间规划 |
| [`src/selection.js`](src/selection.js) | 纯区间选择与 token 定价 |
| [`src/report.js`](src/report.js) | 纯组合算术与面向模型的措辞 |
| [`cordis.patch.yml`](cordis.patch.yml) | 插入插件行的 bundle 层 |
| [`tests/selection.test.js`](tests/selection.test.js) | 区间选择测试 |
| [`tests/report.test.js`](tests/report.test.js) | 报告测试 |
