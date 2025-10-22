import * as D from "discord.js";
import * as sqlite from "better-sqlite3";

export type Options = {
  evaluator: string,
  allowRepeats: boolean,
  registerCommands: boolean,
  test: boolean,
}

export type Context = {
  discord: D.Client,
  isProd: boolean,
  options: Options,
};

export interface MessageFilter {
  onMessage(msg: D.Message): Promise<boolean>;
  onInteraction(interact: D.Interaction): Promise<boolean>;
}
