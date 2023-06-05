import * as D from "discord.js";
import { OAuth2Scopes } from "discord-api-types/v10";
import axios from "axios";
import * as sqlite from "better-sqlite3";
import Database from "better-sqlite3";
import { Mutex } from "async-mutex";
import { Command } from 'commander';

var debug = require('debug')('squawk');
var os = require("os");

const program = new Command();

program
  .name('squawkbot')
  .description('Discord counting bot')
  .version('0.6.9')
  .option('--evaluator <url>', 'eval endpoint', 'https://counter.robgssp.com')
  .option('--allow-repeats', 'allow multiple guesses in a row')
  .option('--register-commands', 'register bot commands')
  .parse();

type Options = {
  evaluator: string,
  allowRepeats: boolean,
  registerCommands: boolean,
}

function setupDb(ctx: Context): void {
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS count (
guild TEXT NOT NULL PRIMARY KEY,
count INTEGER NOT NULL,
lastbumped TEXT)
STRICT`);

  ctx.db.exec(`CREATE TABLE IF NOT EXISTS stats (
guild TEXT NOT NULL,
user TEXT NOT NULL,
bumps INTEGER NOT NULL,
loss INTEGER NOT NULL,
PRIMARY KEY (guild, user))
STRICT`);

  ctx.db.exec(`CREATE TABLE IF NOT EXISTS high_score (
guild TEXT NOT NULL PRIMARY KEY,
count INTEGER NOT NULL)
STRICT`);
}


type CountResult = 'bump' | 'ignore' | 'loss';

type Context = {
  db: sqlite.Database,
  discord: D.Client,
  isProd: boolean,
  channels: Set<D.TextChannel>,
  options: Options,
};

function currentCount(ctx: Context, guild: D.Guild): [number, string | null] {
  let row = ctx.db.prepare('SELECT count, lastbumped FROM count WHERE GUILD = ?')
    .get([ 'guild:' + guild.id ]);

  if (row === undefined) {
    return [ 0, null ];
  } else {
    return [ row.count, row.lastbumped ];
  }
}

// Returns the result of the guess, and the previous count
// guess is a string, since it can be a ratio (1/2)
function incr(ctx: Context, user: D.User, guild: D.Guild, guess: string): [CountResult, number] {
  return ctx.db.transaction((): [CountResult, number] => {
    let guildId = 'guild:' + guild.id;
    let userId = 'user:' + user.id;

    debug(`Incr for ${user} in ${guild}, guess ${guess}`);

    let [ count, lastbumped ] = currentCount(ctx, guild);

    debug(`Count was ${count}, lastbumped was ${lastbumped}`);

    if (userId === lastbumped && !ctx.options.allowRepeats) {
      debug("User ignored: same as lastbumped");
      return [ 'ignore', count ];
    }
    else if ((count + 1).toString() === guess) {
      ctx.db.prepare(
        "INSERT INTO count(guild, count, lastbumped) VALUES (:guild, :count, :user) " +
          "ON CONFLICT DO UPDATE SET count = :count, lastbumped = :user")
        .run({
          count: count + 1,
          user: userId,
          guild: guildId,
        });

      ctx.db.prepare(
        "INSERT INTO stats(guild, user, bumps, loss) VALUES (?, ?, 1, 0) " +
          "ON CONFLICT DO UPDATE SET bumps = bumps + 1")
        .run([ guildId, userId, ]);

      ctx.db.prepare(
        "INSERT INTO high_score(guild, count) VALUES (:guild, :count) " +
          "ON CONFLICT DO UPDATE SET count = max(count, :count)")
        .run({
          guild: guildId,
          count: count + 1,
        });

      debug("Bumped");
      return [ 'bump', count ];
    }
    else if (count === 0) {
      debug("User ignored: bad guess, count was 0");
      return [ 'ignore', count ];
    }
    else {
      ctx.db.prepare(
        "INSERT INTO count(guild, count, lastbumped) VALUES (:guild, 0, null) " +
          "ON CONFLICT DO UPDATE SET count = 0, lastbumped = NULL")
        .run({ guild: guildId });

      ctx.db.prepare(
        "INSERT INTO stats(guild, user, bumps, loss) VALUES (?, ?, 0, 1)" +
          "ON CONFLICT DO UPDATE SET loss = loss + 1")
        .run([ guildId, userId ]);
      debug("Soiled it");
      return [ 'loss', count ];
    }
  })();
}

async function nickname(guild: D.Guild, user: D.User | string): Promise<string> {
  debug(`Fetching nickname for ${user}`);
  try {
    let nick = (await guild.members.fetch(user)).displayName;
    debug(`Fetched nickname ${nick} for ${user}`);
    return nick;
  } catch (e) {
    return "unknown";
  }
}

async function loserboard(ctx: Context, user: D.User, guild: D.Guild, prevCount: number): Promise<string> {
  debug("Generating loserboard...");

  let msg =
`${await nickname(guild, user)} RUINED IT at ${prevCount}!

${await leaderboard(ctx, guild)}`

  debug("Generated loserboard");
  return msg;
}

async function leaderboard(ctx: Context, guild: D.Guild): Promise<string> {
  async function nickname1(user: string): Promise<string> {
    return await nickname(guild, user.match(/^user:(\d+)$/)[1]);
  }

  let contributors;
  let losers;
  let high_score;

  ctx.db.transaction(() => {
    contributors = ctx.db.prepare(`SELECT user, bumps FROM stats WHERE guild = ? ORDER BY bumps DESC LIMIT 10`)
      .all([ 'guild:' + guild.id ]);

    losers = ctx.db.prepare(`SELECT user, loss FROM stats WHERE guild = ? ORDER BY loss DESC LIMIT 10`)
      .all([ 'guild:' + guild.id ]);

    high_score = ctx.db.prepare(`SELECT count FROM high_score WHERE guild = ?`)
      .get([ 'guild:' + guild.id ])?.count || 0;
  })();

  let n = 0;
  let contrib1 = (await Promise.all(contributors.map(async (row) => `${++n}: ${await nickname1(row.user)}, with ${row.bumps} bumps`)))
      .join('\n');

  n = 0;
  let losers1 = (await Promise.all(losers.map(async (row) => `${++n}: ${await nickname1(row.user)}, with ${row.loss} losses`)))
      .join('\n');

  let [ count, _ ] = currentCount(ctx, guild);

let msg =
`Biggest contributers:
${contrib1}

Biggest losers:
${losers1}

The count's at ${count}. High score is ${high_score}.`;

  return msg;
}

