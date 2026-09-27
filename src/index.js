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
    };
  }
  if (!settings[guildId].rolePanel) {
    settings[guildId].rolePanel = {
      title: '身份组领取面板',
      description: '点击下方按钮领取或取消对应身份组。',
      roles: [],
    };
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild || !(await isGuildUsable(interaction.guild))) {
    await interaction.reply({ content: '这个服务器没有启用此机器人。', ephemeral: true }).catch(() => {});
    return;
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'ping') {
      await interaction.reply(`Pong！当前延迟：${client.ws.ping}ms`);
    } else if (interaction.commandName === 'help') {
      await interaction.reply({ content: '**可用指令**\n`/ping` — 检查机器人延迟\n`/help` — 查看帮助\n`/about` — 查看机器人信息\n`/welcome` — 打开欢迎离开设置面板\n`/roles` — 打开身份组面板设置', ephemeral: true });
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
    if (interaction.customId === 'role_title') {
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
