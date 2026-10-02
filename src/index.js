require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const commandGuildId = process.env.GUILD_ID;
const ownerId = process.env.OWNER_ID;
const allowedGuildIds = new Set(
  (process.env.ALLOWED_GUILD_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variable.');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
const settingsPath = path.join(dataDir, 'welcome-settings.json');
fs.mkdirSync(dataDir, { recursive: true });

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

let settings = loadSettings();
if (!settings.giveaways) settings.giveaways = {};
if (!settings.giveawayMessages) settings.giveawayMessages = {};
if (!settings.messageStats) settings.messageStats = {};
if (!settings.giveawayTemplates) settings.giveawayTemplates = {};
if (!settings.stickies) settings.stickies = {};

function saveSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getStickySettings(guildId) {
  if (!settings.stickies[guildId]) settings.stickies[guildId] = { global: '', globalMessages: {}, channels: {}, refreshSeconds: 5 };
  settings.stickies[guildId].globalMessages ||= {};
  settings.stickies[guildId].channels ||= {};
  if (!Number.isInteger(settings.stickies[guildId].refreshSeconds)) settings.stickies[guildId].refreshSeconds = 5;
  return settings.stickies[guildId];
}

const stickyLocks = new Set();
const stickyRefreshTimers = new Map();

async function deleteStickyMessage(channel, messageId) {
  if (!messageId || !channel?.messages) return;
  const oldMessage = await channel.messages.fetch(messageId).catch(() => null);
  if (oldMessage) await oldMessage.delete().catch(() => {});
}

async function publishStickyToChannel(guild, channel, content) {
  if (!channel?.isTextBased?.() || !content) return null;
  const config = getStickySettings(guild.id);
  const channelConfig = config.channels[channel.id] || {};
  const oldMessageId = config.global ? config.globalMessages[channel.id] : channelConfig.messageId;
  await deleteStickyMessage(channel, oldMessageId);
  const sent = await channel.send({
    content: `这是一条stick内容\n${content}`,
    allowedMentions: { parse: ['users', 'roles', 'everyone'] },
  }).catch((error) => { console.error('Could not send sticky message:', error); return null; });
  if (!sent) return null;
  if (config.global) config.globalMessages[channel.id] = sent.id;
  else config.channels[channel.id] = { content, messageId: sent.id };
  saveSettings();
  return sent;
}

async function refreshStickyForMessage(message) {
  if (!message.guild || message.author.bot || !message.channel?.isTextBased?.()) return;
  const config = getStickySettings(message.guild.id);
  const channelConfig = config.channels[message.channel.id];
  const content = config.global || channelConfig?.content;
  if (!content) return;
  if (stickyRefreshTimers.has(message.channel.id)) clearTimeout(stickyRefreshTimers.get(message.channel.id));
  const delay = Math.max(0, Number(config.refreshSeconds || 0)) * 1000;
  stickyRefreshTimers.set(message.channel.id, setTimeout(async () => {
    stickyRefreshTimers.delete(message.channel.id);
    if (stickyLocks.has(message.channel.id)) return;
    stickyLocks.add(message.channel.id);
    try { await publishStickyToChannel(message.guild, message.channel, content); }
    finally { stickyLocks.delete(message.channel.id); }
  }, delay));
}

async function setSticky(guild, channel, content, scope = 'current', refreshSeconds = 5) {
  const config = getStickySettings(guild.id);
  config.refreshSeconds = Math.max(0, Math.min(300, Number(refreshSeconds) || 0));
  if (scope === 'all') {
    config.global = content;
    config.globalMessages = {};
    const channels = guild.channels.cache.filter((item) => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(item.type));
    for (const target of channels.values()) await publishStickyToChannel(guild, target, content);
  } else {
    for (const [channelId, messageId] of Object.entries(config.globalMessages)) {
      const target = await guild.channels.fetch(channelId).catch(() => null);
      await deleteStickyMessage(target, messageId);
    }
    config.global = '';
    config.globalMessages = {};
    config.channels[channel.id] = { content, messageId: '' };
    await publishStickyToChannel(guild, channel, content);
  }
  saveSettings();
}

async function cancelSticky(guild, channel, scope = 'current') {
  const config = getStickySettings(guild.id);
  if (scope === 'all') {
    for (const timer of stickyRefreshTimers.values()) clearTimeout(timer);
    stickyRefreshTimers.clear();
    for (const [channelId, messageId] of Object.entries(config.globalMessages)) {
      const target = await guild.channels.fetch(channelId).catch(() => null);
      await deleteStickyMessage(target, messageId);
    }
    config.global = '';
    config.globalMessages = {};
  } else {
    if (stickyRefreshTimers.has(channel.id)) clearTimeout(stickyRefreshTimers.get(channel.id));
    stickyRefreshTimers.delete(channel.id);
    const channelConfig = config.channels[channel.id];
    await deleteStickyMessage(channel, channelConfig?.messageId);
    delete config.channels[channel.id];
  }
  saveSettings();
}

async function performPrefixSticky(message, args) {
  if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply('只有拥有“管理服务器”权限的管理员可以使用置底指令。');
    return;
  }
  const action = (args.shift() || '').toLowerCase();
  const requestedScope = (args[0] || '').toLowerCase();
  const scope = ['all', '全部', '所有频道'].includes(requestedScope) ? 'all' : 'current';
  if (action === 'set' || action === '设置') {
    if (scope === 'all') args.shift();
    const refreshSeconds = /^\d+$/.test(args[0] || '') ? Number(args.shift()) : 5;
    const content = args.join(' ').trim();
    if (!content) { await message.reply('用法：置底 set [all] [刷新秒数] 置底内容'); return; }
    await setSticky(message.guild, message.channel, content, scope, refreshSeconds);
    await message.reply(`已设置${scope === 'all' ? '所有频道' : '当前频道'}的置底消息，刷新时间：${refreshSeconds} 秒。`);
  } else if (action === 'cancel' || action === 'remove' || action === '取消') {
    await cancelSticky(message.guild, message.channel, scope);
    await message.reply(`已取消${scope === 'all' ? '所有频道' : '当前频道'}的置底消息。`);
  } else {
    await message.reply('用法：置底 set [all] [刷新秒数] 内容，或置底 cancel [all]。');
  }
}

function shanghaiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function messageStatsFor(guildId, userId) {
  return settings.messageStats?.[guildId]?.[userId] || {};
}

function getMessageSummary(guildId, userId) {
  const daily = messageStatsFor(guildId, userId);
  const today = shanghaiDateKey();
  const now = new Date(`${today}T12:00:00+08:00`);
  const day = now.getUTCDay() || 7;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - day + 1);
  const monthPrefix = `${today.slice(0, 7)}-`;
  const weekKeys = new Set();
  for (let index = 0; index < 7; index += 1) {
    const current = new Date(weekStart);
    current.setUTCDate(weekStart.getUTCDate() + index);
    weekKeys.add(current.toISOString().slice(0, 10));
  }
  const entries = Object.entries(daily);
  return {
    today: Number(daily[today] || 0),
    week: entries.filter(([key]) => weekKeys.has(key)).reduce((sum, [, value]) => sum + Number(value || 0), 0),
    month: entries.filter(([key]) => key.startsWith(monthPrefix)).reduce((sum, [, value]) => sum + Number(value || 0), 0),
    total: Number(settings.giveawayMessages?.[guildId]?.[userId] || entries.reduce((sum, [, value]) => sum + Number(value || 0), 0)),
  };
}

const giveawayTimers = new Map();
const pendingGiveawayDrafts = new Map();
const REROLL_WINDOW_MS = 7 * 86_400_000;
let giveawayMessageSaveCounter = 0;

function getGuildSettings(guildId) {
  if (!settings[guildId]) {
    settings[guildId] = {
      welcomeChannelId: '',
      leaveChannelId: '',
      welcomeMessage: '欢迎 {user} 加入 **{server}**！',
      leaveMessage: '{user} 已离开 **{server}**。',
      welcomeImage: '',
      leaveImage: '',
      dmWelcome: false,
      dmWelcomeMessage: '欢迎你加入 **{server}**！',
      rolePanel: {
        title: '身份组领取面板',
        description: '点击下方按钮领取或取消对应身份组。',
        roles: [],
        mode: 'buttons',
      },
      moderationLogChannelId: '',
      moderationPrefix: '!',
      serverStats: {
        enabled: false,
        totalChannelId: '',
        onlineChannelId: '',
        botChannelId: '',
        totalName: '👥 成员：{count}',
        onlineName: '🟢 在线：{count}',
        botName: '🤖 机器人：{count}',
      },
    };
  }
  if (!settings[guildId].rolePanel) {
    settings[guildId].rolePanel = {
      title: '身份组领取面板',
      description: '点击下方按钮领取或取消对应身份组。',
      roles: [],
      mode: 'buttons',
    };
  }
  if (!['buttons', 'select'].includes(settings[guildId].rolePanel.mode)) settings[guildId].rolePanel.mode = 'buttons';
  if (!Object.prototype.hasOwnProperty.call(settings[guildId], 'moderationLogChannelId')) {
    settings[guildId].moderationLogChannelId = '';
  }
  if (!Object.prototype.hasOwnProperty.call(settings[guildId], 'moderationPrefix')) {
    settings[guildId].moderationPrefix = '!';
  }
  if (!settings[guildId].serverStats) settings[guildId].serverStats = {};
  settings[guildId].serverStats = {
    enabled: false,
    categoryId: '',
    showTotal: true,
    showHumans: true,
    showOnline: true,
    showBots: true,
    totalChannelId: '',
    humanChannelId: '',
    onlineChannelId: '',
    botChannelId: '',
    totalName: '👥 总人数：{count}',
    humanName: '👤 真人：{count}',
    onlineName: '🟢 在线：{count}',
    botName: '🤖 机器人：{count}',
    ...settings[guildId].serverStats,
  };
  if (settings[guildId].serverStats.totalName === '👥 成员：{count}') settings[guildId].serverStats.totalName = '👥 总人数：{count}';
  return settings[guildId];
}

function isGuildAllowed(guildId) {
  return allowedGuildIds.size === 0 || allowedGuildIds.has(guildId);
}

async function isGuildUsable(guild) {
  if (isGuildAllowed(guild.id)) return true;
  if (!ownerId) return false;
  return Boolean(await guild.members.fetch(ownerId).catch(() => null));
}

async function canManage(interaction) {
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return false;
  if (allowedGuildIds.has(interaction.guild.id)) return true;
  if (!ownerId) return allowedGuildIds.size === 0;
  return Boolean(await interaction.guild.members.fetch(ownerId).catch(() => null));
}

function replacePlaceholders(text, member) {
  return text
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{count}', String(member.guild.memberCount));
}

function panelEmbed(guild, config) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('欢迎 / 离开系统设置')
    .setDescription(
      `欢迎频道：${config.welcomeChannelId ? `<#${config.welcomeChannelId}>` : '未设置'}\n` +
      `离开频道：${config.leaveChannelId ? `<#${config.leaveChannelId}>` : '未设置'}\n` +
      `欢迎图片：${config.welcomeImage ? '已设置' : '未设置'}\n` +
      `离开图片：${config.leaveImage ? '已设置' : '未设置'}\n` +
      `私讯欢迎：${config.dmWelcome ? '开启' : '关闭'}`,
    )
    .setFooter({ text: `${guild.name} · 只有授权用户可以操作` });
}

