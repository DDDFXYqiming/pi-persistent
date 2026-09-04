简体中文 | [English](README.en.md)

# pi-persistent

> 给 **Pi Coding Agent** 装上“常驻自主模式”。`/persistent <mission>` 之后，agent 跨 settled 边界继续干活，任务完成后自己找 in-scope 的后续，直到你执行 `/sleep`。没有轮数熔断，写操作被限制在工作区内，全程不阻塞用户。

续派与会话持久化机制参考了 [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions)（MIT）的成熟实践；行为对齐 OpenAI Codex 未公开的 `Persistent mode`（`continue working until put to sleep` + proactivity，见 `codex-rs/core/templates/persistent_mode.md`）。插件不设 `automaticTurns` / `noProgressTurns` 熔断，也不让模型自己决定“收工”。

**停机只有一个出口：用户。** 模型手上的三个动作——继续干、`persistent_wait` 睡一会再自动醒、`persistent_dormant` 真正死胡同——都不是“结束”。工具调用被工作区边界拦截只是**单个动作被拒**，不构成停理（见下）。provider 硬错先退避重试，连续 2 次才进 dormant。

## 它在做什么

- **settled 单飞续派。** 下一条续跑提示只在 `agent_settled` 已触发、`isIdle()` 为真、无排队消息的边界派发，自动重试、compaction、排队 follow-up 都先排干，不会重复派发。派发失败由投递看门狗按指数退避重发，没有放弃上限。
- **完成后保持 proactivity。** 收尾 open loop，复验早前的改动是否仍然成立，做加固，补文档。它不发明无关工作，也不把 scope 扩到 mission 以外。
- **等，而不是停。** `persistent_wait(wait_seconds, check_next)` 让宿主定时叫醒自己：status 仍是 `active`，到点自动派一条 wake 提示，全程不需要用户一句话。对应 Codex 的 “schedule the next useful check … often 1–3 minutes”。没有这个工具时，模型想“等两分钟再看”只剩休眠一个选项，这是旧版容易停摆的根因之一。
- **规则永不失效。** 完整规则集搭载在每一条插件派发的消息上。无论 compaction、context reset、fork 吞掉多早的历史，最新一条插件消息永远带全套规则。
- **checkpoint 状态机。** `persistent_checkpoint` 记录当前目标、上次已知状态、下一次检查和停止条件，与 session custom 条目（不可变快照）一起跨 `/reload`、resume、fork 恢复。
- **三个 LLM 工具，且只在自己的会话里。** `persistent_checkpoint`、`persistent_wait` 与 `persistent_dormant`，三者都必须携带提示词里给出的 `persistent_id`，任务中途替换 mission 后，旧回合滞留的工具调用会被按 id 拒收。后者带理由安静休眠，下一条真实用户消息会自动唤醒；提示词与工具描述均明确：被拦截、结果未变化、原始请求已回答一次，都**不是** dormant 的理由。
- **上下文足迹只算在模式头上。** pi 会激活扩展注册的每一个工具，而激活中的工具定义与 `promptSnippet` 会随该会话的每一次请求发送。插件因此按 mission 状态开关这三个工具的激活集：没有 mission 时，普通会话的工具列表与系统提示词跟不装插件时一致；`/persistent` 一启动就把三个工具装回去，`/sleep` 再摘掉（`v0.4.1`）。
- **STEERING 引导。** 最新用户消息是当前最高优先级，模型先执行它，再回任务。这条检查写在规则 7 和每条续派的首行里，实测模型会照做。
- **对用户零阻塞。** 通知只走 `ui.notify`（toast），从不调用 `confirm` / `select` / `input` 这类阻塞原语。循环永不等待用户。
- **生命周期自愈。** `/persistent resume` 和手动 `/compact` 成功后立即调度续派，manual compaction 结束不算用户中断。进程崩溃或重启后 restore 的 active mission 自动续跑，未到期的 `persistent_wait` 按剩余时间重新计时。会话树导航按所选分支重载状态。跨项目 fork 检测到工作区变更时强制停机，要求显式重开 mission。
- **压缩守护（v0.4.0）。** 长跑 mission 必然撞上 pi 默认压缩的上限：摘要链在 "preserve all existing information" 指令下单调增长，而摘要请求的输出预算被钉死在 `min(0.8×reserveTokens, model.maxTokens)` 这个常数上，贴死之后每次压缩都报 "hit the token cap"，上下文缩不回去，会话在阈值处死锁。默认只在**有 mission 的会话**里接管 `session_before_compact`（`mode: "persistent"`），改为有界有损交接：先把过大的旧摘要压回目标尺寸，再与增量消息合并；辅助请求从不携带思考档位；输出超限或模型路径失败时先做一次压缩重试，再兜底为本地确定性截断。压缩永远产出结果，完整历史仍留在会话文件里。
- **边界不漏跑。** settled 时如果宿主暂时忙（`isIdle()` 假 / 有排队消息）转轮询重试而不是直接 return——旧版在此静默丢掉一次派发，循环会一直接不到直到用户再发言。别的扩展插入一条无 mission 标记的消息后，settled 仍视为有效空闲边界继续续跑（旧版认不出归属就永久停下）。

