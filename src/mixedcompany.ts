import * as D from 'discord.js';
import Database, * as sqlite from 'better-sqlite3';
import axios from 'axios';
import dbg from 'debug';

import { Context, MessageFilter } from './types';

var debug = dbg('squawk');

function nonNulls<T>(arr: (T | null)[]): T[] {
  let ret = [];
  for (const v of arr) {
    if (v != null) ret.push(v);
  }
  return ret;
}

function numberSuffix(n: number) {
  if (n % 10 === 1)
    return `${n}st`;
  else if (n % 10 === 2)
    return `${n}nd`;
  else if (n % 10 === 3)
    return `${n}rd`;
  else return `${n}th`;
}

function plural(n: number) {
  return n == 1 ? "" : "s";
}

export async function makeMixedCompany(ctx: Context): Promise<MessageFilter> {
  class MixedCompany implements MessageFilter {
    db: sqlite.Database = Database("mixed.db");

    // a mapping from guild snowflakes to channels
    channels!: Map<D.Snowflake, D.TextChannel>;

    setupDb(): void {
      this.db.exec(`CREATE TABLE IF NOT EXISTS score (
guild TEXT NOT NULL,
user TEXT NOT NULL,
score INTEGER NOT NULL,
PRIMARY KEY (guild, user)
)
STRICT`);
    }

    constructor() {
      this.setupDb();
    };

    async onMessage(msg: D.Message): Promise<boolean> {
      debug(`Evaluating mixedness for message ${msg.content}...`);
      if (msg.content.match(/mixed company/i)) {
        const user = "user:" + msg.author.id;
        const guild = "guild:" + msg.guild?.id ?? "";

        // we want to know:
        //   the player's current score
        //   the player's current ranking
        //   whether the player is tied
        //   whether the player just moved up in ranking
        //
        const [ score, place, moved, tied ] = this.db.transaction((): [ number, number, boolean, boolean ] => {
          const oldScore = (this.db.prepare("SELECT score FROM score WHERE user = :user AND guild = :guild")
                            .get({ user: user, guild: guild }) as any)
                .score as number;

          const oldPlace: any = oldScore
                ? (this.db.prepare(
                  "SELECT COUNT(*) FROM score WHERE score > :score")
                   .get({score: oldScore}) as any)["COUNT(*)"] as number
                : -Infinity;

          this.db.prepare(
            "INSERT INTO score(guild, user, score) VALUES (:guild, :user, 1) " +
              "ON CONFLICT DO UPDATE SET score = score + 1;")
            .run({
              guild: guild,
              user: user,
            });

          const score = (this.db.prepare(
            "SELECT score FROM score WHERE user = :user AND guild = :guild")
                         .get({ user: user, guild: guild }) as any)
                .score as number;

          debug("Current score:", score);

          const place = (this.db.prepare(
            "SELECT COUNT(*) FROM score WHERE score > :score")
                         .get({score: score}) as any)
          ["COUNT(*)"] as number;

          const tied = (this.db.prepare(
            "SELECT COUNT(*) FROM score WHERE score = :score")
                        .get({score: score}) as any)
          ["COUNT(*)"] as number;

          debug("oldPlace:", oldPlace, "place:", place);

          return [ score, place + 1, oldPlace !== place, tied === 0 ];
        })();

        const nickname = (await msg.guild?.members?.fetch(msg.author))
              ?.displayName;

        const placeString = place == 1
              ? "the lead"
              : `${numberSuffix(place)} place`;

        let message: string;

        if (moved) {
          message = `${nickname} took ${placeString} with ${score} point${plural(score)}`;
        } else if (tied) {
          message = `${nickname} is tied for ${placeString} with ${score} point${plural(score)}`
        } else {
          message = `${nickname} is in ${placeString} with ${score} point${plural(score)}`;
        }

        await this.channels.get(guild)?.send(message);
        return true;
      } else {
        return false;
      }
    }

    async onInteraction(_: D.Interaction): Promise<boolean> {
      return false;
    }
  }

  const r = new MixedCompany();

  // const targetChannel = ctx.isProd ? "leaderboard" : "botspam";
  const targetChannel = "botspam";

  r.channels = new Map(nonNulls(await Promise.all(
    ((await ctx.discord.guilds.fetch()).map(async (guild0: D.OAuth2Guild): Promise<[D.Snowflake, D.TextChannel ] | null> => {
      const guild = await guild0.fetch();
      const channel = (await guild.channels.fetch()).find(
        chan => chan?.name === targetChannel);

      if (channel instanceof D.TextChannel) return [ "guild:" + guild.id, channel ];
      else return null;
    })))));

  return r;
};
