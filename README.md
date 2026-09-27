# Discord 中文 Bot

这是一个使用 Node.js 与 `discord.js` 构建的中文 Discord 机器人。

## 指令

- `/ping` — 检查机器人延迟
- `/help` — 查看帮助
- `/about` — 查看机器人信息
- `/welcome` — 打开私密的欢迎/离开设置面板

## 欢迎 / 离开系统

在服务器任意频道执行 `/welcome`，机器人会发送只有你看得到的设置面板。面板全部使用按钮操作，可以设置：

- 欢迎频道
- 离开频道
- 欢迎内容
- 离开内容
- 欢迎图片 URL
- 离开图片 URL
- 是否私讯新成员
- 私讯欢迎内容

支持的内容变量：`{user}`、`{username}`、`{server}`、`{count}`。

图片使用公开图片 URL（例如 Discord CDN、Imgur 或你的图床）。清空图片 URL 即可移除图片。

## 权限限制

在托管平台的环境变量中设置：

```env
OWNER_ID=你的Discord用户ID
ALLOWED_GUILD_IDS=允许使用的服务器ID,另一个服务器ID
```

- 设置 `OWNER_ID` 后，只有你能打开和操作设置面板。
- 设置 `ALLOWED_GUILD_IDS` 后，机器人只会在列出的服务器运行；进入其他服务器会自动离开。
- `ALLOWED_GUILD_IDS` 留空代表不限制服务器，但仍建议设置 `OWNER_ID`。

## Discord Developer Portal 设置

为了接收成员加入/离开事件：

1. 打开 Discord Developer Portal → 你的应用 → **Bot**。
2. 在 **Privileged Gateway Intents** 开启 **Server Members Intent**。
3. Bot 邀请权限至少需要：查看频道、发送消息、嵌入链接。
4. 如果要让 Bot 自动加入服务器，需要使用 `bot` 与 `applications.commands` scopes。

## 邀请与限制方法

### 只有你能添加

Discord 的 OAuth2 邀请链接本身不能按用户永久锁死，所以使用代码权限控制：设置 `OWNER_ID` 为你的 Discord 用户 ID，并将 `ALLOWED_GUILD_IDS` 设置为允许的服务器。其他人即使邀请成功，也无法操作面板；不在允许列表的服务器会被 Bot 自动离开。

### 只有指定服务器能添加

把目标服务器 ID 写入 `ALLOWED_GUILD_IDS`，例如：

```env
ALLOWED_GUILD_IDS=123456789012345678
```

注意：Bot 必须先短暂加入才能读取服务器 ID 并自动离开；这属于 Discord 邀请流程的限制。

### 生成只允许指定服务器的邀请链接

在 Developer Portal → **OAuth2 → URL Generator**：

- Scopes：勾选 `bot`、`applications.commands`
- Bot Permissions：勾选 View Channels、Send Messages、Embed Links
- 如果只给一个服务器使用，可在邀请 URL 加入 `guild_id=你的服务器ID&disable_guild_select=true`

这会把邀请页面预选到指定服务器，但最终安装仍受 Discord 用户权限控制，所以仍要保留 `ALLOWED_GUILD_IDS` 与 `OWNER_ID`。

## 启动

```bash
npm install
npm start
```

不要把 `.env` 或 Discord Token 提交到 GitHub。若 Token 泄露，请立刻在 Developer Portal 重新生成。
