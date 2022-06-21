import { Client } from "discord.js";

(async () => {
  const BOT = new Client();

  await BOT.login(process.env.BOT_TOKEN);
})();
