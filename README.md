# Discord 中文 Bot

这是一个使用 Node.js 与 `discord.js` 构建的中文 Discord 机器人。

## 指令

- `/ping` — 检查机器人延迟
- `/help` — 查看帮助
- `/about` — 查看机器人信息
- `/welcome` — 打开私密的欢迎/离开设置面板
- `/roles` — 打开私密的身份组面板设置
- `/moderation` — 设置惩罚日志频道
- `/mute` — 暂时禁言成员
- `/unmute` — 解除成员禁言
- `/kick` — 踢出成员
- `/ban` — 封禁成员
- `/unban` — 解除用户封禁
- `/giveaway` — 打开私密抽奖管理面板

## 抽奖系统（第一阶段）

管理员执行 `/giveaway` 后只会收到一个**私密管理面板**。点击“创建抽奖”，填写奖品、持续时间、获奖人数和说明，然后在私密面板点击 `true` 或 `false` 按钮选择服务器 Tag 条件，Bot 才会把公开参加面板发送到执行指令的频道。成员通过公开面板按钮参加或退出，管理员可以从私密面板刷新、提前结束或重抽。

抽奖功能包括：

- 自定义奖品、说明和持续时间
- 1 至 100 名获奖者
- 成员按钮参加/退出
- 防止重复参加
- `true/false` 服务器 Tag 要求
- 自动结束并随机抽取获奖者
- 手动结束抽奖
- 已结束抽奖重新抽取获奖者
- Bot 重启后恢复未结束抽奖计时
- 抽奖数据持久化

创建抽奖时，服务器 Tag 条件会在私密面板中用两个按钮选择：

```text
true   要求成员装备当前服务器的 Server Tag
false  不要求 Server Tag
```

Bot 会检查成员 Discord 用户资料中的 Primary Guild。选择 `true` 时，只有成员当前装备的 Primary Guild 是这个服务器，才能参加；选择 `false` 时不检查 Server Tag。Discord 用户如果没有装备当前服务器的 Tag，Bot 会拒绝参加。

抽奖持续时间格式支持 `30s`、`10m`、`2h`、`7d`，最长 28 天。抽奖管理面板本身是私密的，公开抽奖消息才会显示给其他成员。

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

## 身份组面板

执行 `/roles` 后会收到只有自己看得到的配置面板，可以用按钮设置面板标题、面板文字、添加身份组和发布。发布后，成员可以在公开面板下方点击按钮领取或取消对应身份组。每个身份组都可以自定义按钮文字。

Bot 的身份组必须排在可领取身份组的上方，并且 Bot 必须拥有 **Manage Roles / 管理身份组** 权限；托管身份组（例如机器人身份组或整合身份组）不能被领取。

## 管理员惩罚系统

管理员可以使用以下指令：

```text
/mute member duration reason
/unmute member reason
/kick member reason
/ban member reason
/unban user_id reason
```

其中 `reason` 可以留空。`/mute` 的 `duration` 支持 `30s`、`10m`、`2h`、`7d` 等格式，最长 28 天。

执行 `/moderation` 会收到一个只有执行者看得到的设置面板，可以选择惩罚日志频道。日志频道**不一定要是私密频道**，可以选择普通公开文字频道，让其他成员查看处罚记录；当然也可以选择仅管理员可见的频道。每次操作会记录：

- 实行：`mute`、`unmute`、`kick`、`ban`、`unban`
- 实行对象：成员名称、提及和 ID
- 禁言时长：只有 `mute` 显示时长
- 实行原因
- 实行人员
- 实行时间

填写的原因会同时传给 Discord 的审核日志（Audit Log），可在服务器设置 → 审核日志中查看。Discord 审核日志原因限制为 512 个字符，超过部分会自动截断；Bot 自己的日志频道仍会保留同一原因。

惩罚日志 Embed 现在会显示被处罚成员头像、实行人员头像、实行频道和实行时间；只有 `mute` 会显示“禁言时长”，`unmute`、`kick`、`ban`、`unban` 不会显示该字段。执行处罚后，Bot 也会私讯被处罚者一张相同排版的处罚通知卡片；如果对方关闭了陌生人私讯，日志仍会正常记录。

Bot 需要 `Moderate Members`、`Kick Members`、`Ban Members`、`View Channels`、`Send Messages` 和 `Embed Links` 权限。Bot 的身份组必须高于要被管理的成员。

惩罚指令会先回应 Discord，执行成功后立即公开显示结果；惩罚日志和私讯通知会在后台完成，因此不会因为日志频道或私讯处理延迟而显示“机器人未响应”。`/mute`、`/unmute`、`/kick`、`/ban`、`/unban` 的成功和错误反馈都会公开显示在执行指令的频道；`/moderation` 设置面板仍然是私密的。

## 权限限制

在托管平台的环境变量中设置：

```env
OWNER_ID=你的Discord用户ID
ALLOWED_GUILD_IDS=允许使用的服务器ID,另一个服务器ID
```

- 现在 `/welcome`、`/roles` 等管理面板要求使用者拥有 **管理服务器 / Manage Server** 权限。
- 如果填写了 `OWNER_ID` 且服务器不在允许列表，服务器必须有你的账号，管理员才可以使用机器人。
- 如果服务器 ID 写入 `ALLOWED_GUILD_IDS`，该服务器的管理员可以使用机器人，即使你不在该服务器。
- 设置 `ALLOWED_GUILD_IDS` 后，列出的服务器可以使用；未列出的服务器只有在服务器中有你的账号时才可以使用，否则机器人会自动离开。
- `ALLOWED_GUILD_IDS` 留空时，填写 `OWNER_ID` 会限制为“服务器有你”；不填写 `OWNER_ID` 则所有服务器管理员都可使用，不建议这样部署。

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

设置 `GUILD_ID` 或 `ALLOWED_GUILD_IDS` 后，Bot 会把斜杠指令注册到指定服务器，通常会立即显示。两个变量中的服务器 ID 会合并注册；两个变量都为空时会注册为全局指令，Discord 可能需要最多约一小时才显示。

如果 Bot 在两个服务器使用，建议这样填写：

```env
GUILD_ID=
ALLOWED_GUILD_IDS=第一个服务器ID,第二个服务器ID
```

`ALLOWED_GUILD_IDS` 不要只填写其中一个服务器，否则另一个服务器会被视为未允许服务器，Bot 可能自动离开或不处理指令。

邀请 Bot 时必须同时勾选 `bot` 与 `applications.commands` 两个 Scopes；只勾选 `bot` 不会显示斜杠指令。

不要把 `.env` 或 Discord Token 提交到 GitHub。若 Token 泄露，请立刻在 Developer Portal 重新生成。