function panelComponents(config) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('welcome_channel').setLabel('设置欢迎频道').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('leave_channel').setLabel('设置离开频道').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('welcome_message').setLabel('设置欢迎内容').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('leave_message').setLabel('设置离开内容').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('welcome_image').setLabel('设置欢迎图片').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('leave_image').setLabel('设置离开图片').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dm_welcome').setLabel(config.dmWelcome ? '关闭私讯欢迎' : '开启私讯欢迎').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dm_message').setLabel('设置私讯内容').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('welcome_refresh').setLabel('刷新面板').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function rolePanelEmbed(guild, roleConfig) {
  const roleLines = roleConfig.roles.length
    ? roleConfig.roles.map((item) => `• <@&${item.roleId}> — ${item.label}`).join('\n')
    : '目前还没有设置身份组。';
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(roleConfig.title)
    .setDescription(`${roleConfig.description}\n\n${roleLines}`)
    .setFooter({ text: `${guild.name} · ${roleConfig.mode === 'select' ? '使用下拉选单领取或取消身份组' : '点击按钮领取或取消身份组'}` });
}

function rolePanelButtons(roleConfig) {
  const buttons = roleConfig.roles.slice(0, 25).map((item) =>
    new ButtonBuilder()
      .setCustomId(`role_toggle:${item.roleId}`)
      .setLabel(item.label.slice(0, 80))
      .setStyle(ButtonStyle.Primary),
  );
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)));
  }
  return rows;
}

function rolePanelSelect(roleConfig) {
  if (!roleConfig.roles.length) return [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId('role_select')
    .setPlaceholder('选择身份组以领取或取消')
    .setMinValues(1)
    .setMaxValues(Math.min(roleConfig.roles.length, 25))
    .addOptions(roleConfig.roles.slice(0, 25).map((item) => new StringSelectMenuOptionBuilder()
      .setLabel(item.label.slice(0, 100))
      .setValue(item.roleId)
      .setDescription('点击领取或取消这个身份组')));
  return [new ActionRowBuilder().addComponents(menu)];
}

function rolePanelPublicComponents(roleConfig) {
  return roleConfig.mode === 'select' ? rolePanelSelect(roleConfig) : rolePanelButtons(roleConfig);
}

function roleConfigComponents(roleConfig) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('role_title').setLabel('设置面板标题').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('role_description').setLabel('设置面板文字').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('role_add').setLabel('添加身份组').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('role_remove').setLabel('移除身份组').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('role_mode').setLabel(roleConfig.mode === 'select' ? '切换为按钮模式' : '切换为下拉选单').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('role_refresh').setLabel('刷新').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('role_publish').setLabel('发布到当前频道').setStyle(ButtonStyle.Success),
    ),
  ];
}

function moderationPanelEmbed(guild, config) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('管理员惩罚系统设置')
    .setDescription(`惩罚日志频道：${config.moderationLogChannelId ? `<#${config.moderationLogChannelId}>` : '未设置'}\nPrefix 指令符号：\`${config.moderationPrefix}\`\n\n每次 mute、unmute、kick、ban、unban 操作都会记录到这个频道。`)
    .setFooter({ text: `${guild.name} · 只有拥有管理服务器权限者可以操作` });
}

function moderationPanelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('moderation_log_channel').setLabel('设置惩罚日志频道').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('moderation_prefix').setLabel('设置 Prefix 符号').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('moderation_refresh').setLabel('刷新').setStyle(ButtonStyle.Secondary),
  )];
}

function serverStatsEmbed(guild, config) {
  const stats = config.serverStats;
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('服务器统计设置')
    .setDescription(`状态：${stats.enabled ? '开启' : '关闭'}\n统计类别：${stats.categoryId ? `<#${stats.categoryId}>` : '尚未创建'}\n\n` +
      `总人数：${stats.showTotal ? (stats.totalChannelId ? `<#${stats.totalChannelId}>` : '待创建') : '已关闭'}\n` +
      `真人成员：${stats.showHumans ? (stats.humanChannelId ? `<#${stats.humanChannelId}>` : '待创建') : '已关闭'}\n` +
      `在线人数：${stats.showOnline ? (stats.onlineChannelId ? `<#${stats.onlineChannelId}>` : '待创建') : '已关闭'}\n` +
      `机器人数量：${stats.showBots ? (stats.botChannelId ? `<#${stats.botChannelId}>` : '待创建') : '已关闭'}\n\n` +
      '支持变量：`{count}`。频道名称可以自由加入表情符号；统计语音频道禁止成员加入连接。')
    .setFooter({ text: `${guild.name} · 统计频道会自动更新` });
}

function serverStatsComponents(stats) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('serverstats_setup').setLabel('设置频道名称').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('serverstats_update').setLabel('立即更新').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('serverstats_toggle').setLabel(stats.enabled ? '关闭统计' : '开启统计').setStyle(stats.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('serverstats_total').setLabel(stats.showTotal ? '关闭总人数' : '开启总人数').setStyle(stats.showTotal ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('serverstats_humans').setLabel(stats.showHumans ? '关闭真人数' : '开启真人数').setStyle(stats.showHumans ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('serverstats_online').setLabel(stats.showOnline ? '关闭在线人数' : '开启在线人数').setStyle(stats.showOnline ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('serverstats_bots').setLabel(stats.showBots ? '关闭机器人数' : '开启机器人数').setStyle(stats.showBots ? ButtonStyle.Danger : ButtonStyle.Success),
    ),
  ];
}

function serverStatsModal(stats) {
  const fields = [
    ['total_name', '总人数频道名称', stats.totalName, '例如：👥 总人数：{count}'],
    ['human_name', '真人成员频道名称', stats.humanName, '例如：👤 真人：{count}'],
    ['online_name', '在线统计频道名称', stats.onlineName, '例如：🟢 在线：{count}'],
    ['bot_name', '机器人统计频道名称', stats.botName, '例如：🤖 机器人：{count}'],
  ];
  return new ModalBuilder().setCustomId('serverstats_modal').setTitle('设置服务器统计频道').addComponents(
    ...fields.map(([id, label, value, placeholder]) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setValue(value).setPlaceholder(placeholder).setMaxLength(100))),
  );
}

async function updateServerStats(guild) {
  const config = getGuildSettings(guild.id);
  const stats = config.serverStats;
  if (!stats.enabled) return;
  await guild.members.fetch().catch(() => null);
  const members = guild.members.cache;
  let category = stats.categoryId ? await guild.channels.fetch(stats.categoryId).catch(() => null) : null;
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = await guild.channels.create({
      name: '服务器统计',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.Connect] }],
      reason: '创建服务器统计类别',
    }).catch((error) => { console.error('Could not create stats category:', error); return null; });
    if (!category) return;
    stats.categoryId = category.id;
  }
  await category.permissionOverwrites.edit(guild.id, { Connect: false }).catch(() => {});
  const values = {
    total: members.size || guild.memberCount,
    humans: members.filter((member) => !member.user.bot).size,
    online: members.filter((member) => member.presence && member.presence.status !== 'offline').size,
    bots: members.filter((member) => member.user.bot).size,
  };
  const definitions = [
    ['totalChannelId', 'totalName', 'showTotal', values.total],
    ['humanChannelId', 'humanName', 'showHumans', values.humans],
    ['onlineChannelId', 'onlineName', 'showOnline', values.online],
    ['botChannelId', 'botName', 'showBots', values.bots],
  ];
  for (const [channelKey, nameKey, showKey, count] of definitions) {
    let channel = stats[channelKey] ? await guild.channels.fetch(stats[channelKey]).catch(() => null) : null;
    if (!stats[showKey]) {
      if (channel) await channel.delete('关闭服务器统计项目').catch(() => {});
      stats[channelKey] = '';
      continue;
    }
    if (!channel) {
      channel = await guild.channels.create({
        name: stats[nameKey].replaceAll('{count}', String(count)).slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.Connect] }],
        reason: '创建服务器统计频道',
      }).catch((error) => { console.error('Could not create stats channel:', error); return null; });
      if (!channel) continue;
      stats[channelKey] = channel.id;
    }
    if (channel.parentId !== category.id) await channel.setParent(category.id).catch(() => {});
    await channel.permissionOverwrites.edit(guild.id, { Connect: false }).catch(() => {});
    await channel.setName(stats[nameKey].replaceAll('{count}', String(count)).slice(0, 100)).catch(console.error);
  }
  saveSettings();
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const milliseconds = amount * units[match[2].toLowerCase()];
  return milliseconds > 0 && milliseconds <= 28 * 86_400_000 ? milliseconds : null;
}

function formatDuration(milliseconds) {
  const units = [[86_400_000, '天'], [3_600_000, '小时'], [60_000, '分钟'], [1000, '秒']];
  for (const [unit, label] of units) {
    if (milliseconds >= unit && milliseconds % unit === 0) return `${milliseconds / unit}${label}`;
  }
  return `${Math.ceil(milliseconds / 1000)}秒`;
}

function giveawayEmbed(giveaway, ended = false) {
  const requirements = [];
  if (giveaway.requiredRoleIds?.length) requirements.push(`需要身份组：${giveaway.requiredRoleIds.map((id) => `<@&${id}>`).join('、')}`);
  if (giveaway.blacklistedRoleIds?.length) requirements.push(`禁止身份组：${giveaway.blacklistedRoleIds.map((id) => `<@&${id}>`).join('、')}`);
  if (giveaway.accountAgeDays) requirements.push(`账号至少注册 **${giveaway.accountAgeDays} 天**`);
  if (giveaway.serverAgeDays) requirements.push(`加入服务器至少 **${giveaway.serverAgeDays} 天**`);
  if (giveaway.messageRequirement) requirements.push(`本服务器至少发送 **${giveaway.messageRequirement} 条消息**`);
  if (giveaway.levelRequirement) requirements.push(`等级至少 **${giveaway.levelRequirement}**`);
  if (giveaway.bypassRoleIds?.length) requirements.push(`绕过条件身份组：${giveaway.bypassRoleIds.map((id) => `<@&${id}>`).join('、')}`);
  if (giveaway.extraEntries?.length) requirements.push(`额外入场：${giveaway.extraEntries.map((item) => `<@&${item.roleId}> +${item.entries} 次`).join('、')}`);
  if (giveaway.firstEntries) requirements.push(`前 **${giveaway.firstEntries}** 位参加者直接获奖`);
  const winnerText = giveaway.winnerIds?.length ? `\n\n获奖者：${giveaway.winnerIds.map((id) => `<@${id}>`).join('、')}` : '';
  return new EmbedBuilder()
    .setColor(ended ? 0x747f8d : 0x5865f2)
    .setTitle(ended ? `🎉 抽奖结束：${giveaway.prize}` : `🎉 ${giveaway.prize}`)
    .setDescription(`${giveaway.description || '点击下方按钮参加抽奖！'}${requirements.length ? `\n\n**参加条件**\n${requirements.join('\n')}` : ''}${winnerText}`)
    .addFields(
      { name: '获奖人数', value: String(giveaway.winnerCount), inline: true },
      { name: '参与人数', value: String(giveaway.entries.length), inline: true },
      { name: '总入场次数', value: String(giveaway.entryWeights || giveaway.entries.length), inline: true },
      { name: ended ? '结束时间' : '结束倒计时', value: ended ? `<t:${Math.floor(giveaway.endsAt / 1000)}:F>` : `<t:${Math.floor(giveaway.endsAt / 1000)}:R>`, inline: true },
    )
    .setFooter({ text: `主办人：${giveaway.hostName} · 抽奖 ID：${giveaway.id}` })
    .setTimestamp(new Date(giveaway.createdAt));
}

function giveawayButtons(giveaway, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`giveaway_join:${giveaway.id}`).setLabel('参加抽奖').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`giveaway_leave:${giveaway.id}`).setLabel('退出抽奖').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}