## 工作区边界（常驻期间强制）

| 层 | 范围 | 机制 |
|---|---|---|
| 确定性 | `write` / `edit` | `tool_call` 拦截。目标路径从 realpath 最深存在祖先开始解析（防 `..` 穿越、symlink/junction 逃逸），win32 大小写不敏感，必须落在工作区根内，拦截理由回传模型 |
| 尽力 | `bash` / `powershell` | 机器级破坏黑名单（`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / 盘根删除等）加写形状 token（`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File` 等）、内联解释器写调用（`writeFileSync` / `open(...,'w')` 等）和可变更 git 子命令，乘以根外目标，含绝对路径、相对 `..` 穿越、`~` 与 `$env:TEMP` 类 home 和 temp 环境路径；URL 预剥离防误报，`2>&1` 类 fd 复制不算文件写入 |
| 放行 | `read` / `grep` / `find` / `ls` | 只读全域可用 |

shell 扫描是启发式的，防误不防恶。需要强隔离的 mission 请放进容器或 WSL 里跑，本插件的两层守卫是第二道网。模式内没有审批弹窗，人类引导走对话（唤醒、steer、换 mission），循环不中断。

**拦截不等于停机。** 拦截回传文本结尾固定是一句：“这仅拒绍这一个动作，mission 未结束、常驻模式未停止”，并要求它把该步副作用改到工作区内继续。旧版这里写的是“做不到就调 `persistent_dormant`”，相当於每拦一次给模型递一次下台阶，是“容易停下来”的头号原因。

**只检查真正的写目标。** 路径判定不再拿整条命令做子串匹配，而是先提取“这条命令到底往哪写”：重定向目标、`cp/mv/rm/tee/Set-Content/mkdir/...` 的位置参数、`-o/--output/-OutFile` 的值、内联脚本（`writeFileSync` / `open(...,'w')`）里的字符串字面量。git-bash 路径、`~`、`$env:TEMP` 这些展开后统一 `realpath` 比较。因此 `npm install ../local-pkg`、`echo "see ~/docs" > notes.md`、`git commit -m "handle /tmp cleanup"` 不再误拦，而 `echo x > ..\escape.txt`、`cp a.txt ../out/b.txt`、`git -C C:\Temp reset --hard` 依旧拦。

## 压缩守护配置

可选配置文件 `~/.pi/agent/pi-persistent.json`，文件不存在时使用以下默认值，未知键忽略：

```jsonc
{
  "compaction": {
    "mode": "persistent",     // persistent（默认）只守护有 mission 的会话；always 连普通会话一起接管；off 全部回到 pi 默认行为
    "targetTokens": 3000,     // 摘要正文的目标尺寸
    "maxInputChars": 24000,   // 增量消息的序列化预算
    "maxOutputTokens": 16384, // 辅助请求输出上限，按模型自身上限钳制
    "timeoutMs": 180000,
    "provider": "",           // 可选固定摘要模型，与 model 成对填写；留空复用会话当前模型
    "model": ""
  }
}
```

守护的辅助请求使用独立路由 session id、不写 prompt cache、不发送思考档位。

作用域默认收在模式内：没用过 `/persistent` 的会话不会被动插件接管压缩，pi 自己的压缩路径原样生效。pi 摘要链的上限与死锁确实跟是否使用常驻模式无关，任何长会话都可能撞，想提前给所有会话上守护就显式写 `"mode": "always"`（这是知情选择：守护产出的是有损摘要），彻底不要写 `"mode": "off"`。

## 安装

```bash
# GitHub 安装（推荐）
pi install git:github.com/DDDFXYqiming/pi-persistent

# Windows schannel / npm 拦截时改用本地路径
git clone https://github.com/DDDFXYqiming/pi-persistent.git
pi install <本机绝对路径>

