# 更新代码与迁移到 Fork

新部署统一使用[连接 GitHub、选择仓库部署](deployment-manual.md)。已有部署继续使用原 Worker 和原数据库，更新前先核对下面这一项。

## 先确认数据库名称

在现有 Worker 的 **Bindings → DB** 查看实际数据库。新版默认按名称查找 `telegramdoor`：

- **实际数据库就叫 `telegramdoor`：** 可直接按下面步骤同步。
- **实际数据库是其他名称：** 在自己的 Fork 的 `wrangler.jsonc` 中，将 `DB` 条目的 `database_name` 设为实际名称，再同步上游；遇到合并冲突时保留自己的名称。不要直接使用上游的默认名称，以免连接到另一数据库。
- **配置中已有有效 `database_id`：** 保留即可，它会优先于名称；不要删除有效 ID 或换成全零占位值。

如果旧版配置只有 `binding: "DB"`，没有名称和 ID，而控制台绑定的是其他名称的数据库，也要先在自己的 Fork 补上实际名称再同步。数据库不需要更名、重建或清空。

新部署时，如果 `telegramdoor` 已被账户内另一应用使用，请为新机器人创建一个独立 D1，并将自己 Fork 的 `database_name` 改成新名称，然后继续同一套 GitHub 部署流程。不要共用其他机器人的数据库。

## 已经是 Fork：同步更新

1. 完成上面的数据库核对，查看版本说明。未来新版本如要求迁移，按说明处理；当前运行时只自动初始化首版表结构。
2. 打开自己的 Fork，切换到生产分支 `main`，点击 **Sync fork → Update branch**。
3. 到 Worker 的 **Settings → Builds** 查看最新提交的构建，确认发布成功。
4. 检查 `/health`、后台历史数据和机器人收发；确认 `DB` 仍指向原数据库。

构建设置统一为：根目录 `/`，构建命令 `npm run build`，部署命令 `npx wrangler deploy`。Worker 使用自定义名称时，部署命令用 `npx wrangler deploy --name 实际Worker名称`。三个运行时密钥继续保留在 Worker 设置中。

访客验证状态也保存在 D1，默认有效期 30 天。继续使用原数据库时，更新部署不会清空验证状态，不需要访客每次重新答题。若更新后所有人都变成未验证，先检查 `DB` 是否误绑定到了另一数据库。

修改过代码或配置、出现合并冲突时，保留有用改动并解决冲突，不要直接丢弃个人提交。**Sync fork 不会持续自动同步上游**；每次手动同步产生的新提交，才会触发 Cloudflare 自动部署。

官方说明：[GitHub 同步 Fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)、[Cloudflare Git 构建](https://developers.cloudflare.com/workers/ci-cd/builds/)。

## 已用旧按钮部署：如何迁到 Fork

旧模板的独立副本没有原项目的 Fork 关系。在旧副本上点击 Fork，不会把它变成 TelegramDoor 的 Fork。

这部分仅用于切换已有部署的代码来源：

1. 从[源项目](https://github.com/maodeyu180/TelegramDoor/fork)创建真正的 Fork，名称占用时取新名，保留旧仓库。
2. 按[数据库核对](#先确认数据库名称)将新 Fork 配置为使用原数据库；必要的自定义代码也先迁入。
3. 在原 Worker 的 **Settings → Builds** 断开旧 Git 连接（Disconnect），再 Connect 选择新 Fork。这里不删除 Worker，也不创建新数据库。
4. 设置生产分支 `main`、根目录 `/`、构建命令 `npm run build`、部署命令 `npx wrangler deploy`；自定义 Worker 名称时附加 `--name 实际Worker名称`。
5. 构建最新提交，确认三个运行时密钥仍在。发布后检查 `/health`、历史记录、封禁和 Telegram 收发。

域名与 Bot Token 相同时，在后台「检查连接」确认原 Webhook 可用。更换域名或 Token 时，按[机器人迁移说明](migration.md)重新连接；更换 Token 还需重新保存已配置的 Turnstile Secret。

官方说明：[切换 Worker 关联仓库](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds)。

## 同步了，但页面还是旧版

- **代码**：Fork 是否有上游新提交，Worker 是否关联这个 Fork 的 `main`。
- **构建**：最新记录是否对应新提交，有没有名称、绑定、权限或构建错误。
- **发布**：确认构建命令为 `npm run build`、部署命令为 `npx wrangler deploy`，成功版本已经成为当前生产版本。

具体报错见[排错文档](deployment.md)。只更新上游不会让所有部署自动升级。

## 已配置后还要重新连接吗？

不需要。后台登录状态和 Telegram 接收配置是两回事；退出后台、重新登录或更新部署不会自动断开 Telegram。

旧版页面即使显示「已配置」，也会保留「重新连接 Telegram」按钮，它只是维护入口，不代表掉线。新版已将该入口收进「连接维护」，日常只需在收发异常时点击「检查连接」。更换域名、Bot Token 或需要修复配置时，再展开维护入口重新配置。