function giveawayPanelEmbed(guild, giveaways) {
  const active = giveaways.filter((item) => item.guildId === guild.id && item.status === 'active');
  const ended = giveaways.filter((item) => item.guildId === guild.id && item.status === 'ended').slice(-5);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('抽奖管理面板')
    .setDescription(active.length || ended.length ? [...active, ...ended].map((item) => `**${item.prize}** · ID：\`${item.id}\` · ${item.entries.length} 人参加 · ${item.status === 'active' ? '进行中' : '已结束'}`).join('\n') : '目前没有进行中的抽奖。')
    .setFooter({ text: `${guild.name} · 创建抽奖后会发布到当前频道` });
}

function giveawayPanelButtons(giveaways, guildId) {
  const selected = giveaways.filter((item) => item.guildId === guildId && (item.status === 'active' || item.status === 'ended')).slice(-10);
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('giveaway_create').setLabel('创建抽奖').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('giveaway_refresh').setLabel('刷新面板').setStyle(ButtonStyle.Secondary),
  )];
  for (const item of selected) {
    if (item.status === 'active') {
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway_end:${item.id}`).setLabel(`结束：${item.prize}`.slice(0, 80)).setStyle(ButtonStyle.Danger)));
    } else {
      const buttons = [];
      if (Date.now() - (item.endedAt || item.endsAt) <= REROLL_WINDOW_MS) buttons.push(new ButtonBuilder().setCustomId(`giveaway_reroll:${item.id}`).setLabel(`重抽：${item.prize}`.slice(0, 70)).setStyle(ButtonStyle.Secondary));
      buttons.push(new ButtonBuilder().setCustomId(`giveaway_clear:${item.id}`).setLabel(`清除：${item.prize}`.slice(0, 70)).setStyle(ButtonStyle.Danger));
      rows.push(new ActionRowBuilder().addComponents(buttons));
    }
  }
  return rows.slice(0, 5);
}

function giveawayModal() {
  const fields = [
    ['prize', '奖品', TextInputStyle.Short, true, '例如：Discord Nitro'],
    ['duration', '持续时间', TextInputStyle.Short, true, '例如：1h、30m、2d'],
    ['winner_count', '获奖人数', TextInputStyle.Short, true, '例如：1'],
    ['description', '抽奖说明', TextInputStyle.Paragraph, false, '可不填'],
  ];
  return new ModalBuilder().setCustomId('giveaway_create_modal').setTitle('创建抽奖').addComponents(
    ...fields.map(([id, label, style, required, placeholder]) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setPlaceholder(placeholder).setMaxLength(id === 'description' ? 1000 : 100),
    )),
  );
}

function giveawayAdvancedEmbed(draft) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('抽奖进阶条件设置')
    .setDescription([
      `必需身份组：${draft.requiredRoleIds?.length ? draft.requiredRoleIds.map((id) => `<@&${id}>`).join('、') : '未设置'}`,
      `绕过身份组：${draft.bypassRoleIds?.length ? draft.bypassRoleIds.map((id) => `<@&${id}>`).join('、') : '未设置'}`,
      `黑名单身份组：${draft.blacklistedRoleIds?.length ? draft.blacklistedRoleIds.map((id) => `<@&${id}>`).join('、') : '未设置'}`,
      `需要装备当前服务器 Server Tag：${draft.requireServerTag ? 'true' : 'false'}`,
      `账号年龄：${draft.accountAgeDays || 0} 天 · 入服时间：${draft.serverAgeDays || 0} 天`,
      `消息要求：${draft.messageRequirement || 0} 条 · 等级要求：${draft.levelRequirement || 0}`,
      `额外入场身份组：${draft.extraEntries?.length ? '已设置' : '未设置'} · 前 N 位：${draft.firstEntries || 0}`,
      `重复抽奖：${draft.repeatCount ? `剩余 ${draft.repeatCount} 次，每 ${formatDuration(draft.repeatEvery || draft.duration)} 自动重开` : '关闭'}`,
      `获奖身份组：${draft.winnerRoleId ? `<@&${draft.winnerRoleId}>` : '未设置'} · 获奖讨论串：${draft.winnerThread ? '开启' : '关闭'}`,
    ].join('\n'));
}

function giveawayAdvancedButtons(draftOrId) {
  const draftId = typeof draftOrId === 'string' ? draftOrId : draftOrId.id;
  const requireServerTag = typeof draftOrId === 'string' ? false : Boolean(draftOrId.requireServerTag);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giveaway_required_roles:${draftId}`).setLabel('必需身份组').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`giveaway_bypass_roles:${draftId}`).setLabel('绕过身份组').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_blacklist_roles:${draftId}`).setLabel('黑名单身份组').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giveaway_extra_entries:${draftId}`).setLabel('额外入场次数').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_numeric:${draftId}`).setLabel('年龄/消息/等级').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_first_entries:${draftId}`).setLabel('前 N 位获奖').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giveaway_tag_toggle:${draftId}`).setLabel(`Server Tag：${requireServerTag ? 'true（需要）' : 'false（不需要）'}`).setStyle(requireServerTag ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_advanced_refresh:${draftId}`).setLabel('刷新条件').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_publish:${draftId}`).setLabel('发布抽奖').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giveaway_repeat:${draftId}`).setLabel('设置重复抽奖').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_winner_role:${draftId}`).setLabel('获奖身份组').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`giveaway_winner_thread:${draftId}`).setLabel(`获奖讨论串：${draftOrId.winnerThread ? '开' : '关'}`).setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giveaway_template_save:${draftId}`).setLabel('保存为模板').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`giveaway_template_load:${draftId}`).setLabel('载入模板').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`giveaway_stats:${draftId}`).setLabel('查看统计').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function giveawayRepeatModal(draft) {
  return new ModalBuilder().setCustomId(`giveaway_repeat_modal:${draft.id}`).setTitle('设置重复抽奖').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('count').setLabel('重复次数（0 关闭）').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(draft.repeatCount || 0))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('interval').setLabel('每次间隔').setStyle(TextInputStyle.Short).setRequired(false).setValue(draft.repeatEvery ? formatDuration(draft.repeatEvery) : '').setPlaceholder('例如：1d；留空使用抽奖持续时间')),
  );
}

function giveawayTemplateModal(draft) {
  return new ModalBuilder().setCustomId(`giveaway_template_modal:${draft.id}`).setTitle('保存抽奖模板').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('模板名称').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
  );
}

function giveawayNumericModal(draft) {
  const fields = [
    ['account_age_days', '账号至少注册天数', String(draft.accountAgeDays || 0), '例如：30；0 表示不限'],
    ['server_age_days', '加入服务器至少天数', String(draft.serverAgeDays || 0), '例如：7；0 表示不限'],
    ['message_requirement', '至少发送消息数量', String(draft.messageRequirement || 0), '需要消息统计；0 表示不限'],
    ['level_requirement', '最低等级', String(draft.levelRequirement || 0), '本 Bot 等级系统预留；0 表示不限'],
  ];
  return new ModalBuilder().setCustomId(`giveaway_numeric_modal:${draft.id}`).setTitle('设置抽奖数值条件').addComponents(
    ...fields.map(([id, label, value, placeholder]) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setValue(value).setPlaceholder(placeholder).setMaxLength(8),
    )),
  );
}

function giveawayExtraEntriesModal(draft) {
  return new ModalBuilder().setCustomId(`giveaway_extra_entries_modal:${draft.id}`).setTitle('设置额外入场次数').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('entries').setLabel('身份组与额外次数').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((draft.extraEntries || []).map((item) => `${item.roleId}=${item.entries}`).join('\n')).setPlaceholder('每行一个：身份组ID=额外次数，例如 123456789=2').setMaxLength(1000)),
  );
}

function giveawayStatsEmbed(guild, giveaways) {
  const list = giveaways.filter((item) => item.guildId === guild.id);
  const ended = list.filter((item) => item.status === 'ended');
  const entries = list.reduce((sum, item) => sum + (item.entries?.length || 0), 0);
  const winners = ended.reduce((sum, item) => sum + (item.winnerIds?.length || 0), 0);
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('抽奖统计')
    .addFields(
      { name: '抽奖总数', value: String(list.length), inline: true },
      { name: '进行中', value: String(list.filter((item) => item.status === 'active').length), inline: true },
      { name: '已结束', value: String(ended.length), inline: true },
      { name: '累计参与人次', value: String(entries), inline: true },
      { name: '累计获奖人数', value: String(winners), inline: true },
      { name: '模板数量', value: String(Object.values(settings.giveawayTemplates).filter((item) => item.guildId === guild.id).length), inline: true },
    )
    .setFooter({ text: `${guild.name} · 统计仅管理员可见` });
}

function templateSelect(guildId, draftId) {
  const templates = Object.values(settings.giveawayTemplates).filter((item) => item.guildId === guildId).slice(0, 25);
  if (!templates.length) return null;
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`giveaway_template_select:${draftId}`)
    .setPlaceholder('选择要载入的模板')
    .addOptions(templates.map((item) => new StringSelectMenuOptionBuilder().setLabel(item.name.slice(0, 100)).setValue(item.id).setDescription(`${item.prize}`.slice(0, 100)))));
}

function userHasRequiredTag(user, guildId, requireServerTag) {
  if (!requireServerTag) return true;
  const primary = user.primaryGuild;
  return Boolean(primary?.identityGuildId === guildId);
}

function memberMessageCount(guildId, userId) {
  return Number(settings.giveawayMessages?.[guildId]?.[userId] || 0);
}

function entryWeight(giveaway, member) {
  return 1 + (giveaway.extraEntries || [])
    .filter((item) => member.roles.cache.has(item.roleId))
    .reduce((sum, item) => sum + item.entries, 0);
}

async function checkGiveawayEligibility(giveaway, interaction, member, user) {
  const roleIds = new Set(member.roles.cache.keys());
  const bypass = (giveaway.bypassRoleIds || []).some((id) => roleIds.has(id));
  if (bypass) return { ok: true, weight: entryWeight(giveaway, member) };
  if (giveaway.requireServerTag && !userHasRequiredTag(user, interaction.guild.id, true)) return { ok: false, reason: '你必须装备当前服务器的 Server Tag。' };
  if ((giveaway.blacklistedRoleIds || []).some((id) => roleIds.has(id))) return { ok: false, reason: '你拥有本抽奖禁止参加的身份组。' };
  if ((giveaway.requiredRoleIds || []).some((id) => !roleIds.has(id))) return { ok: false, reason: '你没有满足抽奖要求的身份组。' };
  if (giveaway.accountAgeDays && Date.now() - user.createdTimestamp < giveaway.accountAgeDays * 86_400_000) return { ok: false, reason: `你的 Discord 账号必须至少注册 ${giveaway.accountAgeDays} 天。` };
  if (giveaway.serverAgeDays && (!member.joinedTimestamp || Date.now() - member.joinedTimestamp < giveaway.serverAgeDays * 86_400_000)) return { ok: false, reason: `你加入本服务器必须至少 ${giveaway.serverAgeDays} 天。` };
  const messages = memberMessageCount(giveaway.guildId, user.id);
  if (giveaway.messageRequirement && messages < giveaway.messageRequirement) return { ok: false, reason: `你需要在本服务器发送至少 ${giveaway.messageRequirement} 条消息，目前为 ${messages} 条。` };
  const level = Math.floor(messages / 100);
  if (giveaway.levelRequirement && level < giveaway.levelRequirement) return { ok: false, reason: `你的等级必须达到 ${giveaway.levelRequirement}，当前等级为 ${level}。` };
  return { ok: true, weight: entryWeight(giveaway, member) };
}

