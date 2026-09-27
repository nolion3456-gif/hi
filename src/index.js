require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variable.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is online.'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands.'),
  new SlashCommandBuilder()
    .setName('about')
    .setDescription('Show information about this bot.'),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
  console.log(guildId ? `Registered commands in guild ${guildId}.` : 'Registered global commands.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply(`Pong！当前延迟：${client.ws.ping}ms`);
    return;
  }

  if (interaction.commandName === 'help') {
    await interaction.reply({
      content: '**可用指令**\n`/ping` — 检查机器人延迟\n`/help` — 查看帮助\n`/about` — 查看机器人信息',
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'about') {
    await interaction.reply('这是一个使用 discord.js 构建的中文 Discord 机器人。');
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
