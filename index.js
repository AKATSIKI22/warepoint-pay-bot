require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

const BASE_PAYMENT_URL = process.env.BASE_PAYMENT_URL || "https://warepoint.ru/pay";

bot.start((ctx)=> ctx.reply("Бот запущен. Напиши /newpay"));

bot.command("newpay", async (ctx)=>{
  ctx.reply("Введите номер заказа");
});

bot.launch();
