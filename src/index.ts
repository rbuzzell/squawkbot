import * as D from "discord.js";
import { OAuth2Scopes } from "discord-api-types/v10";
import axios from "axios";
import * as sqlite from "better-sqlite3";
import Database from "better-sqlite3";
import { Command } from 'commander';
import dbg from 'debug';
import * as os from 'node:os';

import { Context, Options, MessageFilter } from './types';
import { makeCounter } from './counter';
import { makeMixedCompany } from './mixedcompany';

let debug = dbg('squawk');



export async function main(opts: Options) {
  const client = new D.Client(
    {intents: [
      D.GatewayIntentBits.Guilds,
      D.GatewayIntentBits.GuildEmojisAndStickers,
      D.GatewayIntentBits.GuildMessages,
      D.GatewayIntentBits.GuildMessageReactions,
      D.GatewayIntentBits.DirectMessages,
      D.GatewayIntentBits.MessageContent,
    ],
     // Required to receive DMs. See https://github.com/discordjs/discord.js/issues/5516
     partials: [
       D.Partials.Channel
     ]});

  let isProd = os.hostname() === "shoemaker";

  await client.login(process.env.BOT_TOKEN);
  debug("Logged in!");

  let ctx: Context = {
    discord: client,
    isProd: isProd,
    options: opts,
  };

  let filters: MessageFilter[] = [];

  client.on("ready", async cli => {
    debug("Listening...");

    let commands = await cli.application.commands.fetch();

    // TODO abstract command initialization better
    if (commands.size == 0 || ctx.options.registerCommands) {
      debug("Clearing and recreating commands...");
      await Promise.all(commands.map(async (_, command) =>
        await cli.application.commands.delete(command)));
    }

    filters = await Promise.all([
      makeCounter(ctx),
      makeMixedCompany(ctx),
    ]);

    debug("Application invite link:", cli.generateInvite({
      scopes: [ OAuth2Scopes.ApplicationsCommands ],
    }));
  });

  client.on('messageCreate', async (msg: D.Message) => {
    try {
      if ((await Promise.all(filters.map((f) => f.onMessage(msg))))
          .filter((t) => t)
          .length > 1) {
        debug(`Warning: multiple filters handled message ${msg.content}`);
      }
    } catch (e) {
      debug(`Processing of message "${msg.content}" failed:`, e);
    }
  });

  client.on('interactionCreate', async (interact: D.Interaction) => {
    try {
      if ((await Promise.all(filters.map((f) => f.onInteraction(interact))))
          .some((t) => !t)) {
      debug("Warning: interaction not handled");
    }
    } catch (e) {
      debug(`Processessing interact ${interact} failed:`, e);
    }
  });
}
