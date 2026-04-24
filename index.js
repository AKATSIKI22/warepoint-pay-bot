require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { Telegraf, Markup } = require("telegraf");

// ПЕРЕМЕННЫЕ
const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const BASE_PAYMENT_URL = process.env.BASE_PAYMENT_URL || "https://warepointpay.ru";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://warepoint-pay-bot.onrender.com";
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN) {
  console.error("❌ Нет BOT_TOKEN!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

const sessions = new Map();
const orders = new Map();

// ============ УСТАНАВЛИВАЕМ МЕНЮ С КНОПКАМИ ============
const MAIN_MENU = [
  ["💳 Новый платеж"],
  ["📋 Мои ссылки"],
  ["🔄 Повторить"],
  ["❌ Отмена"]
];

// Установка меню при запуске
async function setupMenu() {
  try {
    await bot.telegram.setMyCommands([
      { command: "new", description: "💳 Новый платеж" },
      { command: "links", description: "📋 Мои ссылки" },
      { command: "repeat", description: "🔄 Повторить последний" },
      { command: "cancel", description: "❌ Отмена" }
    ]);
    console.log("✅ Меню команд установлено");
  } catch (e) {
    console.error("Ошибка установки меню:", e.message);
  }
}

// ============ ФУНКЦИИ ============
function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatAmount(val) {
  return Number(val || 0).toLocaleString("ru-RU") + " ₽";
}

function formatCard(value) {
  const digits = normalizeDigits(value);
  if (digits.length >= 16) {
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  }
  return value;
}

function formatPhone(value) {
  let digits = normalizeDigits(value);
  if (digits.length === 11) {
    if (digits.startsWith("8")) digits = "7" + digits.slice(1);
    if (!digits.startsWith("7")) digits = "7" + digits;
  }
  if (digits.length === 11) {
    return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }
  return value;
}

function isValidCard(value) {
  const digits = normalizeDigits(value);
  return digits.length >= 15 && digits.length <= 19;
}

function isValidPhone(value) {
  const digits = normalizeDigits(value);
  return digits.length === 11;
}

// Хранилище последнего заказа для повтора
const lastOrders = new Map();

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
  
  // Сохраняем заказ
  const orderId = data.order || Math.random().toString(36).substring(2, 8);
  orders.set(orderId, { 
    ...data, 
    id: orderId, 
    status: "pending", 
    createdAt: Date.now() 
  });

  console.log("✅ Создан заказ:", orderId);
  return url;
}

// ============ БОТ ============

// Показываем клавиатуру с кнопками при старте
function showMainMenu(ctx) {
  return ctx.reply(
    "👇 Выберите действие:",
    Markup.keyboard(MAIN_MENU).resize()
  );
}

bot.catch((err, ctx) => {
  console.error("❌ Ошибка бота:", err.message);
  ctx.reply("Произошла ошибка. Попробуйте снова.").catch(() => {});
});

// /start
bot.start(async (ctx) => {
  console.log("🚀 /start от", ctx.from.id);
  await ctx.reply("🚀 Бот для создания платёжных ссылок");
  await showMainMenu(ctx);
});

// Команды меню
bot.command("new", async (ctx) => {
  console.log("📝 Новый платёж от", ctx.from.id);
  sessions.set(ctx.from.id, { step: "order", data: {} });
  await ctx.reply("📦 Введите номер заказа:");
});

bot.command("links", async (ctx) => {
  const userOrders = [];
  orders.forEach((order, id) => {
    if (order.userId === ctx.from.id) {
      userOrders.push(order);
    }
  });

  if (userOrders.length === 0) {
    return ctx.reply("У вас пока нет созданных ссылок.");
  }

  let msg = "📋 Ваши ссылки:\n\n";
  userOrders.slice(-5).forEach(o => {
    msg += `🔹 Заказ: ${o.order}\n`;
    msg += `   Товар: ${o.product}\n`;
    msg += `   Сумма: ${o.amount} ₽\n`;
    msg += `   Статус: ${o.status}\n\n`;
  });

  await ctx.reply(msg);
  await showMainMenu(ctx);
});

bot.command("repeat", async (ctx) => {
  const last = lastOrders.get(ctx.from.id);
  
  if (!last) {
    return ctx.reply("Нет последнего заказа для повтора.");
  }

  const url = buildPaymentUrl({ ...last, userId: ctx.from.id });
  await ctx.reply(
    `🔄 Повтор заказа:\n` +
    `📦 Заказ: ${last.order}\n` +
    `💰 Сумма: ${formatAmount(last.amount)}\n` +
    `🔗 ${url}`
  );
  await showMainMenu(ctx);
});

bot.command("cancel", async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply("❌ Текущая операция отменена.");
  await showMainMenu(ctx);
});

