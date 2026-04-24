require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const BASE_PAYMENT_URL = process.env.BASE_PAYMENT_URL || "https://warepointpay.ru";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://warepoint-pay-bot.onrender.com";
const PORT = Number(process.env.PORT || 3000);

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

const sessions = new Map();
const orders = new Map();

function normalizeCard(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeAmount(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function getDateTime() {
  const now = new Date();
  return new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Moscow" })
  ).toLocaleString("ru-RU");
}

function formatAmount(val) {
  return Number(val || 0).toLocaleString("ru-RU") + " ₽";
}

function buildPaymentUrl(data) {
  const id = Math.random().toString(36).substring(2, 8);

  orders.set(id, {
    ...data,
    id,
    status: "pending",
    createdAt: Date.now()
  });

  return `${BASE_PAYMENT_URL}?id=${id}`;
}

bot.start((ctx) => {
  ctx.reply("Бот работает 🚀");
});

bot.command("new", (ctx) => {
  sessions.set(ctx.from.id, { step: 0, data: {} });
  ctx.reply("Введите номер заказа");
});

bot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const text = ctx.message.text;

  const steps = ["order", "product", "amount", "card", "bank", "recipient"];

  const key = steps[session.step];
  let value = text;

  if (key === "amount") {
    value = normalizeAmount(value);
  }

  if (key === "card") {
    const digits = normalizeCard(value);

    if (digits.length < 6) {
      return ctx.reply("Введите карту или телефон");
    }

    value = digits;
  }

  session.data[key] = value;
  session.step++;

  if (session.step >= steps.length) {
    const url = buildPaymentUrl(session.data);

    ctx.reply(`Ссылка создана:\n${url}`);
    sessions.delete(ctx.from.id);
    return;
  }

  const next = [
    "Введите номер заказа",
    "Введите товар",
    "Введите сумму",
    "Введите карту или телефон",
    "Введите банк",
    "Введите получателя"
  ];

  ctx.reply(next[session.step]);
});

app.get("/order", (req, res) => {
  const id = req.query.id;
  const order = orders.get(id);

  if (!order) {
    return res.json({ ok: false });
  }

  res.json({ ok: true, data: order });
});

app.post("/send", upload.single("file"), async (req, res) => {
  try {
    const { id } = req.body;
    const order = orders.get(id);

    if (!order) return res.json({ ok: false });

    await bot.telegram.sendMessage(
      TG_CHAT_ID,
      `💸 Новый чек\n\nЗаказ: ${order.order}\nСумма: ${formatAmount(order.amount)}`
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false });
  }
});

app.post("/bot", bot.webhookCallback("/bot"));

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
  console.log("Запущено");
});
