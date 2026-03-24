require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

const BASE_PAYMENT_URL = process.env.BASE_PAYMENT_URL || "https://warepointpay.ru";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

const PORT = process.env.PORT || 3000;
const app = express();

// --- загрузка файлов ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// --- главная (чтобы Render не засыпал) ---
app.get("/", (req, res) => {
  res.send("Bot is running");
});

// --- прием чеков ---
app.post("/send", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Нет файла" });
    }

    const {
      order = "",
      product = "",
      amount = "",
      recipient = "",
      bank = "",
      method = "",
      card_last4 = ""
    } = req.body;

    const text = `
📥 Новая оплата

📦 Заказ: ${order}
🖥 Товар: ${product}
💰 Сумма: ${amount} ₽
👤 Получатель: ${recipient}
🏦 Банк: ${bank}
💳 Карта: **** ${card_last4}
💸 Метод: ${method}
`;

    if (req.file.mimetype.startsWith("image/")) {
      await bot.telegram.sendPhoto(
        TG_CHAT_ID,
        { source: req.file.buffer },
        { caption: text }
      );
    } else {
      await bot.telegram.sendDocument(
        TG_CHAT_ID,
        { source: req.file.buffer },
        { caption: text }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// --- бот ---
bot.start((ctx) => ctx.reply("Бот работает. Напиши /newpay"));

bot.command("newpay", (ctx) => {
  ctx.reply("Введите номер заказа");
});

bot.launch().then(() => {
  console.log("Bot started");
});

// --- сервер ---
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
