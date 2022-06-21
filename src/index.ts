import D from "discord.js";
import axios from "axios";

function getChannels(guild: D.Guild) {
  guild.channels.cache.map(chan => {
    console.log(`Channel ${chan.name}`);
  });
}

var count: number = 0;
var lastuser: string = "";

(async () => {
  const client = new D.Client({intents: [
    1 << 15, // MESSAGE_CONTENT intent, not in discord.js yet
    D.Intents.FLAGS.GUILDS,
    D.Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
    D.Intents.FLAGS.GUILD_MESSAGES,
    D.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
  ]});

  await client.login(process.env.BOT_TOKEN);
  console.log("Logged in!");

  client.on("ready", async cli => {
    console.log("Readied up!");
    client.guilds.cache.map(guild => getChannels(guild));
  });

  client.on('messageCreate', async (msg: D.Message) => {
    let channel = msg.channel;
    if (channel instanceof D.TextChannel && channel.name === "botspam") {
      let evalRes;
      try {
        evalRes = await axios.post("https://counter.robgssp.com/eval",
                                   { message: msg.content });
      } catch (error) {
        if (error.response) {
          console.log(`Bad eval: ${error.response.data}`);
          return;
        } else {
          throw error;
        }
      }

      console.log(`Good eval: ${evalRes.data.val}`);

      if (msg.author.id === lastuser) {
        await msg.react('👀');
      }
      else if (count + 1 == evalRes.data.val) {
        count += 1;
        lastuser = msg.author.id;
        await msg.react('👍');
      }
      else {
        count = 0;
        await msg.react('👎');
      }
    }
  });
})();
