# Discord Starter Bot

A small Discord bot built with Node.js and `discord.js`.

## Included commands

- `/ping` — check whether the bot is online and view WebSocket latency
- `/help` — show the available commands
- `/about` — show information about the bot

## Local setup

1. Install Node.js 18.17 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Fill in `DISCORD_TOKEN` and `CLIENT_ID`.
5. Optionally set `GUILD_ID` for instant command registration in one test server.
6. Run `npm start`.

Never commit `.env` or share your Discord token. If a token is exposed, regenerate it immediately in the Discord Developer Portal.

## Hosting

The host should run `npm start` and define the same environment variables in its environment-variable/secret settings.