// Обработка кнопок (текстовых)
bot.hears("💳 Новый платеж", async (ctx) => {
  sessions.set(ctx.from.id, { step: "order", data: {} });
  await ctx.reply("📦 Введите номер заказа:");
});

bot.hears("📋 Мои ссылки", async (ctx) => {
  const userOrders = [];
  orders.forEach((order, id) => {
    if (order.userId === ctx.from.id) {
      userOrders.push(order);
    }
  });

  if (userOrders.length === 0) {
    return ctx.reply("У вас пока нет созданных ссылок.");
  }

  let msg = "📋 Ваши последние ссылки:\n\n";
  userOrders.slice(-5).reverse().forEach(o => {
    const method = o.method === "card" ? "💳" : "📱";
    msg += `${method} Заказ: ${o.order}\n`;
    msg += `   Сумма: ${o.amount} ₽\n`;
    msg += `   Статус: ${o.status}\n\n`;
  });

  await ctx.reply(msg);
});

bot.hears("🔄 Повторить", async (ctx) => {
  const last = lastOrders.get(ctx.from.id);
  
  if (!last) {
    return ctx.reply("Нет последнего заказа для повтора.");
  }

  const url = buildPaymentUrl({ ...last, userId: ctx.from.id });
  await ctx.reply(
    `🔄 Повтор заказа:\n\n` +
    `📦 Заказ: ${last.order}\n` +
    `🛍 Товар: ${last.product}\n` +
    `💰 Сумма: ${formatAmount(last.amount)}\n\n` +
    `🔗 ${url}`
  );
});

bot.hears("❌ Отмена", async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply("❌ Операция отменена.");
});

// Обработка текста (шаги создания)
bot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);
  
  // Если нет активной сессии — игнорируем
  if (!session) {
    return;
  }

  const text = ctx.message.text;
  console.log(`📨 Пользователь ${ctx.from.id}, шаг ${session.step}: "${text}"`);

  try {
    switch (session.step) {
      case "order":
        session.data.order = text;
        session.step = "product";
        await ctx.reply("🛍 Введите наименование товара:");
        break;

      case "product":
        session.data.product = text;
        session.step = "amount";
        await ctx.reply("💰 Введите сумму к оплате (только цифры):");
        break;

      case "amount":
        const amountValue = normalizeDigits(text);
        if (!amountValue) {
          return await ctx.reply("❌ Введите сумму цифрами:");
        }
        session.data.amount = amountValue;
        session.step = "method";
        await ctx.reply(
          "💳 Выберите способ оплаты:",
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
          await ctx.reply(
            "💳 Введите номер карты (15-19 цифр):",
            Markup.removeKeyboard()
          );
        } else if (choice.includes("телефон") || choice.includes("номер")) {
          session.data.method = "phone";
          session.step = "requisite";
          await ctx.reply(
            "📱 Введите номер телефона (11 цифр, начиная с 7 или 8):",
            Markup.removeKeyboard()
          );
        } else {
          return await ctx.reply(
            "⚠️ Пожалуйста, используйте кнопки:",
            Markup.keyboard([["💳 По карте", "📱 По номеру телефона"]])
              .oneTime()
              .resize()
          );
        }
        break;

      case "requisite":
        if (session.data.method === "card") {
          if (!isValidCard(text)) {
            return await ctx.reply("❌ Некорректный номер карты. Должно быть 15-19 цифр.");
          }
          session.data.requisite = formatCard(text);
        } else {
          if (!isValidPhone(text)) {
            return await ctx.reply("❌ Некорректный номер телефона. Должно быть 11 цифр.");
          }
          session.data.requisite = formatPhone(text);
        }
        session.step = "bank";
        await ctx.reply("🏦 Введите название банка:");
        break;

      case "bank":
        session.data.bank = text;
        session.step = "recipient";
        await ctx.reply("👤 Введите ФИО получателя:");
        break;

      case "recipient":
        session.data.recipient = text;
        session.data.userId = ctx.from.id;
        
        const url = buildPaymentUrl(session.data);
        
        // Сохраняем для повтора
        lastOrders.set(ctx.from.id, { ...session.data });
        
        const methodEmoji = session.data.method === "card" ? "💳" : "📱";
        const methodName = session.data.method === "card" ? "По карте" : "По номеру телефона";
        
        await ctx.reply(
          `✅ *Ссылка на оплату создана!*\n\n` +
          `📦 Заказ: \`${session.data.order}\`\n` +
          `🛍 Товар: \`${session.data.product}\`\n` +
          `💰 Сумма: *${formatAmount(session.data.amount)}*\n` +
          `${methodEmoji} Способ: ${methodName}\n` +
          `🏦 Банк: \`${session.data.bank}\`\n` +
          `👤 Получатель: \`${session.data.recipient}\`\n\n` +
          `🔗 \`${url}\``,
          { parse_mode: "Markdown" }
        );
        
        console.log("✅ Заказ создан:", session.data.order);
        sessions.delete(ctx.from.id);
        
        // Показываем главное меню
        await showMainMenu(ctx);
        break;
    }
  } catch (err) {
    console.error("❌ Ошибка в обработчике:", err);
    await ctx.reply("❌ Произошла ошибка. Начните заново.");
    sessions.delete(ctx.from.id);
    await showMainMenu(ctx);
  }
});

