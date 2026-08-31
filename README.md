简体中文 | [English](README.en.md)

# pi-persistent

> 给 **Pi Coding Agent** 装上"常驻自主模式"。`/persistent <mission>` 之后，agent 跨 settled 边界继续干活，任务完成后自己找 in-scope 的后续，直到你执行 `/sleep`。没有轮数熔断，写操作被限制在工作区内，全程不阻塞用户。

续派与会话持久化机制参考了 [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions)（MIT）的成熟实践。插件不设 `automaticTurns` / `noProgressTurns` 熔断。停止条件只有四个，mission 满足（证据级）、撞上权限边界、需要用户输入、执行 `/sleep`。

## 它在做什么

- **settled 单飞续派。** 下一条续跑提示只在 `agent_settled` 已触发、`isIdle()` 为真、无排队消息的边界派发，自动重试、compaction、排队 follow-up 都先排干，不会重复派发。派发失败由投递看门狗按指数退避重发，没有放弃上限。
- **完成后保持 proactivity。** 收尾 open loop，复验早前的改动是否仍然成立，做加固，补文档。它不发明无关工作，也不把 scope 扩到 mission 以外。
- **规则永不失效。** 完整规则集搭载在每一条插件派发的消息上。无论 compaction、context reset、fork 吞掉多早的历史，最新一条插件消息永远带全套规则。
- **checkpoint 状态机。** `persistent_checkpoint` 记录当前目标、上次已知状态、下一次检查和停止条件，与 session custom 条目（不可变快照）一起跨 `/reload`、resume、fork 恢复。
- **两个 LLM 工具。** `persistent_checkpoint` 与 `persistent_dormant`，两者都必须携带提示词里给出的 `persistent_id`，任务中途替换 mission 后，旧回合滞留的工具调用会被按 id 拒收。后者带理由安静休眠，下一条真实用户消息会自动唤醒。
- **STEERING 引导。** 最新用户消息是当前最高优先级，模型先执行它，再回任务。这条检查写在规则 7 和每条续派的首行里，实测模型会照做。
- **对用户零阻塞。** 通知只走 `ui.notify`（toast），从不调用 `confirm` / `select` / `input` 这类阻塞原语。循环永不等待用户。
- **生命周期自愈。** `/persistent resume` 和手动 `/compact` 成功后立即调度续派，manual compaction 结束不算用户中断。进程崩溃或重启后 restore 的 active mission 自动续跑。会话树导航按所选分支重载状态。跨项目 fork 检测到工作区变更时强制停机，要求显式重开 mission。

## 工作区边界（常驻期间强制）

| 层 | 范围 | 机制 |
|---|---|---|
| 确定性 | `write` / `edit` | `tool_call` 拦截。目标路径从 realpath 最深存在祖先开始解析（防 `..` 穿越、symlink/junction 逃逸），win32 大小写不敏感，必须落在工作区根内，拦截理由回传模型 |
| 尽力 | `bash` / `powershell` | 机器级破坏黑名单（`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / 盘根删除等）加写形状 token（`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File` 等）、内联解释器写调用（`writeFileSync` / `open(...,'w')` 等）和可变更 git 子命令，乘以根外目标，含绝对路径、相对 `..` 穿越、`~` 与 `$env:TEMP` 类 home 和 temp 环境路径；URL 预剥离防误报，`2>&1` 类 fd 复制不算文件写入 |
| 放行 | `read` / `grep` / `find` / `ls` | 只读全域可用 |

shell 扫描是启发式的，防误不防恶。需要强隔离的 mission 请放进容器或 WSL 里跑，本插件的两层守卫是第二道网。模式内没有审批弹窗，人类引导走对话（唤醒、steer、换 mission），循环不中断。

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

装上即生效，默认惰性，不执行 `/persistent` 就不介入。

```
/persistent <mission>      # 启动常驻模式（mission ≤ 4000 字符，长说明写文件里引用路径）
/persistent                # 查看状态（mission / workspace / auto 计数）
/persistent resume         # 唤醒 dormant 的 mission
/persistent off            # 停机（等同 /sleep）
/sleep [reason]            # 把它睡觉
```

状态栏显示 `♾ active · auto N`（自主续跑中）或 `♾ 💤 dormant · 理由`（安静待唤醒）。停止条件四个，mission 证据级满足、撞工作区边界、需要用户输入、执行 `/sleep`。没有轮数上限，也没有"无进展"式的猜测熔断。provider 瞬时错误只做指数退避（10s→5min），退避完继续跑；quota/auth 硬错误进 dormant，等你一句话唤醒。

## 实测

- **类型与边界单测 41/41**（离线，无模型），覆盖 junction 逃逸、大小写、`..` 穿越、盘符外写入、相对 `..` 重定向、`$env:TEMP` 环境路径、内联解释器写调用、可变更 git 子命令、`rm -rf /` 类命令、URL 假阳性与 `2>&1` fd 复制放行。
- **E2E RPC 13/13**（`qwen-local/qwen3.8-27b` 真实模型四条路径）
  - 任务全程跑通。write → read 回读 → 字节级校验 → checkpoint → dormant → 循环安静。
  - 越界拦截生效。对 `C:\…\Temp\escape.txt` 的写入被 block，理由回传，模型零绕过直接 dormant，逃逸文件从未存在。
  - 唤醒引导有效。dormant 状态下收到用户新指令，模型先执行（"User explicit instruction - top priority"），再回任务。
  - `/sleep` 即停。无新 run，残留工具调用变 no-op。
- **流程矩阵 7/7**（同模型）。真实自动续派、`/persistent resume` 即刻派发、shell 相对路径加解释器逃逸拦截、manual compaction 后继续、任务中途替换后旧工具调用按 id 拒收、零 extension_error、零投递重发。
- **崩溃恢复。** active mission 的进程被强杀后重启，自动续派完成剩余工作并 dormant。
- **跨项目 fork。** active 会话 fork 到另一 cwd 后 mission 被强制停机并提示重开。
- 测试入口两组。`npm test` 跑 typecheck 加守卫单测。E2E 有四个脚本，`node test/drive-rpc.mjs`、`node test/probe-qwen-flows.mjs`、`node test/drive-qwen-restore.mjs`、`node test/probe-qwen-fork.mjs`，默认模型 `qwen-local/qwen3.8-27b`，可用 `PI_E2E_MODEL` 替换。

## 权限

- 拦截 `write` / `edit` / `bash` / `powershell` 工具调用，block 并回传理由，只在常驻模式激活期间生效
- 追加 `persistent-state` custom session 条目持久化状态（不可变快照），随会话文件存储，不写其他磁盘位置
- `ui.notify` 状态通知与 `ui.setStatus` 状态栏文本
- 不读取 conversation 图片，不访问网络，不使用任何阻塞式 UI 原语
