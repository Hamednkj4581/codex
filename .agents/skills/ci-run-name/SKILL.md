---
name: ci-run-name
description: 提交推送后发现仅支持手动触发的 GitHub Actions CI；只有一个时自动触发，多个时仅触发用户主动指定的目标，并用提交主题命名和验证运行。触发与轮询一律用 github-actions-rest，禁止先试 gh。
---

# 选择、触发并命名手动 CI

## 调用方式

- 触发、轮询、校验运行一律遵守 `github-actions-rest`：PAT + REST API。
- **禁止先试 `gh`**（本环境不可用）；不要用 `gh workflow run` / `gh run list` 做探测或回退。

## 发现与选择

- 每次推送后重新读取 `.github/workflows`，只把唯一触发方式为 `workflow_dispatch` 的工作流计入手动 CI；不约定文件名，也不沿用之前检查到的数量。
- 只有一个手动 CI 时自动选择并触发。存在多个手动 CI 时，只有用户已在当前任务中主动提及明确的工作流名称或文件时才触发该目标；用户未提及时不触发任何一个，不猜测、不默认选择，也不为触发 CI 追问用户。
- 没有手动 CI 时不触发。包含 `push`、`pull_request`、`schedule` 等其他触发方式的工作流不属于本 skill 的自动触发范围。

## 运行名称

- 被选工作流必须声明字符串输入 `commit_message`，并在顶层设置 `run-name: ${{ inputs.commit_message }}`；缺少时先修正工作流，不能用文件名或其他固定文本代替提交主题。
- 不使用 `github.event.head_commit.message`：`workflow_dispatch` 的事件载荷不提供该字段。
- 运行名称只能使用提交主题，不得拼入 `accounts`、token、邮箱、密码或其他敏感输入。

## 提交后的强制闭环

1. 每次新提交成功推送后执行上述发现与选择；选中一个手动 CI 时必须显式 dispatch，未选中时记录“未触发”并正常结束 CI 环节。
2. 记录当前分支、推送后的 SHA 和 UTC 触发时间，并确认远端分支已指向该 SHA。
3. 使用 GitHub Commit API `GET /repos/{owner}/{repo}/commits/{sha}` 读取 `commit.message` 第一行作为提交主题；主题为空时停止并报告，不得用敏感输入或无意义文本代替。禁止在 Windows PowerShell 中直接捕获 `git log -1 --format=%s` 作为中文运行名，因为 Git 子进程输出可能按错误的控制台代码页解码，即使随后按 UTF-8 发送也只会得到另一串乱码。
4. 读取被选工作流声明的必填 inputs，按该工作流已有约定取得值，并同时传入 `commit_message`；不得假设所有手动 CI 都使用 `accounts`，不得编造缺失输入。PAT 与 inputs 的处理分别遵守 `maintain-github-pat` 和 `github-actions-rest` skill，不得回显或落盘。含中文的 dispatch JSON 必须编码为 UTF-8 字节并声明 `application/json; charset=utf-8`，不得将 JSON 字符串直接传给 Windows PowerShell 的 `Invoke-WebRequest -Body`。
5. 调用 workflow dispatch 后按触发时间、分支和目标 SHA 轮询。收到 `204` 只表示请求成功，不表示闭环完成；必须找到本次新建的唯一 run ID。
6. 等待运行完成并逐个检查 jobs。只有目标运行已完成，或凭据、权限、服务状态等外部条件明确阻塞时才能结束任务；阻塞时必须报告尚未触发或尚未完成，不能声称交付完成。

## 验证

- 校验工作流 YAML，并确认 `run-name` 只引用非敏感的 `commit_message`。
- 触发后确认运行的 `event == workflow_dispatch`、`head_sha` 是目标提交，且 `display_title` 等于 GitHub Commit API 返回的提交主题。终端可能无法正确渲染中文，比较前分别以 UTF-8 编码后转 Base64；两个 Base64 值必须相等，不能只检查标题是否由 `?` 组成。
- 最终报告 run ID、网页 URL、运行状态和目标 jobs 结论；没有匹配运行时任务未完成。
- 多个手动 CI 且用户未主动指定时，最终明确报告未触发；此时没有 run ID 是预期结果，不属于失败。
- 重跑已有 workflow run 会沿用原运行名称；新提交必须以该提交自身的主题触发新运行。
