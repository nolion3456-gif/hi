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

function saveSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

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
      },
      moderationLogChannelId: '',
    };
  }
  if (!settings[guildId].rolePanel) {
    settings[guildId].rolePanel = {
      title: '身份组领取面板',
      description: '点击下方按钮领取或取消对应身份组。',
      roles: [],
    };
  }
  if (!Object.prototype.hasOwnProperty.call(settings[guildId], 'moderationLogChannelId')) {
    settings[guildId].moderationLogChannelId = '';
  }
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
    .setFooter({ text: `${guild.name} · 点击按钮领取或取消身份组` });
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

function roleConfigComponents(roleConfig) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('role_title').setLabel('设置面板标题').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('role_description').setLabel('设置面板文字').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('role_add').setLabel('添加身份组').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('role_refresh').setLabel('刷新').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('role_publish').setLabel('发布到当前频道').setStyle(ButtonStyle.Success),
    ),
  ];
}

function moderationPanelEmbed(guild, config) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('管理员惩罚系统设置')
    .setDescription(`惩罚日志频道：${config.moderationLogChannelId ? `<#${config.moderationLogChannelId}>` : '未设置'}\n\n每次 mute、unmute、kick、ban、unban 操作都会记录到这个频道。`)
    .setFooter({ text: `${guild.name} · 只有拥有管理服务器权限者可以操作` });
}

function moderationPanelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('moderation_log_channel').setLabel('设置惩罚日志频道').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('moderation_refresh').setLabel('刷新').setStyle(ButtonStyle.Secondary),
  )];
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

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('检查机器人是否在线。'),
  new SlashCommandBuilder().setName('help').setDescription('查看可用指令。'),
  new SlashCommandBuilder().setName('about').setDescription('查看机器人信息。'),
  new SlashCommandBuilder().setName('welcome').setDescription('打开欢迎和离开设置面板。'),
  new SlashCommandBuilder().setName('roles').setDescription('打开身份组面板设置。'),
  new SlashCommandBuilder().setName('moderation').setDescription('打开管理员惩罚系统设置。'),
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  if (allowedGuildIds.size) console.log(`Restricted to guilds: ${[...allowedGuildIds].join(', ')}`);
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