async function finishGiveaway(giveawayId, reroll = false, firstCome = false) {
  const giveaway = settings.giveaways[giveawayId];
  if (!giveaway) return null;
  const guild = await client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!guild) return null;
  const channel = await guild.channels.fetch(giveaway.channelId).catch(() => null);
  const message = channel?.isTextBased() ? await channel.messages.fetch(giveaway.messageId).catch(() => null) : null;
  const basePool = reroll ? giveaway.entries.filter((id) => !giveaway.winnerIds?.includes(id)) : giveaway.entries;
  const pool = firstCome ? basePool : basePool.flatMap((id) => Array(giveaway.entryWeightByUser?.[id] || 1).fill(id));
  if (!pool.length) return null;
  const shuffled = firstCome ? pool : [...pool].sort(() => Math.random() - 0.5);
  const winnerLimit = firstCome && giveaway.firstEntries ? giveaway.firstEntries : giveaway.winnerCount;
  giveaway.winnerIds = [...new Set(shuffled)].slice(0, winnerLimit);
  giveaway.status = 'ended';
  giveaway.endedAt = Date.now();
  saveSettings();
  if (giveawayTimers.has(giveawayId)) clearTimeout(giveawayTimers.get(giveawayId));
  if (message) await message.edit({ embeds: [giveawayEmbed(giveaway, true)], components: giveawayButtons(giveaway, true) }).catch(console.error);
  if (channel?.isTextBased()) {
    const winnerMessage = await channel.send(`🎉 恭喜 ${giveaway.winnerIds.map((id) => `<@${id}>`).join('、')} 获得 **${giveaway.prize}**！`).catch(() => null);
    if (giveaway.winnerRoleId) {
      const role = await guild.roles.fetch(giveaway.winnerRoleId).catch(() => null);
      if (role && !role.managed && role.position < guild.members.me.roles.highest.position) {
        await Promise.all(giveaway.winnerIds.map(async (userId) => {
          const winner = await guild.members.fetch(userId).catch(() => null);
          return winner?.roles.add(role).catch(console.error);
        }));
      }
    }
    if (giveaway.winnerThread && winnerMessage?.startThread) {
      await winnerMessage.startThread({ name: `🎉 ${giveaway.prize} 获奖者讨论`, autoArchiveDuration: 1440, reason: '抽奖获奖者讨论串' }).catch(console.error);
    }
  }
  if (giveaway.repeatCount > 0) {
    giveaway.repeatCount -= 1;
    const next = { ...giveaway, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, messageId: '', entries: [], entryWeights: 0, entryWeightByUser: {}, winnerIds: [], createdAt: Date.now(), endsAt: Date.now() + (giveaway.repeatEvery || giveaway.duration), status: 'active' };
    delete next.lastWinnerId;
    const nextMessage = channel?.isTextBased() ? await channel.send({ embeds: [giveawayEmbed(next)], components: giveawayButtons(next) }).catch(() => null) : null;
    if (nextMessage) next.messageId = nextMessage.id;
    if (nextMessage) {
      settings.giveaways[next.id] = next;
      saveSettings();
      scheduleGiveaway(next);
    }
  }
  return giveaway;
}

function scheduleGiveaway(giveaway) {
  const delay = Math.max(1000, giveaway.endsAt - Date.now());
  giveawayTimers.set(giveaway.id, setTimeout(() => finishGiveaway(giveaway.id), Math.min(delay, 2_147_000_000)));
}

function textModal(customId, title, label, value, paragraph = false) {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(label)
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(paragraph ? 1000 : 500)
    .setValue(value || '');
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function announceComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('announce_text').setLabel('普通文字').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('announce_embed').setLabel('Embed 面板').setStyle(ButtonStyle.Secondary),
  )];
}

function announceModal(type) {
  const fields = type === 'embed'
    ? [
        ['title', 'Embed 标题', TextInputStyle.Short, true, '公告标题'],
        ['description', 'Embed 内容', TextInputStyle.Paragraph, true, '要公开发送的内容'],
        ['color', '颜色（可选）', TextInputStyle.Short, false, '例如：5865F2 或 #5865F2'],
        ['reply_id', '回复消息 ID（可选）', TextInputStyle.Short, false, '不回复任何消息就留空'],
        ['mention', '是否 @ 原消息作者', TextInputStyle.Short, false, '填写 true / false，默认 false'],
      ]
    : [
        ['content', '要发送的文字', TextInputStyle.Paragraph, true, '要公开发送的内容'],
        ['reply_id', '回复消息 ID（可选）', TextInputStyle.Short, false, '不回复任何消息就留空'],
        ['mention', '是否 @ 原消息作者', TextInputStyle.Short, false, '填写 true / false，默认 false'],
      ];
  return new ModalBuilder().setCustomId(`announce_modal:${type}`).setTitle(type === 'embed' ? '发送 Embed 公告' : '发送文字公告').addComponents(
    ...fields.map(([id, label, style, required, placeholder]) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setPlaceholder(placeholder).setMaxLength(id === 'description' || id === 'content' ? 4000 : 100),
    )),
  );
}

function parseAnnounceColor(value) {
  if (!value) return 0x5865f2;
  const normalized = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return Number.parseInt(normalized, 16);
}

