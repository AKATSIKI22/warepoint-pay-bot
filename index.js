require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
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

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------

function normalizeCard(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeAmount(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    digits = "7" + digits.slice(1);
  }
  return digits;
}

function formatAmount(val) {
  return Number(val || 0).toLocaleString("ru-RU") + " ₽";
}

function formatCard(value) {
  const digits = normalizeCard(value);
  if (digits.length >= 16) {
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  }
  return value;
}

function formatPhone(value) {
  const digits = normalizePhone(value);
  if (digits.length === 11) {
    return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }
  return value;
}

function isValidCard(value) {
  const digits = normalizeCard(value);
  return digits.length >= 15 && digits.length <= 19;
}

function isValidPhone(value) {
  const digits = normalizePhone(value);
  return digits.length === 11;
}

function buildPaymentUrl(data) {
  const params = new URLSearchParams();
  
  params.set("order", data.order || "");
  params.set("product", data.product || "");
  params.set("amount", data.amount || "");
  params.set("method", data.method || "card");
  params.set("requisite", data.requisite || "");
  params.set("bank", data.bank || "");
  params.set("recipient", data.recipient || "");

  if (data.method === "card") {
    params.set("card", data.requisite || "");
  } else {
    params.set("phone_pay", data.requisite || "");
  }

  const expires = Date.now() + 15 * 60 * 1000;
  params.set("expires", String(expires));

  const url = `${BASE_PAYMENT_URL}?${params.toString()}`;
  
  // Сохраняем заказ для статуса
  const id = data.order || Math.random().toString(36).substring(2, 8);
  orders.set(id, { ...data, id, status: "pending", createdAt: Date.now() });

  return url;
}

// ---------- БОТ ----------

bot.start((ctx) => {
  ctx.reply("Бот работает 🚀\nИспользуйте /new для создания новой ссылки на оплату");
});

bot.command("new", (ctx) => {
  sessions.set(ctx.from.id, {
    step: "order",
    data: {}
  });
  ctx.reply("Введите номер заказа:");
});

bot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const text = ctx.message.text;

  switch (session.step) {
    case "order":
      session.data.order = text;
      session.step = "product";
      ctx.reply("Введите наименование товара:");
      break;

    case "product":
      session.data.product = text;
      session.step = "amount";
      ctx.reply("Введите сумму к оплате:");
      break;

    case "amount":
      session.data.amount = normalizeAmount(text);
      if (!session.data.amount) {
        return ctx.reply("Введите сумму цифрами:");
      }
      session.step = "method";
      ctx.reply(
        "Выберите способ оплаты:",
        Markup.keyboard([["💳 По карте", "📱 По номеру телефона"]])
          .oneTime()
          .resize()
      );
      break;

    case "method":
      const choice = text.toLowerCase();
      if (choice.includes("карт")) {
        session.data.method = "card";
        session.step = "requisite";
        ctx.reply(
          "Введите номер карты (16 цифр):",
          Markup.removeKeyboard()
        );
      } else if (choice.includes("телефон") || choice.includes("номер")) {
        session.data.method = "phone";
        session.step = "requisite";
        ctx.reply(
          "Введите номер телефона получателя (в формате +7... или 8...):",
          Markup.removeKeyboard()
        );
      } else {
        return ctx.reply(
          "Пожалуйста, выберите с помощью кнопок ниже:",
          Markup.keyboard([["💳 По карте", "📱 По номеру телефона"]])
            .oneTime()
            .resize()
        );
      }
      break;

    case "requisite":
      if (session.data.method === "card") {
        if (!isValidCard(text)) {
          return ctx.reply("Введите корректный номер карты (15-19 цифр):");
        }
        session.data.requisite = formatCard(text);
      } else {
        if (!isValidPhone(text)) {
          return ctx.reply("Введите корректный номер телефона (11 цифр, начиная с 7 или 8):");
        }
        session.data.requisite = formatPhone(text);
      }
      session.step = "bank";
      ctx.reply("Введите название банка:");
      break;

    case "bank":
      session.data.bank = text;
      session.step = "recipient";
      ctx.reply("Введите ФИО получателя:");
      break;

    case "recipient":
      session.data.recipient = text;

      const url = buildPaymentUrl(session.data);
      
      const methodText = session.data.method === "card" ? "💳 По карте" : "📱 По номеру телефона";
      const reqLabel = session.data.method === "card" ? "Номер карты" : "Номер телефона";

      ctx.reply(
        `✅ Ссылка на оплату создана!\n\n` +
        `📦 Заказ: ${session.data.order}\n` +
        `🛍 Товар: ${session.data.product}\n` +
        `💰 Сумма: ${formatAmount(session.data.amount)}\n` +
        `${methodText}: ${session.data.requisite}\n` +
        `🏦 Банк: ${session.data.bank}\n` +
        `👤 Получатель: ${session.data.recipient}\n\n` +
        `🔗 Ссылка:\n${url}`
      );
      
      sessions.delete(ctx.from.id);
      break;
  }
});

// ---------- API ДЛЯ ПЛАТЁЖНОЙ СТРАНИЦЫ ----------

app.get("/status", (req, res) => {
  const orderId = req.query.order;
  const order = orders.get(orderId);

  if (!order) {
    return res.json({ ok: false });
  }

  res.json({
    ok: true,
    status: order.status,
    data: order
  });
});

app.post("/send", upload.single("file"), async (req, res) => {
  try {
    const orderId = req.body.order;
    const order = orders.get(orderId);

    if (!order) {
      return res.json({ ok: false, error: "Заказ не найден" });
    }

    const methodText = order.method === "phone" ? "📱 По номеру телефона" : "💳 По карте";
    const reqLabel = order.method === "phone" ? "Номер телефона" : "Номер карты";

    let message = `💸 *Новый чек*\n\n`;
    message += `📦 Заказ: #${order.order}\n`;
    message += `🛍 Товар: ${order.product}\n`;
    message += `💰 Сумма: ${formatAmount(order.amount)}\n`;
    message += `${methodText}: ||${order.requisite}||\n`;
    message += `🏦 Банк: ${order.bank}\n`;
    message += `👤 Получатель: ${order.recipient}\n`;

    if (req.body.customer_name) {
      message += `\n👤 Клиент: ${req.body.customer_name}\n`;
      message += `📞 Телефон: ${req.body.customer_phone}\n`;
      message += `📧 Email: ${req.body.customer_email}\n`;
    }

    if (req.body.delivery) {
      message += `\n🚚 Доставка: ${req.body.delivery}\n`;
      message += `📍 Город: ${req.body.city}\n`;
      message += `📬 Адрес: ${req.body.full_address}\n`;
    }

    if (req.body.comment) {
      message += `\n💬 Комментарий: ${req.body.comment}`;
    }

    await bot.telegram.sendMessage(TG_CHAT_ID, message, {
      parse_mode: "Markdown"
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("Send error:", e);
    return res.json({ ok: false, error: e.message });
  }
});

// ---------- ЗАПУСК ----------

app.post("/bot", bot.webhookCallback("/bot"));

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
  console.log("✅ Бот и API запущены на порту", PORT);
});
