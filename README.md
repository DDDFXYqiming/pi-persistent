简体中文 | [English](README.en.md)

# pi-persistent

> 给 **Pi Coding Agent** 装上"常驻自主模式"：`/persistent <mission>` 之后 agent 跨 settled 边界无限续跑，任务做完自己找 in-scope 后续，直到你 `/sleep`。**无轮数熔断、工作区写边界、对用户零阻塞**。

续派与会话持久化机制参考 [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions)（MIT）的成熟实践。**不设 `automaticTurns` / `noProgressTurns` 熔断**——停止条件只有四个：mission 满足（证据级）、撞权限边界、需要用户输入、`/sleep`。

## 它在做什么

- **settled 单飞续派**：只在 `agent_settled` + `isIdle()` + 无排队消息的边界派发下一条续跑提示，自动重试 / compaction / 排队 follow-up 先排干，不重复派发
- **完成后 proactivity**：收尾 open loop、复验早前改动仍然成立、加固、补文档；不发明无关工作、不扩 mission 以外的 scope
- **规则永不丢失**：完整规则集搭载在每一条插件派发的消息上——compaction、context reset、fork 无论吞掉多早的历史，最新一条插件消息永远带全套规则
- **checkpoint 状态机**：`persistent_checkpoint` 记录当前目标 / 上次已知状态 / 下一次检查 / 停止条件，与 session custom 条目一起跨 `/reload`、resume、fork 恢复
- **两个 LLM 工具**：`persistent_checkpoint` 与 `persistent_dormant`（带理由安静休眠；下一条真实用户消息自动唤醒）
- **STEERING 引导**：最新用户消息是当前最高优先级——先执行、再回任务（规则 7 + 每条续派首行检查，实测模型会照做）
- **对用户零阻塞**：通知只走 `ui.notify`（toast），从不调用 `confirm` / `select` / `input` 阻塞原语；循环永不等待用户

## 工作区边界（常驻期间强制）

| 层 | 范围 | 机制 |
|---|---|---|
| 确定性 | `write` / `edit` | `tool_call` 拦截：目标路径 realpath 最深存在祖先解析（防 `..` 穿越、symlink/junction 逃逸），win32 大小写不敏感，必须落在工作区根内；拦截理由回传模型 |
| 尽力 | `bash` / `powershell` | 机器级破坏黑名单（`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / 盘根删除…）+ 写形状 token（`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File`…）× 根外绝对路径；URL 预剥离防误报 |
| 放行 | `read` / `grep` / `find` / `ls` | 只读全域可用 |

shell 扫描是启发式的，防误不防恶；需要强隔离的 mission 放容器 / WSL 里跑，本插件的两层守卫是第二道网。模式内**没有审批弹窗**——人类引导走对话（唤醒 / steer / 换 mission），不中断循环。

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

无构建步骤——pi 用 jiti 直接跑 TypeScript 源码；`typebox` 由 pi 内置的扩展模块解析，装完即用。要求 Pi `0.80.6+`（`agent_settled` 事件）。

## 使用

装上即生效（默认惰性，不 `/persistent` 不介入）：

```
/persistent <mission>      # 启动常驻模式（mission ≤ 4000 字符，长说明写文件里引用路径）
/persistent                # 查看状态（mission / workspace / auto 计数）
/persistent resume         # 唤醒 dormant 的 mission
/persistent off            # 停机（等同 /sleep）
/sleep [reason]            # 把它睡觉
```

状态栏：`♾ active · auto N`（自主续跑中）/ `♾ 💤 dormant · 理由`（安静待唤醒）。停止条件四个：mission 证据级满足、撞工作区边界、需要用户输入、`/sleep`——**没有轮数上限、没有"无进展"猜测式熔断**；provider 瞬时错误只做指数退避（10s→5min）后继续，quota/auth 硬错误进 dormant 等你一句话唤醒。

## 实测

- **边界单测 29/29**（离线，无模型）：junction 逃逸、大小写、`..` 穿越、盘符外写入、`rm -rf /` 类命令、URL 假阳性（`curl https://… -o 相对路径` 必须放行）
- **E2E RPC 13/13**（`minimax-m3/MiniMax-M3` 真实模型四链路）：
  - 任务闭环：write → read 回读 → 字节级校验 → checkpoint → dormant → 循环安静
  - 越界拦截：`C:\…\Temp\escape.txt` 写入被 block，理由回传，模型零绕过直接 dormant，逃逸文件从未存在
  - 唤醒引导：dormant → 用户新指令 → 模型"User explicit instruction - top priority"先执行 → 回任务
  - `/sleep`：即停、无新 run、残留工具调用变 no-op
- 测试脚本：`node test/guard-sanity.ts`（离线）、`node test/drive-rpc.mjs`（E2E）、`node test/install-probe.mjs`（安装探针，零模型调用）

## 权限

- 拦截 `write` / `edit` / `bash` / `powershell` 工具调用（block 并回传理由），只在常驻模式激活期间生效
- 追加 `persistent-state` custom session 条目持久化状态（随会话文件存储，不写其他磁盘位置）
- `ui.notify` 状态通知 + `ui.setStatus` 状态栏文本
- 不读取 conversation 图片、不访问网络、不使用任何阻塞式 UI 原语