# 临时试用（不安装）
pi -e <本机绝对路径>\index.ts
```

没有构建步骤。pi 用 jiti 直接跑 TypeScript 源码，`typebox` 由 pi 内置的扩展模块解析，装完即用。要求 Pi `0.80.6+`（`agent_settled` 事件）。

## 使用

安装只额外注册 `/persistent` 和 `/sleep` 两个命令。没有 mission 在跑时插件不介入任何东西：三个常驻工具不进入工具列表也不进入系统提示词，`write`/`edit`/`bash`/`powershell` 不被筛查，压缩也交回 pi，普通会话发出的请求体与不装插件时一致（`v0.4.1` 起，实测见下）。想让守护也覆盖普通会话时，按上一节显式设 `"mode": "always"`。

```
/persistent <mission>      # 启动常驻模式（mission ≤ 4000 字符，长说明写文件里引用路径）
/persistent                # 查看状态（mission / workspace / auto 计数）
/persistent resume         # 唤醒 dormant 的 mission
/persistent off            # 停机（等同 /sleep）
/sleep [reason]            # 把它睡觉
```

状态栏显示 `♾ active · auto N`（自主续跑中）、`♾ ⏳ waiting 27s · auto N`（`persistent_wait` 定时睡中，会自动醒）或 `♾ 💤 dormant · 理由`（安静待唤醒）。**事实上只有两个停径**：你执行 `/sleep`，或模型认定真正需要用户输入/越界授权的死胡同（`persistent_dormant`）。没有轮数上限，也没有“无进展”式猜测熔断；mission 完成不是停径，找不出 in-scope 后续才是。provider 瞬时错误只做指数退避（10s→5min），退避完继续跑；quota/auth 硬错先退避重试并 notify，连续 2 次才进 dormant（仍是你发一句话就唤醒）。

## 实测

以下全部在隔离工作区（`.tmp/<probe>/workspace` + 独立 `--session-dir`）跑，以 CLI 方式调起 pi（`pi --mode rpc --offline --no-extensions -e <abs>/index.ts`），模型 `minimax/MiniMax-M3`，思考等级 `high`。

- **类型与边界单测 53/53**（离线，无模型）。junction 逃逸、大小写不敏感、`..` 穿越、盘符外写入、`$env:TEMP`/`process.env.TEMP` 环境路径、内联解释器写调用（含嵌套引号）、可变更 git 子命令、`rm -rf /` 类命令、URL 假阳性与 `2>&1` fd 复制放行；新增 12 条误拦/目标判定回归（`npm install ../local-pkg`、`pip3 install -e ../pkg`、`echo "see ~/docs" > notes.md`、`git commit -m "handle /tmp …"` 必须放行，`cp a.txt ../out/b.txt`、`touch ../x`、`Set-Content "notes\..\..\escape.txt"` 必须拦）。
- **E2E RPC 18/18**（`node test/drive-rpc.mjs`，五条路径）
  - 任务全程跑通：write → read 回读 → 字节级校验 → checkpoint → dormant → 循环安静。
  - **拦截不再等于停机**。对 `C:\…\Temp\pi-persistent-escape.txt` 的越界写被 block 且理由回传，模型没绕过、没因拦截休眠，而是改在工作区内写了 `blocked-note.txt` 于扰（`p2-kept-working-after-block`），做完才 dormant；逃逸文件从未存在。
  - **`persistent_wait` 自我唤醒**：`p5-wait-tool-used` → `p5-status-stays-active-while-waiting`（status 仍 `active` 且 `wakeAt` 已写盘）→ `p5-self-wake-without-user-input`（距 wait 调用 **gap=20s**，不是 settled 边界立即续跑），全程零用户输入。
  - dormant 后被用户新指令唤醒并优先执行（STEERING），完成后再次 dormant；`/sleep` 即停，残留工具调用变 no-op。
- **永续探针 8/8**（`node test/probe-continuity.mjs`，本次新增）
  - `c1-loop-keeps-running-without-user-input`：mission 明确禁止 dormant/wait，模型每轮只回“完成了”，宿主仍连续自动续派（settled 0 → 4）且 `status=active iteration=4`——“做完”不会停下来。
  - `c2-wake-survives-foreign-run`：30s 等待窗口第 30s 插入一条**无 mission 标记的外来扩展消息**（另装一个 `noise.ts` 扩展），该 run 没弄脏 mission 归属，到点仍自我唤醒（starts 5 → 6，期间零用户 prompt）。
  - `/sleep` 后在途 run 能收尾，但不再起新 run（agent_start delta=0）。
- **流程矩阵 7/7**（`node test/probe-qwen-flows.mjs`）。真实自动续派、`/persistent resume` 即刻派发、shell 相对路径加解释器逃逸拦截、manual compaction 后继续、任务中途替换后旧工具调用按 id 拒收、零 extension_error、零投递重发。
- **崩溃恢复 PASS**（`node test/drive-qwen-restore.mjs`）。active mission 的进程在长命令中途被强杀，重启后无任何用户输入自动续跑，补完 restore-after.txt 并 dormant。
- **跨项目 fork PASS**（`node test/probe-qwen-fork.mjs`）。active 会话 fork 到另一 cwd 后 mission 强制 `off` 并提示重开。
- **压缩守护 13 离线 + E2E 7/7**（`node test/compaction-sanity.ts`、`npm run test:e2e:compact`）。离线面覆盖模式矩阵、配置钳制、transcript 去思考与尾部截断、两段式压缩（先压旧摘要再合并）、`length`/超限触发压缩重试、模型不可达时本地兜底、取消透传与文件清单截断。E2E 用独立 `PI_CODING_AGENT_DIR` 临时目录（`keepRecentTokens: 50`）加真实 `aliyun-tokenplan/qwen3.8-flash` + `--thinking high`，以 RPC `{"type":"compact"}` 触发，断言守护接管（会话条目 `details.guard="pi-persistent"`）、摘要结构化、压缩后会话继续、零 extension_error。
- **提示词足迹 A/B（v0.4.1）**。用本地 HTTP 转发代理抓取 pi 发往 `qwen-local/qwen3.8-27b` 的原始请求体（`--mode rpc` 与 `-p` 两条路径，独立 `PI_CODING_AGENT_DIR`）做对照。修复前：仅加载插件、从未执行 `/persistent` 的新会话，系统提示词多出 3 行 `Available tools`（+56 token），工具列表 4→7（+667 token，单次请求 +723 token），`/sleep` 之后与 `new_session` 之后都不回落，模型被问“你现在能调用哪些工具”时会把三个 persistent 工具报成常规能力。修复后：同一抓包与不装插件的基线逐字节一致（系统提示词同 sha、4 个工具、0 行 snippet），模型只报 `read, bash, edit, write`；kickoff 请求仍带回 7 个工具与 3 行 snippet，mission 全程可用（实测创建文件并 `persistent_dormant` 收尾），`/sleep` 与 `new_session` 后回到基线。离线侧新增 `test/tool-scope-sanity.ts` 15 项，用一个镜像 pi 激活语义的假 `ExtensionAPI` 驱动真实扩展工厂：注册即激活、`session_start` 摘除、`/persistent` 装回、`/sleep` 摘除、恢复 `active`/`dormant` mission 时装回、恢复 `off` 或跨工作区 mission 时保持摘除、切换分支时回落，且两个方向都不碰内建工具与其他扩展的工具。修复前该测试 6 项红，修复后 15/15 绿。
- **触达面 A/B（v0.4.1 续）**。同一条压缩路径两态对照（RPC {type:"compact"}，`keepRecentTokens: 50`，模型 `qwen-local/qwen3.8-27b`）：没有 mission 的会话里守护不再介入，stderr 无 `guard:` 行，会话条目的 `details` 回到 pi 自己的形状（`readFiles`/`modifiedFiles`，2150 → 估 1142 token，pi 默认模板含 split-turn 段）；mission 在跑的会话里 `[pi-persistent] guard: llm compaction of 5618 tokens -> ~732 summary tokens`、条目 `details.guard=pi-persistent path=llm`，守护自己的辅助请求不带任何工具，压缩后的自动续派请求仍带满 7 个工具、循环照旧。另核对：无 mission 的会话 jsonl 里 `persistent-state` custom 条目 0 条（插件不往不属于它的会话写东西），有 mission 的 17 条；`~/.pi/agent` 全域 9080 个文件里没有别的扩展占用 `/sleep`、`/compact`、`/persistent` 命令名。`test/tool-scope-sanity.ts` 扩到 18 项，新增「无 mission 时不应答 `session_before_compact`、越界 `write` 不筛查；有 mission 时筛查生效」。
- 测试入口。`npm test` 跑 typecheck、守卫单测、压缩守护单测和作用域单测；E2E 六个脚本：`drive-rpc.mjs`、`probe-continuity.mjs`、`probe-qwen-flows.mjs`、`drive-qwen-restore.mjs`、`probe-qwen-fork.mjs`、`manual-compact-e2e.mjs`，默认 `minimax/MiniMax-M3` + `high`，可用 `PI_E2E_MODEL` / `PI_E2E_THINKING` 替换。

## 权限

- 拦截 `write` / `edit` / `bash` / `powershell` 工具调用，block 并回传理由，只在常驻模式激活期间生效
- 追加 `persistent-state` custom session 条目持久化状态（不可变快照，含 `persistent_wait` 的到期时间），随会话文件存储，不写其他磁盘位置
- `ui.notify` 状态通知与 `ui.setStatus` 状态栏文本
- 压缩守护只在有 mission 的会话（或显式 `mode: "always"`）接管 `session_before_compact`，接管期间发起辅助模型请求（独立路由 session id，不写 prompt cache，不发送思考档位）
- 除此之外不改 pi 的默认行为：不注册快捷键和 CLI flag，不注册 `resources_discover`，不动 skill / prompt template / 主题 / 上下文文件
- 按 mission 状态增删自己三个工具的激活状态（`getActiveTools` / `setActiveTools`），不改内建工具，也不动其他扩展注册的工具
- 不读取 conversation 图片，不使用任何阻塞式 UI 原语；除辅助摘要请求外不访问网络