async function evalMessage(ctx: Context, msg: D.Message): Promise<void> {
  debug(`Evaluating "${msg.content}"`);
  let evalRes;
  try {
    evalRes = await axios.post(ctx.options.evaluator + "/eval",
                               { message: msg.content });
  } catch (error) {
    if (error.response) {
      debug(`Bad eval: ${error.response.data}`);
      return;
    } else {
      throw error;
    }
  }

  debug(`Good eval: ${evalRes.data.val}`);

  let [ result, prevCount ] = await incr(ctx, msg.author, msg.guild, evalRes.data.val);
  switch (result) {
  case 'bump':
    await msg.react('👍');
    break;
  case 'ignore':
    await msg.react('👀');
    break;
  case 'loss': {
    debug("Loss!");
    await Promise.all([
      msg.react('👎'),
      (async () => await msg.reply(await loserboard(ctx, msg.author, msg.guild, prevCount)))()
    ]);
    break;
  }
  }
}

async function statusMessage(ctx: Context, message: string): Promise<void> {
  await Promise.all(Array.from(ctx.channels).map(async chan => {
    await chan.send(message);
  }));
}

async function activeChannels(discord: D.Client, isProd: boolean): Promise<Set<D.TextChannel>> {
  let targetChannel = isProd ? "counting" : "botspam";
  return new Set((await Promise.all(
    (await discord.guilds.fetch()).map(async (guild0: D.OAuth2Guild) => {
      let guild = await guild0.fetch();
      let channel = (await guild.channels.fetch()).find(
        chan => chan.name === targetChannel);

      if (channel instanceof D.TextChannel) return channel;
    }))).filter(v => v));
}

(async () => {
  const client = new D.Client(
    {intents: [
      1 << 15, // MESSAGE_CONTENT intent, not in discord.js yet
      D.Intents.FLAGS.GUILDS,
      D.Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
      D.Intents.FLAGS.GUILD_MESSAGES,
      D.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
      D.Intents.FLAGS.DIRECT_MESSAGES,
    ],
     // Required to receive DMs. See https://github.com/discordjs/discord.js/issues/5516
     partials: [
       'CHANNEL',
     ]});

  let db = Database("test.db");

  let isProd = os.hostname() === "shoemaker";

  await client.login(process.env.BOT_TOKEN);
  debug("Logged in!");

  var ctx: Context = {
    db: db,
    discord: client,
    isProd: isProd,
    channels: await activeChannels(client, isProd),
    options: program.opts(),
  };

  setupDb(ctx);

  client.on("ready", async cli => {
    debug("Listening...");

    let commands = await cli.application.commands.fetch();

    if (commands.size == 0 || ctx.options.registerCommands) {
      debug("Clearing and recreating commands...");
      await Promise.all(commands.map(async (_, command) =>
        await cli.application.commands.delete(command)));

      await cli.application.commands.create({
        name: "leaderboard",
        description: "Who can you count on?",
      });
      debug("Commands created");
    }

    debug("Application invite link:", cli.generateInvite({
      scopes: [ OAuth2Scopes.ApplicationsCommands ],
    }));
  });

  client.on('messageCreate', async (msg: D.Message) => {
    try {
      let channel = msg.channel;
      if (channel.partial) await channel.fetch();

      if (channel instanceof D.TextChannel && ctx.channels.has(channel) &&
          msg.author.id != client.user.id) {
        await evalMessage(ctx, msg);
        debug("Response complete");
      }
    } catch (e) {
      debug(`Processing of message "${msg.content}" failed:`, e);
    }
  });

  client.on('interactionCreate', async (interact: D.Interaction) => {
    if (interact.isCommand() && interact.command.name == "leaderboard") {
      try {
        if (interact.guild) {
          debug("Leaderboard command in guild");
          let board_p = leaderboard(ctx, interact.guild);
          await interact.reply("Leaderboard coming up...");
          await interact.editReply(await board_p);
        } else if (interact.user) {
          debug("Leaderboard command in DM");
          // Assume this is a DM if there's no guild associated

          await Promise.all((await client.guilds.fetch()).map(async guild => {
            let guild1 = await guild.fetch();
            if (await guild1.members.fetch(interact.user)) {
              await interact.reply(await leaderboard(ctx, guild1));
            }
          }));
        } else {
          debug("Weird command with no user or guild received");
        }
        debug("Interact complete");
      } catch (e) {
        debug(`Processing of interact failed:`, e);
      }
    } else {
      debug("Unknown interaction");
    }
  });

  if (isProd) {
    await statusMessage(ctx, "Squawkbot active for real");
  } else {
    await statusMessage(ctx, "Squawkbot active in test mode");
  }
})();
