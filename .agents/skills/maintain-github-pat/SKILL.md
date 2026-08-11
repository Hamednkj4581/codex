---
name: maintain-github-pat
description: 维护本仓库 GitHub PAT 的读取、校验与安全使用。在触发/查询 Actions、推送、设置 Secrets，或处理 PAT 文件时使用。
---

# 维护 GitHub PAT

## 来源与用途

- PAT 位于仓库根目录的 `PAT` 文件（整文件内容即为 token，通常一行）；该文件必须保持未跟踪。
- 仅用于触发和查询 GitHub Actions、必要时推送，以及需要仓库 API 鉴权的维护操作。
- Actions 相关操作走 `github-actions-rest`（PAT + REST）；**禁止先试 `gh`**（本环境不可用）。
- 不得输出完整 PAT、不得提交、不得写入 remote URL 持久配置、不得复制到其他文件或日志。

## 硬性禁止

- **不要主动删除用户的 PAT**，可以警告。
- 禁止清空、覆盖、改写或移除 `PAT` 文件内容，也禁止删除该文件来“清理凭据”。
- 禁止用占位符、空行或其他内容替换用户的 PAT，除非用户明确要求写入新 PAT。
- 禁止调用 GitHub API 或 `gh` 撤销/删除该 token（如 delete authorization），除非用户明确要求。

## 允许的警告

发现以下情况时只警告并停止危险操作，不自行删除或改写 PAT：

- PAT 缺失、格式异常或鉴权失败（401/403）
- PAT 权限不足，无法完成触发 Actions / 推送 / Secrets 等操作
- PAT 或含 PAT 的内容即将被提交、写入 remote、打印到日志或复制到其他文件
- `PAT` 被 git 跟踪或出现在暂存区

## 使用方式

- 需要时在进程内从 `PAT` 文件读取并临时使用，用完即丢弃，不落盘到其他路径。
- 向用户报告时只说明“PAT 有效/无效/权限不足”等结论，不回显 token 内容。
- 用户主动提供新 PAT 并要求更新时，才可改写 `PAT` 文件。

## 非交互式 git 推送

- 可用临时 URL（进程内拼 `https://x-access-token:<PAT>@github.com/<owner>/<repo>.git`）推送；**禁止**把含 PAT 的 URL 写入 `git remote` 持久配置。
- PowerShell 示例（用完丢弃变量，勿打印 token）：

```powershell
$token = (Get-Content -Raw PAT).Trim()
$env:GIT_TERMINAL_PROMPT = '0'
git push "https://x-access-token:${token}@github.com/Hamednkj4581/openclaw.git" "HEAD:main"
# 确认远端 tip
git ls-remote "https://x-access-token:${token}@github.com/Hamednkj4581/openclaw.git" refs/heads/main
# 同步跟踪分支，避免 status 假「超前」
git fetch "https://x-access-token:${token}@github.com/Hamednkj4581/openclaw.git" main:refs/remotes/github/main
git fetch "https://x-access-token:${token}@github.com/Hamednkj4581/openclaw.git" main:refs/remotes/origin/main
Remove-Variable token -ErrorAction SilentlyContinue
git status
```

- 临时 URL 推送**不会**更新 remote-tracking refs；推送后若跳过 `fetch`，`git status` 会误报 ahead。必须以 `ls-remote` + 更新后的跟踪分支为准。
- 其余提交/推送约定见 `coding-workflow`。