async function publishAnnouncement(interaction, type) {
  const replyId = interaction.fields.getTextInputValue('reply_id').trim();
  const mentionValue = interaction.fields.getTextInputValue('mention').trim().toLowerCase();
  const mention = ['true', 'yes', 'y', '是', '要', '1'].includes(mentionValue);
  let referenceMessage = null;
  if (replyId) {
    if (!/^\d{15,25}$/.test(replyId)) {
      await interaction.reply({ content: '消息 ID 格式无效；请填写 15 至 25 位 Discord 消息 ID，或留空。', ephemeral: true });
      return;
    }
    referenceMessage = await interaction.channel.messages.fetch(replyId).catch(() => null);
    if (!referenceMessage) {
      await interaction.reply({ content: '找不到这个频道中的消息，公告没有发送。', ephemeral: true });
      return;
    }
  }
  const payload = {
    allowedMentions: {
      parse: ['users', 'roles', 'everyone'],
      repliedUser: Boolean(referenceMessage && mention),
    },
  };
  if (type === 'embed') {
    const color = parseAnnounceColor(interaction.fields.getTextInputValue('color'));
    if (color === null) {
      await interaction.reply({ content: '颜色格式无效，请填写 6 位十六进制颜色，例如 `5865F2`。', ephemeral: true });
      return;
    }
    payload.embeds = [new EmbedBuilder()
      .setTitle(interaction.fields.getTextInputValue('title').trim())
      .setDescription(interaction.fields.getTextInputValue('description').trim())
      .setColor(color)];
  } else {
    payload.content = interaction.fields.getTextInputValue('content').trim();
  }
  if (referenceMessage) payload.reply = { messageReference: referenceMessage.id, failIfNotExists: false };
  try {
    await interaction.reply({ content: '私密设置已确认，公告发送成功处理中；接下来会公开发布到当前频道。', ephemeral: true });
    const sent = await interaction.channel.send(payload);
    await interaction.editReply({ content: `公告已发送成功。${referenceMessage ? `已回复消息 ID：\`${referenceMessage.id}\`。` : ''}` });
    return sent;
  } catch (error) {
    console.error('Could not publish announcement:', error);
    await interaction.editReply({ content: '公告发送失败，请检查 Bot 是否拥有发送消息、嵌入链接和查看频道权限。' }).catch(() => {});
    return null;
  }
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('检查机器人是否在线。'),
  new SlashCommandBuilder().setName('help').setDescription('查看可用指令。'),
  new SlashCommandBuilder().setName('about').setDescription('查看机器人信息。'),
  new SlashCommandBuilder().setName('message').setDescription('查看自己的消息统计。'),
  new SlashCommandBuilder().setName('welcome').setDescription('打开欢迎和离开设置面板。'),
  new SlashCommandBuilder().setName('roles').setDescription('打开身份组面板设置。'),
  new SlashCommandBuilder().setName('moderation').setDescription('打开管理员惩罚系统设置。'),
  new SlashCommandBuilder().setName('serverstats').setDescription('打开服务器统计频道设置。'),
  new SlashCommandBuilder().setName('announce').setDescription('打开机器人代发公告面板。'),
  new SlashCommandBuilder()
    .setName('sticky').setDescription('设置或取消频道置底消息。')
    .addSubcommand((subcommand) => subcommand.setName('set').setDescription('设置置底消息。')
      .addStringOption((option) => option.setName('content').setDescription('置底消息内容。').setRequired(true))
      .addBooleanOption((option) => option.setName('all_channels').setDescription('是否在每一个文字频道设置。').setRequired(false))
      .addIntegerOption((option) => option.setName('refresh_seconds').setDescription('成员发消息后等待几秒再刷新，0 为立即。').setMinValue(0).setMaxValue(300).setRequired(false)))
    .addSubcommand((subcommand) => subcommand.setName('cancel').setDescription('取消置底消息。')
      .addBooleanOption((option) => option.setName('all_channels').setDescription('是否取消所有频道的置底。').setRequired(false))),
  new SlashCommandBuilder().setName('giveaway').setDescription('打开私密抽奖管理面板。'),
  new SlashCommandBuilder()
    .setName('mute').setDescription('暂时禁言一名成员。')
    .addUserOption((option) => option.setName('member').setDescription('要禁言的成员。').setRequired(true))
    .addStringOption((option) => option.setName('duration').setDescription('时长，例如 10m、2h、7d，最长28天。').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('惩罚原因，可不填。').setRequired(false)),
  new SlashCommandBuilder()
    .setName('unmute').setDescription('解除一名成员的禁言。')
    .addUserOption((option) => option.setName('member').setDescription('要解除禁言的成员。').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('解除原因，可不填。').setRequired(false)),
  new SlashCommandBuilder()
    .setName('kick').setDescription('将一名成员踢出服务器。')
    .addUserOption((option) => option.setName('member').setDescription('要踢出的成员。').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('惩罚原因，可不填。').setRequired(false)),
  new SlashCommandBuilder()
    .setName('ban').setDescription('封禁一名成员。')
    .addUserOption((option) => option.setName('member').setDescription('要封禁的成员。').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('惩罚原因，可不填。').setRequired(false)),
  new SlashCommandBuilder()
    .setName('unban').setDescription('解除一名用户的封禁。')
    .addStringOption((option) => option.setName('user_id').setDescription('被封禁用户的 Discord ID。').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('解除原因，可不填。').setRequired(false)),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const guildIds = [...new Set([
    ...(commandGuildId ? [commandGuildId] : []),
    ...allowedGuildIds,
  ])];

  if (guildIds.length > 0) {
    await Promise.all(
      guildIds.map((guildId) =>
        rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands }),
      ),
    );
    console.log(`Registered commands instantly in guilds: ${guildIds.join(', ')}`);
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('Registered global commands. They may take up to an hour to appear.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildPresences],
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.author.bot) return;
  const moderationConfig = getGuildSettings(message.guild.id);
  const prefix = moderationConfig.moderationPrefix || '!';
  if (message.content.startsWith(prefix)) {
    const parts = message.content.slice(prefix.length).trim().split(/\s+/);
    const action = parts.shift()?.toLowerCase();
    if (['mute', 'unmute', 'kick', 'ban', 'unban'].includes(action)) {
      const target = parts.shift();
      const duration = action === 'mute' ? parts.shift() : '';
      const reason = parts.join(' ');
      performPrefixModeration(message, action, { target, duration, reason }).catch((error) => console.error('Prefix moderation error:', error));
    }
    if (['sticky', '置底'].includes(action)) {
      performPrefixSticky(message, parts).catch((error) => console.error('Prefix sticky error:', error));
    }
  }
  refreshStickyForMessage(message).catch((error) => console.error('Sticky refresh error:', error));
  settings.giveawayMessages[message.guild.id] ||= {};
  settings.giveawayMessages[message.guild.id][message.author.id] = (settings.giveawayMessages[message.guild.id][message.author.id] || 0) + 1;
  settings.messageStats[message.guild.id] ||= {};
  settings.messageStats[message.guild.id][message.author.id] ||= {};
  const dateKey = shanghaiDateKey();
  settings.messageStats[message.guild.id][message.author.id][dateKey] = (settings.messageStats[message.guild.id][message.author.id][dateKey] || 0) + 1;
  giveawayMessageSaveCounter += 1;
  if (giveawayMessageSaveCounter >= 10) {
    giveawayMessageSaveCounter = 0;
    saveSettings();
  }
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  if (allowedGuildIds.size) console.log(`Restricted to guilds: ${[...allowedGuildIds].join(', ')}`);
  for (const giveaway of Object.values(settings.giveaways)) {
    if (giveaway.status === 'active') {
      if (Date.now() >= giveaway.endsAt) finishGiveaway(giveaway.id).catch(console.error);
      else scheduleGiveaway(giveaway);
    }
  }
  for (const guild of readyClient.guilds.cache.values()) updateServerStats(guild).catch(console.error);
});

client.on(Events.GuildCreate, async (guild) => {
  if (!(await isGuildUsable(guild))) {
    console.log(`Leaving unauthorized guild ${guild.id}.`);
    await guild.leave().catch((error) => console.error('Could not leave guild:', error));
  }
});

async function sendWelcome(member) {
  if (!(await isGuildUsable(member.guild)) || member.user.bot) return;
  const config = getGuildSettings(member.guild.id);
  const content = replacePlaceholders(config.welcomeMessage, member);
  const embed = new EmbedBuilder().setColor(0x57f287).setDescription(content);
  if (config.welcomeImage) embed.setImage(config.welcomeImage);
  const channel = config.welcomeChannelId && await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(console.error);
  if (config.dmWelcome) {
    const dmEmbed = new EmbedBuilder().setColor(0x57f287).setDescription(replacePlaceholders(config.dmWelcomeMessage, member));
    if (config.welcomeImage) dmEmbed.setImage(config.welcomeImage);
    await member.send({ embeds: [dmEmbed] }).catch(() => console.warn(`Could not DM ${member.user.tag}.`));
  }
}

async function sendLeave(member) {
  if (!(await isGuildUsable(member.guild)) || member.user.bot) return;
  const config = getGuildSettings(member.guild.id);
  const channel = config.leaveChannelId && await member.guild.channels.fetch(config.leaveChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder().setColor(0xed4245).setDescription(replacePlaceholders(config.leaveMessage, member));
  if (config.leaveImage) embed.setImage(config.leaveImage);
  await channel.send({ embeds: [embed] }).catch(console.error);
}

client.on(Events.GuildMemberAdd, sendWelcome);
client.on(Events.GuildMemberRemove, sendLeave);
client.on(Events.GuildMemberAdd, (member) => updateServerStats(member.guild).catch(console.error));
client.on(Events.GuildMemberRemove, (member) => updateServerStats(member.guild).catch(console.error));
client.on(Events.PresenceUpdate, (_oldPresence, presence) => updateServerStats(presence.guild).catch(console.error));

function moderationEmbed(guild, action, target, duration, reason, executor, actionChannel, directMessage = false) {
  const targetId = target.id || target.user?.id;
  const targetName = target.user?.tag || target.tag || target.username || targetId;
  const targetUser = target.user || target;
  const executorAvatar = executor.displayAvatarURL?.({ extension: 'png', size: 128 });
  const targetAvatar = targetUser.displayAvatarURL?.({ extension: 'png', size: 256 });
  const embed = new EmbedBuilder()
    .setColor(action === 'unmute' || action === 'unban' ? 0x57f287 : 0xed4245)
    .setTitle(directMessage ? `你在「${guild.name}」的处罚通知` : '管理员惩罚记录')
    .setAuthor({ name: `${executor.tag} 执行了此操作`, iconURL: executorAvatar })
    .addFields(
      { name: '实行', value: `\`/${action}\``, inline: true },
      { name: '实行对象', value: `<@${targetId}>\n**${targetName}**\nID：${targetId}`, inline: true },
      { name: '实行原因', value: reason || '未填写', inline: false },
      { name: '实行人员', value: `<@${executor.id}>\n${executor.tag}`, inline: true },
      { name: '实行频道', value: actionChannel ? `<#${actionChannel.id}>` : '私讯 / 无频道', inline: true },
      { name: '实行时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
    )
    .setTimestamp();
  if (action === 'mute') embed.spliceFields(2, 0, { name: '禁言时长', value: duration, inline: true });
  if (targetAvatar) embed.setThumbnail(targetAvatar);
  if (!directMessage) embed.setFooter({ text: `${guild.name} · Discord 管理员惩罚记录`, iconURL: guild.iconURL?.({ extension: 'png', size: 64 }) || undefined });
  return embed;
}

async function logModeration(guild, config, action, target, duration, reason, executor, actionChannel) {
  if (!config.moderationLogChannelId) return;
  const logChannel = await guild.channels.fetch(config.moderationLogChannelId).catch(() => null);
  if (!logChannel?.isTextBased()) return;
  const embed = moderationEmbed(guild, action, target, duration, reason, executor, actionChannel);
  await logChannel.send({ embeds: [embed] }).catch((error) => console.error('Could not write moderation log:', error));
}

async function notifyModeratedUser(guild, action, target, duration, reason, executor, actionChannel) {
  const user = target.user || target;
  if (!user?.send) return;
  const embed = moderationEmbed(guild, action, target, duration, reason, executor, actionChannel, true);
  await user.send({ embeds: [embed] }).catch(() => console.warn(`Could not DM ${user.tag || user.id}.`));
}

async function performModeration(interaction, action) {
  await interaction.deferReply();
  const config = getGuildSettings(interaction.guild.id);
  const reason = (interaction.options.getString('reason') || '未填写').slice(0, 512);
  const user = interaction.options.getUser('member');

  if (action === 'unban') {
    const userId = interaction.options.getString('user_id').trim();
    if (!/^\d{15,25}$/.test(userId)) {
      await interaction.editReply({ content: '请输入有效的 Discord 用户 ID。' });
      return;
    }
    const target = await client.users.fetch(userId).catch(() => null);
    if (!target) {
      await interaction.editReply({ content: '找不到这个用户。' });
      return;
    }
    const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
    if (!ban) {
      await interaction.editReply({ content: '这个用户目前没有被本服务器封禁。' });
      return;
    }
    try {
      await interaction.guild.members.unban(userId, reason);
      await interaction.editReply({ content: `已解除 **${target.tag}** 的封禁。` });
      Promise.all([
        logModeration(interaction.guild, config, 'unban', target, '', reason, interaction.user, interaction.channel),
        notifyModeratedUser(interaction.guild, 'unban', target, '', reason, interaction.user, interaction.channel),
      ]).catch((error) => console.error('Could not finish unban notifications:', error));
    } catch (error) {
      console.error('Unban failed:', error);
      await interaction.editReply({ content: '解除封禁失败，请检查 Bot 是否拥有封禁成员权限。' });
    }
    return;
  }

  const member = user && await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: '找不到这个服务器成员。' });
    return;
  }
  if (member.id === interaction.user.id) {
    await interaction.editReply({ content: '不能对自己执行这个操作。' });
    return;
  }
  if (!member.moderatable && action !== 'ban' && action !== 'kick') {
    await interaction.editReply({ content: 'Bot 无法管理这个成员，请检查身份组层级和权限。' });
    return;
  }
  if ((action === 'kick' || action === 'ban') && !member.kickable && action === 'kick') {
    await interaction.editReply({ content: 'Bot 无法踢出这个成员，请检查身份组层级和权限。' });
    return;
  }
  if (action === 'ban' && !member.bannable) {
    await interaction.editReply({ content: 'Bot 无法封禁这个成员，请检查身份组层级和权限。' });
    return;
  }

  try {
    let durationText = '';
    if (action === 'mute') {
      const duration = parseDuration(interaction.options.getString('duration'));
      if (!duration) {
        await interaction.editReply({ content: '时长格式无效，请使用例如 `10m`、`2h`、`7d`，最长 28 天。' });
        return;
      }
      durationText = formatDuration(duration);
      await member.timeout(duration, reason);
    } else if (action === 'unmute') {
      await member.timeout(null, reason);
    } else if (action === 'kick') {
      await member.kick(reason);
    } else if (action === 'ban') {
      await member.ban({ reason, deleteMessageSeconds: 0 });
    }
    await interaction.editReply({ content: `已对 **${user.tag}** 执行 \/${action}${action === 'mute' ? `（${durationText}）` : ''}。` });
    Promise.all([
      logModeration(interaction.guild, config, action, member, durationText, reason, interaction.user, interaction.channel),
      notifyModeratedUser(interaction.guild, action, member, durationText, reason, interaction.user, interaction.channel),
    ]).catch((error) => console.error('Could not finish moderation notifications:', error));
  } catch (error) {
    console.error(`${action} failed:`, error);
    await interaction.editReply({ content: `执行 /${action} 失败，请检查 Bot 权限、身份组层级和目标成员状态。` }).catch(() => {});
  }
}

