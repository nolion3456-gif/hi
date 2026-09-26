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
    .setDescription('Show the available commands.'),
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
    await interaction.reply(`Pong! Latency: ${client.ws.ping}ms`);
    return;
  }

  if (interaction.commandName === 'help') {
    await interaction.reply({
      content: '**Available commands**\n`/ping` — check bot latency\n`/help` — show this help\n`/about` — show bot information',
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'about') {
    await interaction.reply('A starter Discord bot built with discord.js.');
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
