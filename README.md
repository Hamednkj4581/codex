# Outlook 邮箱注册

通过 GitHub Actions 批量注册 `@outlook.com` 账号，完成 OAuth2 授权后以 IMAP 可收信为成功标准。

## 工作流

- 工作流：`Outlook register`（`.github/workflows/ci.yml`）
- 输入：`count`（要注册的账号数量，默认 `5`，范围 1–20）
- Secret：`CAPSOLVER_API_KEY`
- 固定 Client ID：`9e5f94bc-e8a4-4e73-b8be-63364c29d753`（Thunderbird 公共应用）

## 成功产物

每个成功账号写入 step summary / artifact，格式：

```text
邮箱----密码----client_id----refresh_token
```

仅当 OAuth2/IMAP 预检通过才算成功。出现手机号验证时按约定停止，记为外部阻塞。

## 本地运行

```bash
npm install
export CAPSOLVER_API_KEY=...
npm run build
node dist/app.js
```