async function logModeration(guild, config, action, target, duration, reason, executor) {
  if (!config.moderationLogChannelId) return;
  const channel = await guild.channels.fetch(config.moderationLogChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const targetId = target.id || target.user?.id;
  const targetName = target.user?.tag || target.tag || target.username || targetId;
  const embed = new EmbedBuilder()
    .setColor(action === 'unmute' || action === 'unban' ? 0x57f287 : 0xed4245)
    .setTitle('管理员惩罚记录')
    .addFields(
      { name: '实行', value: action, inline: true },
      { name: '实行对象', value: `<@${targetId}>\n${targetName}\nID：${targetId}`, inline: true },
      { name: '禁言时长', value: action === 'mute' ? duration : '不适用', inline: true },
      { name: '实行原因', value: reason || '未填写', inline: false },
      { name: '实行人员', value: `<@${executor.id}>\n${executor.tag}`, inline: true },
      { name: '实行时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
    )
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch((error) => console.error('Could not write moderation log:', error));
}

async function performModeration(interaction, action) {
  const config = getGuildSettings(interaction.guild.id);
  const reason = interaction.options.getString('reason') || '未填写';
  const user = interaction.options.getUser('member');

  if (action === 'unban') {
    const userId = interaction.options.getString('user_id').trim();
    if (!/^\d{15,25}$/.test(userId)) {
      await interaction.reply({ content: '请输入有效的 Discord 用户 ID。', ephemeral: true });
      return;
    }
    const target = await client.users.fetch(userId).catch(() => null);
    if (!target) {
      await interaction.reply({ content: '找不到这个用户。', ephemeral: true });
      return;
    }
    const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
    if (!ban) {
      await interaction.reply({ content: '这个用户目前没有被本服务器封禁。', ephemeral: true });
      return;
    }
    try {
      await interaction.guild.members.unban(userId, reason);
      await logModeration(interaction.guild, config, 'unban', target, '', reason, interaction.user);
      await interaction.reply({ content: `已解除 **${target.tag}** 的封禁。`, ephemeral: true });
    } catch (error) {
      console.error('Unban failed:', error);
      await interaction.reply({ content: '解除封禁失败，请检查 Bot 是否拥有封禁成员权限。', ephemeral: true });
    }
    return;
  }

  const member = user && await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: '找不到这个服务器成员。', ephemeral: true });
    return;
  }
  if (member.id === interaction.user.id) {
    await interaction.reply({ content: '不能对自己执行这个操作。', ephemeral: true });
    return;
  }
  if (!member.moderatable && action !== 'ban' && action !== 'kick') {
    await interaction.reply({ content: 'Bot 无法管理这个成员，请检查身份组层级和权限。', ephemeral: true });
    return;
  }
  if ((action === 'kick' || action === 'ban') && !member.kickable && action === 'kick') {
    await interaction.reply({ content: 'Bot 无法踢出这个成员，请检查身份组层级和权限。', ephemeral: true });
    return;
  }
  if (action === 'ban' && !member.bannable) {
    await interaction.reply({ content: 'Bot 无法封禁这个成员，请检查身份组层级和权限。', ephemeral: true });
    return;
  }

  try {
    let durationText = '';
    if (action === 'mute') {
      const duration = parseDuration(interaction.options.getString('duration'));
      if (!duration) {
        await interaction.reply({ content: '时长格式无效，请使用例如 `10m`、`2h`、`7d`，最长 28 天。', ephemeral: true });
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
    await logModeration(interaction.guild, config, action, member, durationText, reason, interaction.user);
    await interaction.reply({ content: `已对 **${user.tag}** 执行 \/${action}${action === 'mute' ? `（${durationText}）` : ''}。`, ephemeral: true });
  } catch (error) {
    console.error(`${action} failed:`, error);
    await interaction.reply({ content: `执行 /${action} 失败，请检查 Bot 权限、身份组层级和目标成员状态。`, ephemeral: true }).catch(() => {});
  }
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
      await interaction.reply({ content: '**可用指令**\n`/ping` — 检查机器人延迟\n`/help` — 查看帮助\n`/about` — 查看机器人信息\n`/welcome` — 打开欢迎离开设置面板\n`/roles` — 打开身份组面板设置\n`/moderation` — 设置惩罚日志频道\n`/mute` `/unmute` `/kick` `/ban` `/unban` — 管理成员', ephemeral: true });
    } else if (interaction.commandName === 'about') {
      await interaction.reply('这是一个使用 discord.js 构建的中文 Discord 机器人。');
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
    } else if (['mute', 'unmute', 'kick', 'ban', 'unban'].includes(interaction.commandName)) {
      if (!(await canManage(interaction))) {
        await interaction.reply({ content: '只有拥有“管理服务器”权限，且服务器有机器人拥有者或在允许服务器列表中的成员可以使用。', ephemeral: true });
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

  if (!(await canManage(interaction))) {
    await interaction.reply({ content: '只有授权用户可以操作这个设置面板。', ephemeral: true }).catch(() => {});
    return;
  }

  const config = getGuildSettings(interaction.guild.id);

  if (interaction.isButton()) {
    if (interaction.customId === 'moderation_log_channel') {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('moderation_log_channel_select')
        .setPlaceholder('选择惩罚日志频道')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      await interaction.reply({ content: '请选择查看 mute、unmute、kick、ban、unban 记录的频道：', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
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
    } else if (interaction.customId === 'role_refresh') {
      await interaction.update({ embeds: [rolePanelEmbed(interaction.guild, config.rolePanel)], components: roleConfigComponents(config.rolePanel) });
    } else if (interaction.customId === 'role_publish') {
      const message = await interaction.channel.send({ embeds: [rolePanelEmbed(interaction.guild, config.rolePanel)], components: rolePanelButtons(config.rolePanel) });
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

  if (interaction.isModalSubmit()) {
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