async function performPrefixModeration(message, action, args) {
  if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply('只有拥有“管理服务器”权限的管理员可以使用惩罚指令。');
    return;
  }
  const config = getGuildSettings(message.guild.id);
  const reason = (args.reason || '未填写').slice(0, 512);
  if (action === 'unban') {
    const userId = args.target;
    if (!/^\d{15,25}$/.test(userId || '')) { await message.reply('用法：unban 用户ID 原因'); return; }
    const target = await client.users.fetch(userId).catch(() => null);
    const ban = await message.guild.bans.fetch(userId).catch(() => null);
    if (!target || !ban) { await message.reply('找不到这个用户，或这个用户目前没有被本服务器封禁。'); return; }
    try {
      await message.guild.members.unban(userId, reason);
      await message.reply(`已解除 **${target.tag}** 的封禁。`);
      Promise.all([
        logModeration(message.guild, config, 'unban', target, '', reason, message.author, message.channel),
        notifyModeratedUser(message.guild, 'unban', target, '', reason, message.author, message.channel),
      ]).catch(console.error);
    } catch (error) { console.error('Prefix unban failed:', error); await message.reply('解除封禁失败，请检查 Bot 权限。'); }
    return;
  }
  const targetId = (args.target || '').match(/^<@!?([0-9]{15,25})>$/)?.[1] || args.target;
  const member = await message.guild.members.fetch(targetId).catch(() => null);
  if (!member) { await message.reply('找不到这个服务器成员。用法：mute @成员 10m 原因'); return; }
  if (member.id === message.author.id) { await message.reply('不能对自己执行这个操作。'); return; }
  if ((action === 'mute' || action === 'unmute') && !member.moderatable) { await message.reply('Bot 无法管理这个成员，请检查身份组层级和权限。'); return; }
  if (action === 'kick' && !member.kickable) { await message.reply('Bot 无法踢出这个成员，请检查身份组层级和权限。'); return; }
  if (action === 'ban' && !member.bannable) { await message.reply('Bot 无法封禁这个成员，请检查身份组层级和权限。'); return; }
  let durationText = '';
  try {
    if (action === 'mute') {
      const duration = parseDuration(args.duration);
      if (!duration) { await message.reply('用法：mute @成员 10m 原因；时长最长 28 天。'); return; }
      durationText = formatDuration(duration);
      await member.timeout(duration, reason);
    } else if (action === 'unmute') await member.timeout(null, reason);
    else if (action === 'kick') await member.kick(reason);
    else if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 0 });
    await message.reply(`已对 **${member.user.tag}** 执行 ${config.moderationPrefix}${action}${action === 'mute' ? `（${durationText}）` : ''}。`);
    Promise.all([
      logModeration(message.guild, config, action, member, durationText, reason, message.author, message.channel),
      notifyModeratedUser(message.guild, action, member, durationText, reason, message.author, message.channel),
    ]).catch(console.error);
  } catch (error) { console.error(`Prefix ${action} failed:`, error); await message.reply(`执行 ${config.moderationPrefix}${action} 失败，请检查 Bot 权限和身份组层级。`); }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild || !(await isGuildUsable(interaction.guild))) {
    await interaction.reply({ content: '这个服务器没有启用此机器人。', ephemeral: true }).catch(() => {});
    return;
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'ping') {
      await interaction.reply(`Pong！当前延迟：${client.ws.ping}ms`);
    } else if (interaction.commandName === 'help') {
      await interaction.reply({ content: '**可用指令**\n`/ping` — 检查机器人延迟\n`/help` — 查看帮助\n`/about` — 查看机器人信息\n`/message` — 查看今天、本周、本月和总消息数\n`/welcome` — 打开欢迎离开设置面板\n`/roles` — 打开身份组面板设置\n`/moderation` — 设置惩罚日志频道和 Prefix\n`/serverstats` — 设置服务器统计频道\n`/announce` — 让 Bot 代发文字或 Embed 公告\n`/sticky` — 设置或取消置底消息\n`/giveaway` — 打开私密抽奖面板\n`/mute` `/unmute` `/kick` `/ban` `/unban` — 管理成员', ephemeral: true });
    } else if (interaction.commandName === 'about') {
      await interaction.reply('这是一个使用 discord.js 构建的中文 Discord 机器人。');
    } else if (interaction.commandName === 'message') {
      const summary = getMessageSummary(interaction.guild.id, interaction.user.id);
      await interaction.reply({ content: `**${interaction.user.username} 的消息统计**\n\n今天：**${summary.today}** 条\n本周：**${summary.week}** 条\n本月：**${summary.month}** 条\n总数：**${summary.total}** 条\n\n统计时区：Asia/Shanghai`, ephemeral: true });
    } else if (interaction.commandName === 'welcome') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限，且服务器有机器人拥有者或在允许服务器列表中的成员可以使用。', ephemeral: true });
        return;
      }
      const config = getGuildSettings(interaction.guild.id);
      await interaction.reply({ embeds: [panelEmbed(interaction.guild, config)], components: panelComponents(config), ephemeral: true });
    } else if (interaction.commandName === 'roles') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限，且服务器有机器人拥有者或在允许服务器列表中的成员可以使用。', ephemeral: true });
        return;
      }
      const config = getGuildSettings(interaction.guild.id).rolePanel;
      await interaction.reply({ embeds: [rolePanelEmbed(interaction.guild, config)], components: roleConfigComponents(config), ephemeral: true });
    } else if (interaction.commandName === 'moderation') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限，且服务器有机器人拥有者或在允许服务器列表中的成员可以使用。', ephemeral: true });
        return;
      }
      const config = getGuildSettings(interaction.guild.id);
      await interaction.reply({ embeds: [moderationPanelEmbed(interaction.guild, config)], components: moderationPanelComponents(), ephemeral: true });
    } else if (interaction.commandName === 'serverstats') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限的管理员可以设置服务器统计。', ephemeral: true });
        return;
      }
      const config = getGuildSettings(interaction.guild.id);
      await interaction.reply({ embeds: [serverStatsEmbed(interaction.guild, config)], components: serverStatsComponents(config.serverStats), ephemeral: true });
    } else if (interaction.commandName === 'announce') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限的管理员可以使用公告代发功能。', ephemeral: true });
        return;
      }
      await interaction.reply({ content: '请选择要发送的公告类型。公开消息不会显示你的身份。', components: announceComponents(), ephemeral: true });
    } else if (interaction.commandName === 'sticky') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限的管理员可以使用置底功能。', ephemeral: true });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      const allChannels = interaction.options.getBoolean('all_channels') || false;
      if (subcommand === 'set') {
        const content = interaction.options.getString('content').trim();
        const refreshSeconds = interaction.options.getInteger('refresh_seconds') ?? 5;
        if (!content) { await interaction.reply({ content: '置底内容不能为空。', ephemeral: true }); return; }
        await setSticky(interaction.guild, interaction.channel, content, allChannels ? 'all' : 'current', refreshSeconds);
        await interaction.reply({ content: `已设置${allChannels ? '所有文字频道' : '当前频道'}的置底消息，刷新时间：${refreshSeconds} 秒。`, ephemeral: true });
      } else {
        await cancelSticky(interaction.guild, interaction.channel, allChannels ? 'all' : 'current');
        await interaction.reply({ content: `已取消${allChannels ? '所有文字频道' : '当前频道'}的置底消息。`, ephemeral: true });
      }
    } else if (interaction.commandName === 'giveaway') {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限的管理员可以创建和管理抽奖。', ephemeral: true });
        return;
      }
      const active = Object.values(settings.giveaways);
      await interaction.reply({ embeds: [giveawayPanelEmbed(interaction.guild, active)], components: giveawayPanelButtons(active, interaction.guild.id), ephemeral: true });
    } else if (['mute', 'unmute', 'kick', 'ban', 'unban'].includes(interaction.commandName)) {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限，且服务器有机器人拥有者或在允许服务器列表中的成员可以使用。' });
        return;
      }
      await performModeration(interaction, interaction.commandName);
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('role_toggle:')) {
    const roleId = interaction.customId.split(':')[1];
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed) {
      await interaction.reply({ content: '这个身份组不存在或无法由机器人管理。', ephemeral: true });
      return;
    }
    if (role.position >= interaction.guild.members.me.roles.highest.position) {
      await interaction.reply({ content: '机器人无法管理这个身份组，请把 Bot 的身份组拖到它上面。', ephemeral: true });
      return;
    }
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(role);
        await interaction.reply({ content: `已移除身份组：${role.name}`, ephemeral: true });
      } else {
        await member.roles.add(role);
        await interaction.reply({ content: `已领取身份组：${role.name}`, ephemeral: true });
      }
    } catch (error) {
      console.error('Could not toggle role:', error);
      await interaction.reply({ content: '身份组操作失败，请检查 Bot 是否拥有管理身份组权限。', ephemeral: true });
    }
    return;
  }

  if (interaction.isButton() && (interaction.customId.startsWith('giveaway_join:') || interaction.customId.startsWith('giveaway_leave:'))) {
    const [action, giveawayId] = interaction.customId.split(':');
    const giveaway = settings.giveaways[giveawayId];
    if (!giveaway || giveaway.status !== 'active') {
      await interaction.reply({ content: '这个抽奖已经结束或不存在。', ephemeral: true });
      return;
    }
    if (Date.now() >= giveaway.endsAt) {
      await finishGiveaway(giveaway.id);
      await interaction.reply({ content: '这个抽奖刚刚结束了。', ephemeral: true });
      return;
    }
    if (action === 'giveaway_join') {
      const currentUser = await interaction.user.fetch(true).catch(() => interaction.user);
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) { await interaction.reply({ content: '找不到你的服务器成员资料。', ephemeral: true }); return; }
      const eligibility = await checkGiveawayEligibility(giveaway, interaction, member, currentUser);
      if (!eligibility.ok) {
        await interaction.reply({ content: eligibility.reason, ephemeral: true });
        return;
      }
      if (giveaway.entries.includes(interaction.user.id)) {
        await interaction.reply({ content: '你已经参加这个抽奖了。', ephemeral: true });
        return;
      }
      giveaway.entries.push(interaction.user.id);
      giveaway.entryWeightByUser ||= {};
      giveaway.entryWeightByUser[interaction.user.id] = eligibility.weight;
      giveaway.entryWeights = Object.values(giveaway.entryWeightByUser).reduce((sum, value) => sum + value, 0);
      await interaction.reply({ content: '你已成功参加抽奖，祝你好运！', ephemeral: true });
      if (giveaway.firstEntries && giveaway.entries.length >= giveaway.firstEntries) {
        await finishGiveaway(giveaway.id, false, true);
        return;
      }
    } else {
      giveaway.entries = giveaway.entries.filter((id) => id !== interaction.user.id);
      if (giveaway.entryWeightByUser) delete giveaway.entryWeightByUser[interaction.user.id];
      giveaway.entryWeights = Object.values(giveaway.entryWeightByUser || {}).reduce((sum, value) => sum + value, 0);
      await interaction.reply({ content: '你已退出这个抽奖。', ephemeral: true });
    }
    saveSettings();
    const message = await interaction.channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (message) await message.edit({ embeds: [giveawayEmbed(giveaway)], components: giveawayButtons(giveaway) }).catch(console.error);
    return;
  }

  if (interaction.isButton() && (interaction.customId === 'announce_text' || interaction.customId === 'announce_embed')) {
    if (!(await canManage(interaction))) {
      await interaction.reply({ content: '只有拥有“管理服务器”权限的管理员可以使用公告代发功能。', ephemeral: true });
      return;
    }
    await interaction.showModal(announceModal(interaction.customId === 'announce_embed' ? 'embed' : 'text'));
    return;
  }

  if (!(await canManage(interaction))) {
    await interaction.reply({ content: '只有授权用户可以操作这个设置面板。', ephemeral: true }).catch(() => {});
    return;
  }

  const config = getGuildSettings(interaction.guild.id);

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('giveaway_tag_toggle:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft || draft.guildId !== interaction.guild.id || draft.hostId !== interaction.user.id) {
        await interaction.reply({ content: '这个抽奖设置已过期，请重新执行 `/giveaway`。', ephemeral: true });
        return;
      }
      draft.requireServerTag = !draft.requireServerTag;
      await interaction.update({ embeds: [giveawayAdvancedEmbed(draft)], components: giveawayAdvancedButtons(draft) });
    } else if (interaction.customId.startsWith('giveaway_tag:')) {
      const [, tagValue, draftId] = interaction.customId.split(':');
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft || draft.guildId !== interaction.guild.id || draft.hostId !== interaction.user.id) {
        await interaction.reply({ content: '这个抽奖设置已过期，请重新执行 `/giveaway`。', ephemeral: true });
        return;
      }
      draft.id = draftId;
      draft.requireServerTag = tagValue === 'true';
      draft.requiredRoleIds ||= [];
      draft.bypassRoleIds ||= [];
      draft.blacklistedRoleIds ||= [];
      draft.extraEntries ||= [];
      await interaction.update({ content: '服务器 Tag 条件已保存。请继续设置第二阶段条件，或直接点击“发布抽奖”。', embeds: [giveawayAdvancedEmbed(draft)], components: giveawayAdvancedButtons(draftId) });
    } else if (/^giveaway_(required_roles|bypass_roles|blacklist_roles):/.test(interaction.customId)) {
      const [kind, draftId] = interaction.customId.split(':');
      const menu = new RoleSelectMenuBuilder().setCustomId(`${kind}_select:${draftId}`).setPlaceholder('选择身份组（可多选）').setMinValues(1).setMaxValues(10);
      await interaction.reply({ content: '请选择身份组；这个提示仅你可见。', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    } else if (interaction.customId.startsWith('giveaway_numeric:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.id = draftId;
      await interaction.showModal(giveawayNumericModal(draft));
    } else if (interaction.customId.startsWith('giveaway_extra_entries:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.id = draftId;
      await interaction.showModal(giveawayExtraEntriesModal(draft));
    } else if (interaction.customId.startsWith('giveaway_first_entries:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.id = draftId;
      await interaction.showModal(new ModalBuilder().setCustomId(`giveaway_first_entries_modal:${draftId}`).setTitle('设置前 N 位获奖').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('count').setLabel('前几位参加者直接获奖').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(draft.firstEntries || 0)).setPlaceholder('填写 0 表示关闭'))));
    } else if (interaction.customId.startsWith('giveaway_repeat:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.id = draftId;
      await interaction.showModal(giveawayRepeatModal(draft));
    } else if (interaction.customId.startsWith('giveaway_winner_role:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      await interaction.reply({ content: '请选择获奖后自动发放的身份组；此提示仅你可见。', components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`giveaway_winner_role_select:${draftId}`).setPlaceholder('选择获奖身份组').setMinValues(1).setMaxValues(1))], ephemeral: true });
    } else if (interaction.customId.startsWith('giveaway_winner_thread:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.winnerThread = !draft.winnerThread;
      await interaction.update({ embeds: [giveawayAdvancedEmbed(draft)], components: giveawayAdvancedButtons(draft) });
    } else if (interaction.customId.startsWith('giveaway_template_save:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.id = draftId;
      await interaction.showModal(giveawayTemplateModal(draft));
    } else if (interaction.customId.startsWith('giveaway_template_load:')) {
      const draftId = interaction.customId.split(':')[1];
      const select = templateSelect(interaction.guild.id, draftId);
      if (!select) await interaction.reply({ content: '这个服务器还没有保存的抽奖模板。', ephemeral: true });
      else await interaction.reply({ content: '请选择要载入的模板；此提示仅你可见。', components: [select], ephemeral: true });
    } else if (interaction.customId.startsWith('giveaway_stats:')) {
      await interaction.reply({ embeds: [giveawayStatsEmbed(interaction.guild, Object.values(settings.giveaways))], ephemeral: true });
    } else if (interaction.customId.startsWith('giveaway_publish:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      const giveaway = { id: draftId, ...draft, messageId: '', entries: [], entryWeights: 0, entryWeightByUser: {}, winnerIds: [], createdAt: Date.now(), endsAt: Date.now() + draft.duration, status: 'active' };
      const message = await interaction.channel.send({ embeds: [giveawayEmbed(giveaway)], components: giveawayButtons(giveaway) });
      giveaway.messageId = message.id;
      settings.giveaways[giveaway.id] = giveaway;
      pendingGiveawayDrafts.delete(draftId);
      saveSettings();
      scheduleGiveaway(giveaway);
      await interaction.update({ content: `抽奖已发布到当前频道，抽奖 ID：\`${giveaway.id}\``, embeds: [], components: [] });
    } else if (interaction.customId.startsWith('giveaway_advanced_refresh:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true });
      else await interaction.update({ embeds: [giveawayAdvancedEmbed(draft)], components: giveawayAdvancedButtons(draft) });
    } else if (interaction.customId === 'giveaway_create') {
      await interaction.showModal(giveawayModal());
    } else if (interaction.customId === 'giveaway_refresh') {
      const active = Object.values(settings.giveaways);
      await interaction.update({ embeds: [giveawayPanelEmbed(interaction.guild, active)], components: giveawayPanelButtons(active, interaction.guild.id) });
    } else if (interaction.customId.startsWith('giveaway_end:')) {
      const giveaway = settings.giveaways[interaction.customId.split(':')[1]];
      if (!giveaway || giveaway.status !== 'active') await interaction.reply({ content: '这个抽奖已经结束或不存在。', ephemeral: true });
      else { await interaction.deferUpdate(); await finishGiveaway(giveaway.id); }
    } else if (interaction.customId.startsWith('giveaway_reroll:')) {
      const giveaway = settings.giveaways[interaction.customId.split(':')[1]];
      if (!giveaway || giveaway.status !== 'ended') await interaction.reply({ content: '只有已经结束的抽奖才能重抽。', ephemeral: true });
      else if (Date.now() - (giveaway.endedAt || giveaway.endsAt) > REROLL_WINDOW_MS) await interaction.reply({ content: '这个抽奖结束已超过 7 天，重抽功能已自动关闭。', ephemeral: true });
      else { await interaction.deferUpdate(); await finishGiveaway(giveaway.id, true); }
    } else if (interaction.customId.startsWith('giveaway_clear:')) {
      const giveawayId = interaction.customId.split(':')[1];
      const giveaway = settings.giveaways[giveawayId];
      if (!giveaway) await interaction.reply({ content: '这个抽奖记录不存在。', ephemeral: true });
      else {
        delete settings.giveaways[giveawayId];
        saveSettings();
        await interaction.update({ embeds: [giveawayPanelEmbed(interaction.guild, Object.values(settings.giveaways))], components: giveawayPanelButtons(Object.values(settings.giveaways), interaction.guild.id) });
      }
    } else if (interaction.customId === 'serverstats_setup') {
      await interaction.showModal(serverStatsModal(config.serverStats));
    } else if (interaction.customId === 'serverstats_update') {
      config.serverStats.enabled = true;
      await updateServerStats(interaction.guild);
      await interaction.update({ embeds: [serverStatsEmbed(interaction.guild, config)], components: serverStatsComponents(config.serverStats) });
    } else if (['serverstats_total', 'serverstats_humans', 'serverstats_online', 'serverstats_bots'].includes(interaction.customId)) {
      const key = {
        serverstats_total: 'showTotal',
        serverstats_humans: 'showHumans',
        serverstats_online: 'showOnline',
        serverstats_bots: 'showBots',
      }[interaction.customId];
      config.serverStats[key] = !config.serverStats[key];
      config.serverStats.enabled = true;
      await updateServerStats(interaction.guild);
      await interaction.update({ embeds: [serverStatsEmbed(interaction.guild, config)], components: serverStatsComponents(config.serverStats) });
    } else if (interaction.customId === 'serverstats_toggle') {
      config.serverStats.enabled = !config.serverStats.enabled;
      saveSettings();
      if (config.serverStats.enabled) await updateServerStats(interaction.guild);
      await interaction.update({ embeds: [serverStatsEmbed(interaction.guild, config)], components: serverStatsComponents(config.serverStats) });
    } else if (interaction.customId === 'moderation_log_channel') {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('moderation_log_channel_select')
        .setPlaceholder('选择惩罚日志频道')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      await interaction.reply({ content: '请选择查看 mute、unmute、kick、ban、unban 记录的频道：', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    } else if (interaction.customId === 'moderation_prefix') {
      await interaction.showModal(textModal('moderation_prefix_modal', '设置 Prefix 指令符号', '符号（1至3个字符）', config.moderationPrefix));
    } else if (interaction.customId === 'moderation_refresh') {
      await interaction.update({ embeds: [moderationPanelEmbed(interaction.guild, config)], components: moderationPanelComponents() });
    } else if (interaction.customId === 'role_title') {
      await interaction.showModal(textModal('role_title_modal', '设置身份组面板标题', '面板标题', config.rolePanel.title));
    } else if (interaction.customId === 'role_description') {
      await interaction.showModal(textModal('role_description_modal', '设置身份组面板文字', '面板文字', config.rolePanel.description, true));
    } else if (interaction.customId === 'role_add') {
      const menu = new RoleSelectMenuBuilder()
        .setCustomId('role_add_select')
        .setPlaceholder('选择要加入面板的身份组')
        .setMinValues(1)
        .setMaxValues(1);
      await interaction.reply({ content: '请选择身份组，下一步再输入按钮文字：', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    } else if (interaction.customId === 'role_remove') {
      const menu = new RoleSelectMenuBuilder()
        .setCustomId('role_remove_select')
        .setPlaceholder('选择要从面板移除的身份组')
        .setMinValues(1)
        .setMaxValues(25);
      await interaction.reply({ content: '请选择要移除的身份组，可多选；不会删除服务器身份组。', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    } else if (interaction.customId === 'role_mode') {
      config.rolePanel.mode = config.rolePanel.mode === 'select' ? 'buttons' : 'select';
      saveSettings();
      await interaction.update({ embeds: [rolePanelEmbed(interaction.guild, config.rolePanel)], components: roleConfigComponents(config.rolePanel) });
    } else if (interaction.customId === 'role_refresh') {
      await interaction.update({ embeds: [rolePanelEmbed(interaction.guild, config.rolePanel)], components: roleConfigComponents(config.rolePanel) });
    } else if (interaction.customId === 'role_publish') {
      const message = await interaction.channel.send({ embeds: [rolePanelEmbed(interaction.guild, config.rolePanel)], components: rolePanelPublicComponents(config.rolePanel) });
      await interaction.reply({ content: `身份组面板已发布：[点击查看](https://discord.com/channels/${interaction.guild.id}/${message.channel.id}/${message.id})`, ephemeral: true });
    } else if (interaction.customId === 'welcome_channel' || interaction.customId === 'leave_channel') {
      const type = interaction.customId === 'welcome_channel' ? 'welcome' : 'leave';
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(`${type}_channel_select`)
        .setPlaceholder(`选择${type === 'welcome' ? '欢迎' : '离开'}频道`)
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      await interaction.reply({ content: `请选择${type === 'welcome' ? '欢迎' : '离开'}消息要发送的文字频道：`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    } else if (interaction.customId === 'welcome_message') {
      await interaction.showModal(textModal('welcome_message_modal', '设置欢迎内容', '欢迎内容', config.welcomeMessage, true));
    } else if (interaction.customId === 'leave_message') {
      await interaction.showModal(textModal('leave_message_modal', '设置离开内容', '离开内容', config.leaveMessage, true));
    } else if (interaction.customId === 'welcome_image') {
      await interaction.showModal(textModal('welcome_image_modal', '设置欢迎图片', '图片 URL（留空可清除）', config.welcomeImage));
    } else if (interaction.customId === 'leave_image') {
      await interaction.showModal(textModal('leave_image_modal', '设置离开图片', '图片 URL（留空可清除）', config.leaveImage));
    } else if (interaction.customId === 'dm_message') {
      await interaction.showModal(textModal('dm_message_modal', '设置私讯欢迎内容', '私讯内容', config.dmWelcomeMessage, true));
    } else if (interaction.customId === 'dm_welcome') {
      config.dmWelcome = !config.dmWelcome;
      saveSettings();
      await interaction.update({ embeds: [panelEmbed(interaction.guild, config)], components: panelComponents(config) });
    } else if (interaction.customId === 'welcome_refresh') {
      await interaction.update({ embeds: [panelEmbed(interaction.guild, config)], components: panelComponents(config) });
    }
    return;
  }

  if (interaction.isChannelSelectMenu()) {
    if (interaction.customId === 'moderation_log_channel_select') {
      config.moderationLogChannelId = interaction.values[0];
      saveSettings();
      await interaction.update({ content: `惩罚日志频道已设置为 <#${interaction.values[0]}>。请回到原来的私密面板并点击“刷新”。`, components: [] });
      return;
    }
    if (interaction.customId === 'welcome_channel_select') config.welcomeChannelId = interaction.values[0];
    if (interaction.customId === 'leave_channel_select') config.leaveChannelId = interaction.values[0];
    saveSettings();
    await interaction.update({ content: `已设置为 <#${interaction.values[0]}>。请回到原来的私密面板并点击“刷新面板”。`, components: [] });
    return;
  }

  if (interaction.isRoleSelectMenu()) {
    if (interaction.customId.startsWith('giveaway_winner_role_select:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft || draft.hostId !== interaction.user.id) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      const role = await interaction.guild.roles.fetch(interaction.values[0]).catch(() => null);
      if (!role || role.managed || role.position >= interaction.guild.members.me.roles.highest.position) { await interaction.update({ content: '这个身份组无法由 Bot 发放，请选择 Bot 身份组以下的普通身份组。', components: [] }); return; }
      draft.winnerRoleId = role.id;
      await interaction.update({ content: `获奖身份组已设置为 ${role}。请回到抽奖进阶面板并点击“刷新条件”。`, components: [] });
      return;
    }
    if (/^giveaway_(required_roles|bypass_roles|blacklist_roles)_select:/.test(interaction.customId)) {
      const [kind, draftId] = interaction.customId.split(':');
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft || draft.hostId !== interaction.user.id) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      const key = kind === 'giveaway_required_roles_select' ? 'requiredRoleIds' : kind === 'giveaway_bypass_roles_select' ? 'bypassRoleIds' : 'blacklistedRoleIds';
      draft[key] = [...new Set(interaction.values)];
      await interaction.update({ content: '身份组条件已保存，请回到抽奖进阶条件面板继续设置。', components: [] });
      return;
    }
    if (interaction.customId === 'role_remove_select') {
      const before = config.rolePanel.roles.length;
      config.rolePanel.roles = config.rolePanel.roles.filter((item) => !interaction.values.includes(item.roleId));
      saveSettings();
      await interaction.update({ content: before === config.rolePanel.roles.length ? '这些身份组目前没有加入身份组面板。' : `已从面板移除 ${before - config.rolePanel.roles.length} 个身份组。请回到原来的私密面板并点击“刷新”。`, components: [] });
      return;
    }
    if (interaction.customId !== 'role_add_select') return;
    const roleId = interaction.values[0];
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed) {
      await interaction.reply({ content: '这个身份组不存在或无法由机器人管理。', ephemeral: true });
      return;
    }
    await interaction.showModal(textModal(`role_label_modal:${roleId}`, '设置身份组按钮文字', '按钮名称（留空使用身份组名称）', role.name, false));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'role_select') {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) { await interaction.reply({ content: '找不到你的服务器成员资料。', ephemeral: true }); return; }
    const roleConfig = getGuildSettings(interaction.guild.id).rolePanel;
    const configuredRoles = new Map(roleConfig.roles.map((item) => [item.roleId, item]));
    const results = [];
    for (const roleId of interaction.values) {
      if (!configuredRoles.has(roleId)) continue;
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.managed || role.position >= interaction.guild.members.me.roles.highest.position) {
        results.push(`无法管理 <@&${roleId}>`);
        continue;
      }
      try {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(role);
          results.push(`已移除 ${role.name}`);
        } else {
          await member.roles.add(role);
          results.push(`已领取 ${role.name}`);
        }
      } catch (error) {
        console.error('Could not toggle select role:', error);
        results.push(`${role.name} 操作失败`);
      }
    }
    await interaction.reply({ content: results.length ? results.join('\n') : '没有找到可操作的身份组。', ephemeral: true });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('giveaway_template_select:')) {
    const template = settings.giveawayTemplates[interaction.values[0]];
    if (!template) { await interaction.reply({ content: '找不到这个模板。', ephemeral: true }); return; }
    const draft = pendingGiveawayDrafts.get(interaction.customId.split(':')[1]);
    if (draft && draft.hostId === interaction.user.id) {
      Object.assign(draft, template.data);
      await interaction.update({ content: '模板已载入，请回到进阶条件面板并点击“刷新条件”。', components: [] });
    } else {
      await interaction.reply({ content: '模板已保存；请重新创建抽奖后载入模板。', ephemeral: true });
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'announce_modal:text' || interaction.customId === 'announce_modal:embed') {
      await publishAnnouncement(interaction, interaction.customId.endsWith(':embed') ? 'embed' : 'text');
      return;
    }
    if (interaction.customId === 'serverstats_modal') {
      const stats = config.serverStats;
      stats.totalName = interaction.fields.getTextInputValue('total_name').trim() || '👥 总人数：{count}';
      stats.humanName = interaction.fields.getTextInputValue('human_name').trim() || '👤 真人：{count}';
      stats.onlineName = interaction.fields.getTextInputValue('online_name').trim() || '🟢 在线：{count}';
      stats.botName = interaction.fields.getTextInputValue('bot_name').trim() || '🤖 机器人：{count}';
      stats.enabled = true;
      await updateServerStats(interaction.guild);
      await interaction.reply({ content: '服务器统计频道已开启并更新。频道名称支持 `{count}` 和表情符号。', ephemeral: true });
      return;
    }
    if (interaction.customId === 'moderation_prefix_modal') {
      const prefix = interaction.fields.getTextInputValue('value').trim();
      if (!prefix || prefix.length > 3 || /\s/.test(prefix) || prefix.startsWith('/')) {
        await interaction.reply({ content: 'Prefix 必须是 1 至 3 个不含空格的字符，不能使用 `/`。', ephemeral: true });
        return;
      }
      config.moderationPrefix = prefix;
      saveSettings();
      await interaction.reply({ content: `Prefix 已设置为：\`${prefix}\`。例如：\`${prefix}mute @成员 10m 原因\``, ephemeral: true });
      return;
    }
    if (interaction.customId.startsWith('giveaway_repeat_modal:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      const count = Number(interaction.fields.getTextInputValue('count'));
      const intervalText = interaction.fields.getTextInputValue('interval').trim();
      const interval = intervalText ? parseDuration(intervalText) : draft?.duration;
      if (!draft || !Number.isInteger(count) || count < 0 || count > 100 || !interval) { await interaction.reply({ content: '重复设置无效：次数必须是 0 至 100，间隔需使用例如 `1d`。', ephemeral: true }); return; }
      draft.repeatCount = count;
      draft.repeatEvery = interval;
      await interaction.reply({ content: '重复抽奖设置已保存。请回到进阶面板并点击“刷新条件”。', ephemeral: true });
      return;
    }
    if (interaction.customId.startsWith('giveaway_template_modal:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      const templateId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const name = interaction.fields.getTextInputValue('name').trim();
      const { id, messageId, entries, entryWeights, entryWeightByUser, winnerIds, createdAt, endsAt, status, ...data } = draft;
      settings.giveawayTemplates[templateId] = { id: templateId, guildId: interaction.guild.id, name, prize: draft.prize, data };
      saveSettings();
      await interaction.reply({ content: `模板「${name}」已保存。`, ephemeral: true });
      return;
    }
    if (interaction.customId.startsWith('giveaway_first_entries_modal:')) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      const count = Number(interaction.fields.getTextInputValue('count'));
      if (!draft || !Number.isInteger(count) || count < 0 || count > 100) { await interaction.reply({ content: '前 N 位必须是 0 至 100 的整数。', ephemeral: true }); return; }
      draft.firstEntries = count;
      await interaction.reply({ content: '前 N 位获奖设置已保存。请回到原来的私密面板继续设置。', ephemeral: true });
      return;
    }
    if (/^giveaway_numeric_modal:/.test(interaction.customId)) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      const values = ['account_age_days', 'server_age_days', 'message_requirement', 'level_requirement'].map((id) => Number(interaction.fields.getTextInputValue(id)));
      if (!draft || values.some((value) => !Number.isInteger(value) || value < 0)) { await interaction.reply({ content: '请输入不小于 0 的整数。', ephemeral: true }); return; }
      [draft.accountAgeDays, draft.serverAgeDays, draft.messageRequirement, draft.levelRequirement] = values;
      await interaction.reply({ content: '年龄、入服时间、消息数量和等级条件已保存。请回到原来的私密面板继续设置。', ephemeral: true });
      return;
    }
    if (/^giveaway_extra_entries_modal:/.test(interaction.customId)) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      const lines = interaction.fields.getTextInputValue('entries').split('\n').map((line) => line.trim()).filter(Boolean);
      const extraEntries = [];
      for (const line of lines) {
        const [roleId, amount] = line.split('=').map((value) => value.trim());
        if (!/^\d{15,25}$/.test(roleId) || !Number.isInteger(Number(amount)) || Number(amount) < 1 || Number(amount) > 100) { await interaction.reply({ content: '格式错误。每行请填写：身份组ID=额外次数，例如 `123456789=2`。', ephemeral: true }); return; }
        extraEntries.push({ roleId, entries: Number(amount) });
      }
      if (!draft) { await interaction.reply({ content: '这个抽奖设置已过期。', ephemeral: true }); return; }
      draft.extraEntries = extraEntries;
      await interaction.reply({ content: '额外入场次数已保存。请回到原来的私密面板继续设置。', ephemeral: true });
      return;
    }
    if (/^giveaway_first_entries_modal:/.test(interaction.customId)) {
      const draftId = interaction.customId.split(':')[1];
      const draft = pendingGiveawayDrafts.get(draftId);
      const count = Number(interaction.fields.getTextInputValue('count'));
      if (!draft || !Number.isInteger(count) || count < 0 || count > 100) { await interaction.reply({ content: '前 N 位必须是 0 至 100 的整数。', ephemeral: true }); return; }
      draft.firstEntries = count;
      await interaction.reply({ content: '前 N 位获奖设置已保存。请回到原来的私密面板继续设置。', ephemeral: true });
      return;
    }
    if (interaction.customId === 'giveaway_create_modal') {
      const prize = interaction.fields.getTextInputValue('prize').trim();
      const duration = parseDuration(interaction.fields.getTextInputValue('duration'));
      const winnerCount = Number(interaction.fields.getTextInputValue('winner_count'));
      const description = interaction.fields.getTextInputValue('description').trim();
      if (!duration || duration < 10_000 || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 100) {
        await interaction.reply({ content: '抽奖设置无效：时长至少 10 秒，获奖人数必须是 1 至 100 的整数。', ephemeral: true });
        return;
      }
      const draftId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      pendingGiveawayDrafts.set(draftId, {
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        prize,
        description,
        winnerCount,
        requireServerTag: false,
        requiredRoleIds: [],
        bypassRoleIds: [],
        blacklistedRoleIds: [],
        extraEntries: [],
        winnerRoleId: '',
        winnerThread: false,
        repeatCount: 0,
        repeatEvery: 0,
        hostId: interaction.user.id,
        hostName: interaction.user.tag,
        duration,
      });
      const draft = pendingGiveawayDrafts.get(draftId);
      draft.id = draftId;
      await interaction.reply({ content: '请在同一个私密面板设置所有抽奖条件，完成后点击“发布抽奖”。', embeds: [giveawayAdvancedEmbed(draft)], components: giveawayAdvancedButtons(draft), ephemeral: true });
      return;
    }
    const value = interaction.fields.getTextInputValue('value').trim();
    if (interaction.customId === 'welcome_message_modal') config.welcomeMessage = value || '欢迎 {user} 加入 **{server}**！';
    if (interaction.customId === 'leave_message_modal') config.leaveMessage = value || '{user} 已离开 **{server}**。';
    if (interaction.customId === 'welcome_image_modal') config.welcomeImage = value;
    if (interaction.customId === 'leave_image_modal') config.leaveImage = value;
    if (interaction.customId === 'dm_message_modal') config.dmWelcomeMessage = value || '欢迎你加入 **{server}**！';
    if (interaction.customId === 'role_title_modal') config.rolePanel.title = value || '身份组领取面板';
    if (interaction.customId === 'role_description_modal') config.rolePanel.description = value || '点击下方按钮领取或取消对应身份组。';
    if (interaction.customId.startsWith('role_label_modal:')) {
      const roleId = interaction.customId.split(':')[1];
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.managed) {
        await interaction.reply({ content: '这个身份组不存在或无法由机器人管理。', ephemeral: true });
        return;
      }
      if (role.position >= interaction.guild.members.me.roles.highest.position) {
        await interaction.reply({ content: '机器人无法管理这个身份组，请把 Bot 的身份组拖到它上面。', ephemeral: true });
        return;
      }
      const existing = config.rolePanel.roles.find((item) => item.roleId === roleId);
      if (existing) existing.label = value || role.name;
      else config.rolePanel.roles.push({ roleId, label: value || role.name });
    }
    saveSettings();
    await interaction.reply({ content: '已保存设置。请回到原来的私密面板并点击“刷新面板”。', ephemeral: true });
  }
});

(async () => {
  try {
    await registerCommands();
    await client.login(token);
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
})();