// ============ API ============
app.get("/status", (req, res) => {
  const orderId = req.query.order;
  const order = orders.get(orderId);

  if (!order) {
    console.log("❌ Заказ не найден:", orderId);
    return res.json({ ok: false });
  }

  console.log("📊 Статус заказа:", orderId, order.status);
  res.json({
    ok: true,
    status: order.status,
    data: order
  });
});

app.post("/send", upload.single("file"), async (req, res) => {
  try {
    const orderId = req.body.order;
    console.log("📤 Получен чек для заказа:", orderId);
    
    const order = orders.get(orderId);

    if (!order) {
      console.log("❌ Заказ не найден:", orderId);
      return res.json({ ok: false, error: "Заказ не найден" });
    }

    const methodEmoji = order.method === "phone" ? "📱" : "💳";
    const methodName = order.method === "phone" ? "По номеру телефона" : "По карте";

    let message = `💸 *Новый чек!*\n\n`;
    message += `📦 Заказ: \`#${order.order}\`\n`;
    message += `🛍 Товар: \`${order.product}\`\n`;
    message += `💰 Сумма: *${formatAmount(order.amount)}*\n`;
    message += `${methodEmoji} Способ: ${methodName}\n`;
    message += `🔢 Реквизит: \`${order.requisite}\`\n`;
    message += `🏦 Банк: \`${order.bank}\`\n`;
    message += `👤 Получатель: \`${order.recipient}\`\n`;

    if (req.body.customer_name) {
      message += `\n👤 *Клиент:*\n`;
      message += `   Имя: \`${req.body.customer_name}\`\n`;
      message += `   Телефон: \`${req.body.customer_phone}\`\n`;
      message += `   Email: \`${req.body.customer_email}\`\n`;
    }

    if (req.body.delivery) {
      message += `\n🚚 *Доставка:*\n`;
      message += `   Служба: \`${req.body.delivery}\`\n`;
      message += `   Город: \`${req.body.city}\`\n`;
      message += `   Адрес: \`${req.body.full_address}\`\n`;
    }

    if (req.body.comment) {
      message += `\n💬 *Комментарий:* \`${req.body.comment}\``;
    }

    if (TG_CHAT_ID) {
      await bot.telegram.sendMessage(TG_CHAT_ID, message, {
        parse_mode: "Markdown"
      });

      // Отправляем файл если есть
      if (req.file) {
        await bot.telegram.sendDocument(TG_CHAT_ID, {
          source: req.file.buffer,
          filename: req.file.originalname
        });
      }
    }

    console.log("✅ Чек отправлен в группу");
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ Ошибка отправки:", e);
    return res.json({ ok: false, error: e.message });
  }
});

// ============ ЗАПУСК ============
app.post("/bot", bot.webhookCallback("/bot"));

app.listen(PORT, async () => {
  await setupMenu();
  
  // Удаляем старый вебхук и ставим новый
  await bot.telegram.deleteWebhook();
  await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
  
  console.log("✅ Бот и API запущены на порту", PORT);
  console.log("🔗 Вебхук:", `${APP_BASE_URL}/bot`);
});
