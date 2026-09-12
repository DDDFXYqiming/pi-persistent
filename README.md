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

## 验证

`npm test` 执行类型检查，以及边界守卫、压缩守护和工具作用域的离线测试。

端到端脚本保存在 `test/`，覆盖 RPC 续派、等待唤醒、崩溃恢复、跨项目 fork 和手动压缩。运行时使用隔离的会话目录，并通过 `PI_E2E_MODEL` 与 `PI_E2E_THINKING` 选择可用模型和思考等级。

边界测试应确认越界写入被拒绝，后续操作仍受同一约束。作用域测试比较有无 mission 的两种状态，确保未激活时不增加工具或改写默认压缩流程，停止后恢复原有状态。

## 权限

- 拦截 `write` / `edit` / `bash` / `powershell` 工具调用，block 并回传理由，只在常驻模式激活期间生效
- 追加 `persistent-state` custom session 条目持久化状态（不可变快照，含 `persistent_wait` 的到期时间），随会话文件存储，不写其他磁盘位置
- `ui.notify` 状态通知与 `ui.setStatus` 状态栏文本
- 压缩守护只在有 mission 的会话（或显式 `mode: "always"`）接管 `session_before_compact`，接管期间发起辅助模型请求（独立路由 session id，不写 prompt cache，不发送思考档位）
- 除此之外不改 pi 的默认行为：不注册快捷键和 CLI flag，不注册 `resources_discover`，不动 skill / prompt template / 主题 / 上下文文件
- 按 mission 状态增删自己三个工具的激活状态（`getActiveTools` / `setActiveTools`），不改内建工具，也不动其他扩展注册的工具
- 不读取 conversation 图片，不使用任何阻塞式 UI 原语；除辅助摘要请求外不访问网络
