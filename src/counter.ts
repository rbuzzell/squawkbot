import * as D from 'discord.js';
import Database, * as sqlite from 'better-sqlite3';
import axios from 'axios';
import dbg from 'debug';

import { Context, MessageFilter } from './types';

var debug = dbg('squawk');

type CountResult = 'bump' | 'record' | 'ignore' | 'loss';

function niceness(x: number) {
  let nice = 0;
  const xs : string = x + "";
  for (let i = 0; i + 1 < xs.length; ++i) {
    if (xs[i] == '6' && xs[i+1] == '9')
      nice += 1;
  }
  return nice;
}

function nonNulls<T>(arr: (T | null)[]): T[] {
  let ret = [];
  for (const v of arr) {
    if (v != null) ret.push(v);
  }
  return ret;
}

export async function makeCounter(ctx: Context): Promise<MessageFilter> {
  class Counter implements MessageFilter {
    db: sqlite.Database = Database("test.db");
    channels!: Map<D.Snowflake, D.TextChannel>;

    setupDb(): void {
      this.db.exec(`CREATE TABLE IF NOT EXISTS count (
guild TEXT NOT NULL PRIMARY KEY,
count INTEGER NOT NULL,
lastbumped TEXT)
STRICT`);

      this.db.exec(`CREATE TABLE IF NOT EXISTS stats (
guild TEXT NOT NULL,
user TEXT NOT NULL,
bumps INTEGER NOT NULL,
loss INTEGER NOT NULL,
PRIMARY KEY (guild, user))
STRICT`);

      this.db.exec(`CREATE TABLE IF NOT EXISTS high_score (
guild TEXT NOT NULL PRIMARY KEY,
count INTEGER NOT NULL)
STRICT`);
    }

    constructor() {
      this.setupDb();
    };

    currentCount(guild: D.Guild): [number, string | null] {
      let row: any = this.db.prepare('SELECT count, lastbumped FROM count WHERE GUILD = ?')
          .get([ 'guild:' + guild.id ]);

      if (row === undefined) {
        return [ 0, null ];
      } else {
        return [ row.count, row.lastbumped ];
      }
    }

    // Returns the result of the guess, and the previous count
    // guess is a string, since it can be a ratio (1/2)
    incr(user: D.User, guild: D.Guild, guess: string): [CountResult, number] {
      return this.db.transaction((): [CountResult, number] => {
        let guildId = 'guild:' + guild.id;
        let userId = 'user:' + user.id;

        debug(`Incr for ${user} in ${guild}, guess ${guess}`);

        let [ count, lastbumped ] = this.currentCount(guild);

        let high_score = (this.db.prepare(`SELECT count FROM high_score WHERE guild = ?`)
                          .get([ guildId ]) as any)?.count || 0;

        debug(`Count was ${count}, lastbumped was ${lastbumped}`);

        if (userId === lastbumped && !ctx.options.allowRepeats) {
          debug("User ignored: same as lastbumped");
          return [ 'ignore', count ];
        }
        else if ((count + 1).toString() === guess) {
          this.db.prepare(
            "INSERT INTO count(guild, count, lastbumped) VALUES (:guild, :count, :user) " +
              "ON CONFLICT DO UPDATE SET count = :count, lastbumped = :user")
            .run({
              count: count + 1,
              user: userId,
              guild: guildId,
            });

          this.db.prepare(
            "INSERT INTO stats(guild, user, bumps, loss) VALUES (?, ?, 1, 0) " +
              "ON CONFLICT DO UPDATE SET bumps = bumps + 1")
            .run([ guildId, userId, ]);

          this.db.prepare(
            "INSERT INTO high_score(guild, count) VALUES (:guild, :count) " +
              "ON CONFLICT DO UPDATE SET count = max(count, :count)")
            .run({
              guild: guildId,
              count: count + 1,
            });

          if (count + 1 <= high_score) {
            debug("Bumped");
            return [ 'bump', count ];
          } else {
            debug("Bumped, record");
            return [ 'record', count ];
          }
        }
        else if (count === 0) {
          debug("User ignored: bad guess, count was 0");
          return [ 'ignore', count ];
        }
        else {
          this.db.prepare(
            "INSERT INTO count(guild, count, lastbumped) VALUES (:guild, 0, null) " +
              "ON CONFLICT DO UPDATE SET count = 0, lastbumped = NULL")
            .run({ guild: guildId });

          this.db.prepare(
            "INSERT INTO stats(guild, user, bumps, loss) VALUES (?, ?, 0, 1) " +
              "ON CONFLICT DO UPDATE SET loss = loss + 1")
            .run([ guildId, userId ]);
          debug("Soiled it");
          return [ 'loss', count ];
        }
      })();
    }

    async nickname(guild: D.Guild, user: D.User | string): Promise<string> {
      debug(`Fetching nickname for ${user}`);
      try {
        let nick = (await guild.members.fetch(user)).displayName;
        debug(`Fetched nickname ${nick} for ${user}`);
        return nick;
      } catch (e) {
        return "unknown";
      }
    }

    async loserboard(user: D.User, guild: D.Guild, prevCount: number): Promise<string> {
      debug("Generating loserboard...");

      let msg =
          `${await this.nickname(guild, user)} RUINED IT at ${prevCount}!

${await this.leaderboard(guild)}`

      debug("Generated loserboard");
      return msg;
    }

    async leaderboard(guild: D.Guild): Promise<string> {
      async function nickname1(c: Counter, user: string): Promise<string> {
        return await c.nickname(guild, user.match(/^user:(\d+)$/)?.[1] as string);
      }

      const [ contributors, losers, high_score ]: [ { user: string, bumps: number }[],
              { user: string, loss: string }[],
              number
            ]
            = this.db.transaction((): [ { user: string, bumps: number }[],
              { user: string, loss: string }[],
              number
            ] => {
              const contributors = this.db.prepare(`SELECT user, bumps FROM stats WHERE guild = ? ORDER BY bumps DESC LIMIT 10`)
          .all([ 'guild:' + guild.id ]) as any;

        const losers: { user: string, loss: string}[] = this.db.prepare(`SELECT user, loss FROM stats WHERE guild = ? ORDER BY loss DESC LIMIT 10`)
          .all([ 'guild:' + guild.id ]) as any;

        const high_score: number = (this.db.prepare(`SELECT count FROM high_score WHERE guild = ?`)
                      .get([ 'guild:' + guild.id ]) as any)?.count || 0;

        return [ contributors, losers, high_score ];
      })();

      let n = 0;
      let contrib1 = (await Promise.all(contributors.map(async (row) => `${++n}: ${await nickname1(this, row.user)}, with ${row.bumps} bumps`)))
          .join('\n');

      n = 0;
      let losers1 = (await Promise.all(losers.map(async (row) => `${++n}: ${await nickname1(this, row.user)}, with ${row.loss} losses`)))
          .join('\n');

      let [ count, _ ] = this.currentCount(guild);

      let msg =
          `Biggest contributers:
${contrib1}

Biggest losers:
${losers1}

The count's at ${count}. High score is ${high_score}.`;

      return msg;
    }

    async evalMessage(msg: D.Message): Promise<void> {
      const guild = msg.guild;
      if (guild === null) throw new Error("count on message without guild");

      debug(`Evaluating "${msg.content}"`);
      let evalRes;
      try {
        evalRes = await axios.post(ctx.options.evaluator + "/eval",
                                   { message: msg.content });
      } catch (error) {
        if (error instanceof axios.AxiosError) {
          debug(`Bad eval: ${error.response?.data}`);
          return;
        } else {
          throw error;
        }
      }

      debug(`Good eval: ${evalRes.data.val}`);


      let [ result, prevCount ] = await this.incr(msg.author, guild, evalRes.data.val);
      switch (result) {
      case 'bump': {
        let count = prevCount + 1;
        await msg.react('👍');
        if (niceness(count) > niceness(prevCount)) {
          await msg.react('🇳');
          await msg.react('🇮');
          await msg.react('🇨');
          await msg.react('🇪');
        }
        break;
      }
      case 'record':
        await msg.react('🤘');
        break;
      case 'ignore':
        await msg.react('👀');
        break;
      case 'loss': {
        debug("Loss!");
        await Promise.all([
          msg.react('👎'),
          (async () => await msg.reply(await this.loserboard(msg.author, guild, prevCount)))()
        ]);
        break;
      }
      default:
        // assert switch is exhaustive
        const _ : never = result;
      }
    }

    async statusMessage(message: string): Promise<void> {
      await Promise.all(Array.from(this.channels).map(async ([ id, chan ]) => {
        await chan.send(message);
      }));
    }

    async onMessage(msg: D.Message): Promise<boolean> {
      if (this.channels.has(msg.channelId) &&
          msg.author.id != ctx.discord.user?.id) {
        await this.evalMessage(msg);
        debug("Handled counting message");
        return true;
      }
      return false;
    }

    async onInteraction(interact: D.Interaction): Promise<boolean> {
      if (interact.isChatInputCommand() &&
          interact.commandName == "leaderboard" &&
          this.channels.has(interact.channelId)) {
        if (interact.guild) {
          debug("Leaderboard command in guild");
          let board_p = this.leaderboard(interact.guild);
          await interact.reply("Leaderboard coming up...");
          await interact.editReply(await board_p);
        } else if (interact.user) {
          debug("Leaderboard command in DM");
          // Assume this is a DM if there's no guild associated

          await Promise.all((await ctx.discord.guilds.fetch()).map(async guild => {
            let guild1 = await guild.fetch();
            if (await guild1.members.fetch(interact.user)) {
              await interact.reply(await this.leaderboard(guild1));
            }
          }));
        } else {
          debug("Weird command with no user or guild received");
        }
        return true;
      }
      else return false;
    }
  };

  async function activeChannels(): Promise<Map<D.Snowflake, D.TextChannel>> {
    let targetChannel = ctx.isProd ? "counting" : "botspam";
    let idPairs: ([string, D.TextChannel] | null)[] =
        (await Promise.all(
          (await ctx.discord.guilds.fetch()).map(async (guild0: D.OAuth2Guild): Promise<[ D.Snowflake, D.TextChannel ] | null> => {
            let guild = await guild0.fetch();
            let channel = (await guild.channels.fetch()).find(
              chan => chan?.name === targetChannel);

            if (channel instanceof D.TextChannel) return [ channel.id, channel ];
            else return null;
          })))
    let idPairs1: [string, D.TextChannel][] = nonNulls(idPairs);
    return new Map(idPairs1);
  }

  const c = new Counter();
  c.channels = await activeChannels();

  let commands = await ctx.discord.application?.commands?.fetch();

  if (commands?.size == 0 || ctx.options.registerCommands) {
    await ctx.discord.application?.commands?.create({
      name: "leaderboard",
      description: "Who can you count on?",
    });
  }

  if (!ctx.isProd) {
    await c.statusMessage("Squawkbot active in test mode");
  }

  return c;
}
