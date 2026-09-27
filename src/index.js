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
  REST,
  Routes,
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
    };
  }
  return settings[guildId];
}

function isGuildAllowed(guildId) {
  return allowedGuildIds.size === 0 || allowedGuildIds.has(guildId);
}

function isConfigurator(interaction) {
  return Boolean(
    interaction.guild &&
    ((ownerId && interaction.user.id === ownerId) || interaction.guild.ownerId === interaction.user.id),
  );
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
  new SlashCommandBuilder().setName('ping').setDescription('Check whether the bot is online.'),
  new SlashCommandBuilder().setName('help').setDescription('Show available commands.'),
  new SlashCommandBuilder().setName('about').setDescription('Show information about this bot.'),
  new SlashCommandBuilder().setName('welcome').setDescription('Open the welcome and leave settings panel.'),
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
  if (!isGuildAllowed(guild.id)) {
    console.log(`Leaving unauthorized guild ${guild.id}.`);
    await guild.leave().catch((error) => console.error('Could not leave guild:', error));
  }
});

async function sendWelcome(member) {
  if (!isGuildAllowed(member.guild.id) || member.user.bot) return;
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
  if (!isGuildAllowed(member.guild.id) || member.user.bot) return;
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
  if (!interaction.guild || !isGuildAllowed(interaction.guild.id)) {
    await interaction.reply({ content: '这个服务器没有启用此机器人。', ephemeral: true }).catch(() => {});
    return;
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'ping') {
      await interaction.reply(`Pong！当前延迟：${client.ws.ping}ms`);
    } else if (interaction.commandName === 'help') {
      await interaction.reply({ content: '**可用指令**\n`/ping` — 检查机器人延迟\n`/help` — 查看帮助\n`/about` — 查看机器人信息\n`/welcome` — 打开欢迎离开设置面板', ephemeral: true });
    } else if (interaction.commandName === 'about') {
      await interaction.reply('这是一个使用 discord.js 构建的中文 Discord 机器人。');
    } else if (interaction.commandName === 'welcome') {
      if (!isConfigurator(interaction)) {
        await interaction.reply({ content: '只有机器人拥有者或服务器拥有者可以打开此设置面板。', ephemeral: true });
        return;
      }
      const config = getGuildSettings(interaction.guild.id);
      await interaction.reply({ embeds: [panelEmbed(interaction.guild, config)], components: panelComponents(config), ephemeral: true });
    }
    return;
  }

  if (!isConfigurator(interaction)) {
    await interaction.reply({ content: '只有授权用户可以操作这个设置面板。', ephemeral: true }).catch(() => {});
    return;
  }

  const config = getGuildSettings(interaction.guild.id);

  if (interaction.isButton()) {
    if (interaction.customId === 'welcome_channel' || interaction.customId === 'leave_channel') {
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

  if (interaction.isModalSubmit()) {
    const value = interaction.fields.getTextInputValue('value').trim();
    if (interaction.customId === 'welcome_message_modal') config.welcomeMessage = value || '欢迎 {user} 加入 **{server}**！';
    if (interaction.customId === 'leave_message_modal') config.leaveMessage = value || '{user} 已离开 **{server}**。';
    if (interaction.customId === 'welcome_image_modal') config.welcomeImage = value;
    if (interaction.customId === 'leave_image_modal') config.leaveImage = value;
    if (interaction.customId === 'dm_message_modal') config.dmWelcomeMessage = value || '欢迎你加入 **{server}**！';
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
