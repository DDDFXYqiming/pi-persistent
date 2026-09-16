简体中文 | [English](README.en.md)

# pi-persistent

`pi-persistent` 为 Pi Coding Agent 增加可选的常驻任务模式。执行 `/persistent <mission>` 后，Pi 可以跨越 settled 边界继续工作，记录检查点并安排下一次检查。执行 `/sleep`，或任务需要模型无法取得的用户输入与授权时，模式才会结束。

续派和持久化参考了 [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions)（MIT）的实现方式，行为也按 OpenAI Codex 公开描述的 persistent mode 组织。插件要求 Pi `0.80.6+`，因为该版本提供 `agent_settled` 事件。

## 它做什么

- **单飞续派。** 只有在 `agent_settled` 已触发、宿主空闲且消息队列为空时才发送下一条提示。provider 重试、压缩和排队消息会先处理完，派发失败由看门狗按指数退避重试。
- **任务后续检查。** 用户要求的工作完成后，模型可以复验早前的改动、处理任务范围内的遗留事项并补充文档。
- **定时等待。** `persistent_wait(wait_seconds, check_next)` 让任务保持 active，并安排唤醒提示。状态栏会显示等待状态和剩余时间。
- **规则与检查点持久化。** 插件自己的每条提示都会带上当前规则。`persistent_checkpoint` 把目标、已知状态、下一次检查和停止条件写入不可变的 session custom 条目，reload、resume 和 fork 后可以恢复。
- **任务内工具。** `persistent_checkpoint`、`persistent_wait` 和 `persistent_dormant` 只在任务激活时出现。调用必须携带当前 `persistent_id`，任务替换后旧调用会被拒绝。
- **用户引导优先。** 最新用户消息会先处理，再恢复任务。状态通知使用 `ui.notify`，循环不调用会阻塞用户的 `confirm`、`select` 或 `input`。
- **生命周期恢复。** 手动压缩、`/persistent resume`、进程重启和会话树导航都会恢复或重新安排 active 任务。跨到其他工作区的 fork 会停用任务，直到显式启动新任务。
- **压缩守护。** `persistent` 模式下，长任务的 `session_before_compact` 使用有界交接。守护会压缩过大的摘要、合并新消息，遇到超限时重试，模型路径失败时使用确定性本地截断。完整历史仍保存在 session 文件中。

工作区边界拒绝某次工具调用时，只拒绝这一次调用。任务仍保持 active，返回理由会要求模型把操作移到工作区内。provider 出错会先退避重试，任务进入 dormant 后仍可由下一条用户消息唤醒。

## 工作区边界

边界只在常驻任务激活期间生效。

| 层 | 范围 | 机制 |
|---|---|---|
| 确定性 | `write` / `edit` | 从最深的已存在祖先开始解析真实路径，拒绝 `..` 穿越和 symlink、junction 逃逸，并要求目标位于工作区根内。Windows 比较不区分大小写。 |
| 尽力 | `bash` / `powershell` | 扫描破坏性命令、写入形状、内联解释器写操作、可变更 git 命令和工作区外目标。提取目标前会去掉 URL，普通链接文本不会触发拦截。 |
| 放行 | `read` / `grep` / `find` / `ls` | 只读访问保持可用。 |

shell 扫描是安全网，不是沙箱。需要硬隔离的任务应放在容器或 WSL 中运行。

## 压缩守护配置

可选文件 `~/.pi/agent/pi-persistent.json` 在不存在时使用以下默认值，未知键会忽略。

```jsonc
{
  "compaction": {
    "mode": "persistent",     // persistent、always 或 off
    "targetTokens": 3000,
    "maxInputChars": 24000,
    "maxOutputTokens": 16384,
    "timeoutMs": 180000,
    "provider": "",
    "model": ""
  }
}
```

`persistent` 只守护有常驻任务的会话，`always` 也覆盖普通会话，`off` 则恢复 Pi 的默认压缩。守护请求使用新的路由 session id，不写 prompt cache，也不发送思考档位。

## 安装

```bash
# 从 GitHub 安装
pi install git:github.com/DDDFXYqiming/pi-persistent

# 本地路径备用安装
git clone https://github.com/DDDFXYqiming/pi-persistent.git
pi install <本机绝对路径>

# 不安装直接试用
pi -e <本机绝对路径>\index.ts
```

插件没有构建步骤。Pi 通过 jiti 直接运行 TypeScript 源码，`typebox` 由 Pi 内置的扩展模块解析。

## 使用

```text
/persistent <mission>      # 启动任务，最多 4000 个字符
/persistent                # 查看任务、工作区和自动计数
/persistent resume         # 唤醒 dormant 任务
/persistent off            # 停止任务
/sleep [reason]            # 停止任务，可附带理由
```

没有常驻任务时，插件不改变普通会话的工具列表、提示词、边界检查和压缩流程。`/persistent` 会激活三个任务工具，`/sleep` 会再次移除它们。

## 验证

`npm test` 会运行类型检查，以及工作区边界、压缩守护和工具作用域的离线测试。`test/` 下的脚本覆盖 RPC 续派、定时唤醒、崩溃恢复、跨项目 fork 和手动压缩。运行端到端脚本时可用 `PI_E2E_MODEL` 与 `PI_E2E_THINKING` 选择模型和思考等级。

## 权限

- 只在常驻任务激活时拦截 `write`、`edit`、`bash` 和 `powershell` 调用。
- 将不可变的 `persistent-state` 快照保存在 Pi session 文件中。
- 使用 `ui.notify` 和 `ui.setStatus` 更新状态。
- 只有压缩守护会发送辅助模型请求，请求使用新的路由 session id，不写 prompt cache，也不携带 reasoning 选项。
- 只增删自己的三个工具，不修改内建工具、skills、prompt 模板、主题、上下文文件、快捷键或 CLI flag。
- 不读取会话图片。除压缩守护外不访问网络。
