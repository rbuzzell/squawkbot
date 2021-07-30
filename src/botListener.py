#!/usr/bin/env python3

import discord
from environs import Env

env = Env()
env.read_env()


class MyClient(discord.Client):
    async def on_ready(self):
        print("Logged on as {0}!".format(self.user))

    async def on_message(self, message):
        print("Message from {0.author}: {0.content}".format(message))


client = MyClient()
client.run(env.str("BOT_KEY"))
