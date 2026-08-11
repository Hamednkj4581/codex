---
name: github-actions-rest
description: 用 GitHub REST API（PAT）触发、查询、下载本仓库 Actions 运行/日志/产物；本环境禁用 gh。在查 CI 基线、dispatch、轮询 run、拉 job 日志或 artifacts 时使用。
---

# GitHub Actions 只用 REST API

## 硬性约定

- **禁止先试 `gh`**：本环境 `gh` 不可用。不要运行 `gh run`、`gh api`、`gh workflow` 等做探测或回退；直接走 REST。
- 鉴权只用仓库根目录 `PAT`（规则见 `maintain-github-pat`）；进程内读取，用完丢弃，不回显、不落盘。
- `owner/repo` 从 `git remote get-url github`（没有则 `origin`）解析；不要调用 `gh repo view`。

## 请求头

```
Authorization: Bearer <PAT>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: gpt-free-register
```

## 常用端点

| 用途 | 方法与路径 |
|------|------------|
| 某工作流最近运行 | `GET /repos/{owner}/{repo}/actions/workflows/{workflow_file}/runs?per_page=N` |
| 分支最近运行 | `GET /repos/{owner}/{repo}/actions/runs?branch={branch}&per_page=N` |
| 单次运行 | `GET /repos/{owner}/{repo}/actions/runs/{run_id}` |
| 运行 jobs | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` |
| job 日志 | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`（跟随重定向，保存到仓库外临时目录） |
| 运行产物 | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts`，下载 `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` |
| 手动触发 | `POST /repos/{owner}/{repo}/actions/workflows/{workflow_file}/dispatches`（`204` 仅表示受理） |
| 提交主题 | `GET /repos/{owner}/{repo}/commits/{sha}`，取 `message` 第一行 |

注册基线优先查 `ci.yml`；登录相关查 `login.yml`。

## PowerShell / 编码

- 含中文的 dispatch JSON：编码为 UTF-8 字节，并声明 `Content-Type: application/json; charset=utf-8`；不要把 JSON 字符串直接传给 `Invoke-WebRequest -Body`。
- 比较中文 `display_title` 与提交主题时，两边分别 UTF-8 后再转 Base64 比较；勿依赖终端是否能正确显示中文。
- 优先用 Python `urllib` 做 API 与日志下载，避免控制台代码页把响应标题打成乱码后误判。

## 闭环（与 `ci-run-name` 配合）

1. dispatch 后按触发时间、分支、`head_sha` 轮询，直到找到本次唯一 `run_id`。
2. 等 `status == completed`，再逐个核对目标 jobs。
3. 向用户报告 `run_id`、`html_url`、结论；产物与日志只放在 `%TEMP%` 等仓库外路径。
