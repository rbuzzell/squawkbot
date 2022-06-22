import * as D from "discord.js";
import axios from "axios";
import * as sqlite3 from "sqlite3";
import * as sqlite from "sqlite";
import { Mutex } from "async-mutex";

var debug = require('debug')('squawk');

async function setupDb(ctx: Context) {
  await ctx.db.exec(`CREATE TABLE IF NOT EXISTS count (
guild TEXT NOT NULL PRIMARY KEY,
count INTEGER NOT NULL,
lastbumped TEXT)
STRICT`);

  await ctx.db.exec(`CREATE TABLE IF NOT EXISTS stats (
guild TEXT NOT NULL,
user TEXT NOT NULL,
bumps INTEGER NOT NULL,
loss INTEGER NOT NULL,
PRIMARY KEY (guild, user))
STRICT`);
}

type CountResult = 'bump' | 'ignore' | 'loss';

type Context = {
  db: sqlite.Database,
  dbLock: Mutex,
  discord: D.Client,
};

async function currentCount(ctx: Context, guild: D.Guild): Promise<[number, string | null]> {
  let row = await ctx.db.get(
        'SELECT count, lastbumped FROM count WHERE GUILD = ?',
    [ 'guild:' + guild.id ]);

  if (row === undefined) {
    return [ 0, null ];
  } else {
    return [ row.count, row.lastbumped ];
  }
}

// Returns the result of the guess, and the previous count
// guess is a string, since it can be a ratio (1/2)
async function incr(ctx: Context, user: D.User, guild: D.Guild, guess: string): Promise<[CountResult, number]> {
  return await ctx.dbLock.runExclusive(async () => {
    ctx.db.run("BEGIN");

    let guildId = 'guild:' + guild.id;
    let userId = 'user:' + user.id;

    let error: boolean = false;
    try {
      debug(`Incr for ${user} in ${guild}, guess ${guess}`);

      let [ count, lastbumped ] = await currentCount(ctx, guild);

      debug(`Count was ${count}, lastbumped was ${lastbumped}`);

      if (userId === lastbumped) {
        debug("User ignored: same as lastbumped");
        return [ 'ignore', count ];
      }
      else if ((count + 1).toString() === guess) {
        await ctx.db.run(`INSERT INTO count(guild, count, lastbumped) VALUES (:guild, :count, :user)
                            ON CONFLICT DO UPDATE SET count = :count, lastbumped = :user`,
                         {
                              ':count': count + 1,
                              ':user': userId,
                              ':guild': guildId,
                         });
        await ctx.db.run(`INSERT INTO stats(guild, user, bumps, loss) VALUES (?, ?, 1, 0)
                            ON CONFLICT DO UPDATE SET bumps = bumps + 1`,
                         [ guildId, userId, ]);
        debug("Bumped");
        return [ 'bump', count ];
      }
      else if (count === 0) {
        debug("User ignored: bad guess, count was 0");
        return [ 'ignore', count ];
      }
      else {
        await ctx.db.run(`INSERT INTO count(guild, count, lastbumped) VALUES (:guild, 0, null)
                            ON CONFLICT DO UPDATE SET count = 0, lastbumped = NULL`,
                         { ':guild': guildId });
        await ctx.db.run(`INSERT INTO stats(guild, user, bumps, loss) VALUES (?, ?, 0, 1)
                            ON CONFLICT DO UPDATE SET loss = loss + 1`,
                   [ guildId, userId ]);
        debug("Soiled it");
        return [ 'loss', count ];
      }
    }
    catch (e) {
      error = true;
      throw e;
    }
    finally {
      if (error) {
        ctx.db.run("ROLLBACK");
      } else {
        ctx.db.run("COMMIT");
      }
    }
  });
}

async function loserboard(ctx: Context, user: D.User, guild: D.Guild, prevCount: number): Promise<string> {
  async function nickname(user: D.User | string): Promise<string> {
    return (await guild.members.fetch(user)).nickname;
  }

  let msg =
`${await nickname(user)} RUINED IT at ${prevCount}!

${await leaderboard(ctx, guild)}`

  return msg;
}

async function leaderboard(ctx: Context, guild: D.Guild): Promise<string> {
  async function nickname(user: D.User | string): Promise<string> {
    return (await guild.members.fetch(user)).nickname;
  }
  async function nickname1(user: string): Promise<string> {
    return await nickname(user.match(/^user:(\d+)$/)[1]);
  }

  let n = 0;
  let contributors = (await Promise.all(
    (await ctx.db.all(`SELECT user, bumps FROM stats WHERE guild = ? ORDER BY bumps DESC LIMIT 10`,
                      [ 'guild:' + guild.id ]))
      .map(async (row) => `${++n}: ${await nickname1(row.user)}, with ${row.bumps} bumps`)))
                       .join('\n');

  n = 0;
  let losers = (await Promise.all(
    (await ctx.db.all(`SELECT user, loss FROM stats WHERE guild = ? ORDER BY loss DESC LIMIT 10`,
                      [ 'guild:' + guild.id ]))
      .map(async (row) => `${++n}: ${await nickname1(row.user)}, with ${row.loss} losses`)))
                 .join('\n');

let msg =
`Biggest contributers:
${contributors}

Biggest losers:
${losers}`;

  return msg;
}

async function evalMessage(ctx: Context, msg: D.Message): Promise<void> {
  let evalRes;
  try {
    debug(`Sending eval query for "${msg.content}"...`);
    evalRes = await axios.post("https://counter.robgssp.com/eval",
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
    case 'loss':
      await msg.react('👎');
      msg.channel.send(await loserboard(ctx, msg.author, msg.guild, prevCount));
      break;
  }
}

(async () => {
  const client = new D.Client({intents: [
    1 << 15, // MESSAGE_CONTENT intent, not in discord.js yet
    D.Intents.FLAGS.GUILDS,
    D.Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
    D.Intents.FLAGS.GUILD_MESSAGES,
    D.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
  ]});

  let db = await sqlite.open({
    filename: "test.db",
    driver: sqlite3.Database,
  });

  var ctx: Context = {
    db: db,
    dbLock: new Mutex(),
    discord: client,
  };

  await setupDb(ctx);

  await client.login(process.env.BOT_TOKEN);
  debug("Logged in!");

  client.on("ready", async cli => {
    debug("Listening...");
  });

  client.on('messageCreate', async (msg: D.Message) => {
    try {
      let channel = msg.channel;
      if (channel instanceof D.TextChannel && channel.name === "botspam") {
        if (msg.content == 's!leaderboard') {
          msg.channel.send(await leaderboard(ctx, msg.guild));
        } else {
          await evalMessage(ctx, msg);
        }
      }
    } catch (e) {
      debug(`Processing of message "${msg.content}" failed:`, e);
    }
  });
})();
