require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

const BASE_PAYMENT_URL = process.env.BASE_PAYMENT_URL || "https://warepointpay.ru";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const PORT = process.env.PORT || 3000;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMime = ["application/pdf", "image/jpeg", "image/png"];
    const allowedExt = [".pdf", ".jpg", ".jpeg", ".png"];
    const name = (file.originalname || "").toLowerCase();
    const hasAllowedExt = allowedExt.some((ext) => name.endsWith(ext));

    if (allowedMime.includes(file.mimetype) || hasAllowedExt) {
      return cb(null, true);
    }

    cb(new Error("Разрешены только PDF, JPG, JPEG и PNG"));
  }
});

const sessions = new Map();
const history = new Map();

const STEPS = [
  { key: "order", label: "Введите номер заказа", example: "Например: 3452" },
  { key: "product", label: "Введите название товара", example: "Например: RTX 5070" },
  { key: "amount", label: "Введите сумму к оплате", example: "Например: 54444" },
  { key: "card", label: "Введите номер карты", example: "Например: 5555555555555555" },
  { key: "bank", label: "Введите название банка", example: "Например: Озон-Банк" },
  { key: "recipient", label: "Введите ФИО получателя", example: "Например: Ключко Андрей" },
  { key: "minutes", label: "Введите время таймера в минутах", example: "Например: 15" }
];

function isAdmin(userId) {
  if (!ADMIN_IDS.length) return true;
  return ADMIN_IDS.includes(String(userId));
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatAmount(value) {
  const num = String(value).replace(/[^\d]/g, "");
  if (!num) return value;
  return Number(num).toLocaleString("ru-RU") + " ₽";
}

function normalizeAmount(value) {
  return String(value).replace(/[^\d]/g, "");
}

function normalizeCard(value) {
  return String(value).replace(/[^\d]/g, "");
}

function normalizeMinutes(value) {
  const num = parseInt(String(value).replace(/[^\d]/g, ""), 10);
  if (!num || num < 1) return "15";
  if (num > 1440) return "1440";
  return String(num);
}

function getMainKeyboard() {
  return Markup.keyboard([
    ["💸 Новый платеж", "📄 Мои ссылки"],
    ["🔁 Повторить", "❌ Отмена"],
    ["ℹ️ Помощь"]
  ]).resize();
}

function getSession(userId) {
  return sessions.get(String(userId));
}

function setSession(userId, data) {
  sessions.set(String(userId), data);
}

function clearSession(userId) {
  sessions.delete(String(userId));
}

function saveHistory(userId, payload) {
  const key = String(userId);
  const arr = history.get(key) || [];
  arr.unshift({
    ...payload,
    createdAt: new Date().toISOString()
  });
  history.set(key, arr.slice(0, 10));
}

function getHistory(userId) {
  return history.get(String(userId)) || [];
}

function buildPaymentUrl(data) {
  const params = new URLSearchParams({
    order: data.order,
    product: data.product,
    amount: normalizeAmount(data.amount),
    card: normalizeCard(data.card),
    bank: data.bank,
    recipient: data.recipient,
    method: "Перевод на карту",
    t: String(Number(normalizeMinutes(data.minutes)) * 60)
  });

  return `${BASE_PAYMENT_URL}?${params.toString()}`;
}

function buildClientText(data, url) {
  return [
    `Здравствуйте! Ваш заказ № ${data.order} сформирован.`,
    ``,
    `Товар: ${data.product}`,
    `Сумма к оплате: ${formatAmount(data.amount)}`,
    ``,
    `Ссылка на оплату:`,
    url,
    ``,
    `После оплаты нажмите кнопку «Я оплатил» на странице и отправьте подтверждение.`
  ].join("\n");
}

function buildSummary(data, url) {
  return [
    `✅ <b>Ссылка создана</b>`,
    ``,
    `📦 <b>Заказ:</b> ${escapeHtml(data.order)}`,
    `🖥 <b>Товар:</b> ${escapeHtml(data.product)}`,
    `💰 <b>Сумма:</b> ${escapeHtml(formatAmount(data.amount))}`,
    `🏦 <b>Банк:</b> ${escapeHtml(data.bank)}`,
    `👤 <b>Получатель:</b> ${escapeHtml(data.recipient)}`,
    `⏱ <b>Таймер:</b> ${escapeHtml(normalizeMinutes(data.minutes))} мин.`,
    ``,
    `🔗 <b>Ссылка:</b>`,
    `${escapeHtml(url)}`
  ].join("\n");
}

async function askNextStep(ctx, session) {
  const step = STEPS[session.stepIndex];
  if (!step) return finishCreation(ctx, session);

  await ctx.reply(
    `${step.label}\n${step.example}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Отмена", "cancel_create")]
    ])
  );
}

async function finishCreation(ctx, session) {
  const data = session.data;
  const url = buildPaymentUrl(data);
  const clientText = buildClientText(data, url);

  saveHistory(ctx.from.id, { ...data, url });
  clearSession(ctx.from.id);

  await ctx.replyWithHTML(buildSummary(data, url), getMainKeyboard());

  await ctx.reply(
    `📋 Шаблон сообщения клиенту:\n\n${clientText}`,
    Markup.inlineKeyboard([
      [Markup.button.url("Открыть ссылку", url)],
      [Markup.button.callback("Создать еще", "newpay_again")]
    ])
  );
}

bot.use(async (ctx, next) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.message) {
      await ctx.reply("⛔️ У вас нет доступа к этому боту.");
    }
    return;
  }
  return next();
});

bot.start(async (ctx) => {
  await ctx.reply(
    [
      `Привет 👋`,
      `Я бот для создания ссылок на оплату WarePoint.`,
      ``,
      `Используй кнопки ниже.`
    ].join("\n"),
    getMainKeyboard()
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    [
      `Что умеет бот:`,
      `💸 Новый платеж — создать ссылку`,
      `📄 Мои ссылки — показать последние ссылки`,
      `🔁 Повторить — повторить последний заказ`,
      `❌ Отмена — сбросить текущее создание`
    ].join("\n"),
    getMainKeyboard()
  );
});

bot.command("cancel", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("❌ Создание ссылки отменено.", getMainKeyboard());
});

bot.command("newpay", async (ctx) => {
  setSession(ctx.from.id, {
    stepIndex: 0,
    data: {}
  });

  await ctx.reply("🚀 Начинаем создание новой ссылки.", getMainKeyboard());
  await askNextStep(ctx, getSession(ctx.from.id));
});

bot.command("mylinks", async (ctx) => {
  const items = getHistory(ctx.from.id);

  if (!items.length) {
    await ctx.reply("Пока нет созданных ссылок.", getMainKeyboard());
    return;
  }

  const text = items.map((item, index) => {
    return [
      `${index + 1}. Заказ #${item.order}`,
      `Товар: ${item.product}`,
      `Сумма: ${formatAmount(item.amount)}`,
      `Ссылка: ${item.url}`
    ].join("\n");
  }).join("\n\n");

  await ctx.reply(text, getMainKeyboard());
});

bot.command("repeat", async (ctx) => {
  const items = getHistory(ctx.from.id);

  if (!items.length) {
    await ctx.reply("Нет предыдущих заказов для повтора.", getMainKeyboard());
    return;
  }

  const last = items[0];

  setSession(ctx.from.id, {
    stepIndex: STEPS.length,
    data: {
      order: last.order,
      product: last.product,
      amount: last.amount,
      card: last.card,
      bank: last.bank,
      recipient: last.recipient,
      minutes: last.minutes
    }
  });

  await finishCreation(ctx, getSession(ctx.from.id));
});

bot.hears("💸 Новый платеж", async (ctx) => {
  setSession(ctx.from.id, {
    stepIndex: 0,
    data: {}
  });

  await ctx.reply("🚀 Начинаем создание новой ссылки.", getMainKeyboard());
  await askNextStep(ctx, getSession(ctx.from.id));
});

bot.hears("📄 Мои ссылки", async (ctx) => {
  const items = getHistory(ctx.from.id);

  if (!items.length) {
    await ctx.reply("Пока нет созданных ссылок.", getMainKeyboard());
    return;
  }

  const text = items.map((item, index) => {
    return [
      `${index + 1}. Заказ #${item.order}`,
      `Товар: ${item.product}`,
      `Сумма: ${formatAmount(item.amount)}`,
      `Ссылка: ${item.url}`
    ].join("\n");
  }).join("\n\n");

  await ctx.reply(text, getMainKeyboard());
});

bot.hears("🔁 Повторить", async (ctx) => {
  const items = getHistory(ctx.from.id);

  if (!items.length) {
    await ctx.reply("Нет предыдущих заказов для повтора.", getMainKeyboard());
    return;
  }

  const last = items[0];

  setSession(ctx.from.id, {
    stepIndex: STEPS.length,
    data: {
      order: last.order,
      product: last.product,
      amount: last.amount,
      card: last.card,
      bank: last.bank,
      recipient: last.recipient,
      minutes: last.minutes
    }
  });

  await finishCreation(ctx, getSession(ctx.from.id));
});

bot.hears("❌ Отмена", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("❌ Создание ссылки отменено.", getMainKeyboard());
});

bot.hears("ℹ️ Помощь", async (ctx) => {
  await ctx.reply(
    [
      `Используй кнопки ниже 👇`,
      `💸 Новый платеж`,
      `📄 Мои ссылки`,
      `🔁 Повторить`,
      `❌ Отмена`
    ].join("\n"),
    getMainKeyboard()
  );
});

bot.action("cancel_create", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.answerCbQuery("Отменено");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply("❌ Создание ссылки отменено.", getMainKeyboard());
});

bot.action("newpay_again", async (ctx) => {
  setSession(ctx.from.id, {
    stepIndex: 0,
    data: {}
  });

  await ctx.answerCbQuery("Начинаем заново");
  await askNextStep(ctx, getSession(ctx.from.id));
});

bot.on("text", async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session) return;

  const step = STEPS[session.stepIndex];
  if (!step) return;

  let value = ctx.message.text.trim();

  if (step.key === "amount") {
    value = normalizeAmount(value);
    if (!value) {
      await ctx.reply("Введите корректную сумму. Например: 54444");
      return;
    }
  }

  if (step.key === "card") {
    value = normalizeCard(value);
    if (value.length < 12) {
      await ctx.reply("Введите корректный номер карты.");
      return;
    }
  }

  if (step.key === "minutes") {
    value = normalizeMinutes(value);
  }

  session.data[step.key] = value;
  session.stepIndex += 1;

  setSession(ctx.from.id, session);

  if (session.stepIndex >= STEPS.length) {
    await finishCreation(ctx, session);
    return;
  }

  await askNextStep(ctx, session);
});

app.get("/", (req, res) => {
  res.status(200).send("Bot is running");
});

app.post("/send", upload.single("file"), async (req, res) => {
  try {
    if (!TG_CHAT_ID) {
      return res.status(500).json({
        ok: false,
        error: "Не задан TG_CHAT_ID"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Файл не прикреплен"
      });
    }

    const {
      order = "",
      product = "",
      amount = "",
      recipient = "",
      bank = "",
      method = "",
      card_last4 = "",
      comment = ""
    } = req.body || {};

    const caption = [
      "📥 <b>Новое подтверждение оплаты</b>",
      "",
      `📦 <b>Заказ:</b> ${escapeHtml(order || "—")}`,
      `🖥 <b>Товар:</b> ${escapeHtml(product || "—")}`,
      `💰 <b>Сумма:</b> ${escapeHtml(formatAmount(amount || "0"))}`,
      `👤 <b>Получатель:</b> ${escapeHtml(recipient || "—")}`,
      `🏦 <b>Банк:</b> ${escapeHtml(bank || "—")}`,
      `💳 <b>Карта:</b> **** ${escapeHtml(card_last4 || "—")}`,
      `💸 <b>Метод:</b> ${escapeHtml(method || "—")}`,
      "",
      `💬 <b>Комментарий:</b> ${escapeHtml(comment || "—")}`
    ].join("\n");

    const isImage = (req.file.mimetype || "").startsWith("image/");

    if (isImage) {
      await bot.telegram.sendPhoto(
        TG_CHAT_ID,
        { source: req.file.buffer, filename: req.file.originalname },
        { caption, parse_mode: "HTML" }
      );
    } else {
      await bot.telegram.sendDocument(
        TG_CHAT_ID,
        { source: req.file.buffer, filename: req.file.originalname },
        { caption, parse_mode: "HTML" }
      );
    }

    return res.status(200).json({
      ok: true,
      message: "Файл успешно отправлен"
    });
  } catch (error) {
    console.error("SEND ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Ошибка отправки"
    });
  }
});

app.use((err, req, res, next) => {
  console.error("EXPRESS ERROR:", err);

  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      ok: false,
      error: "Файл больше 10 МБ"
    });
  }

  return res.status(400).json({
    ok: false,
    error: err.message || "Ошибка запроса"
  });
});

app.listen(PORT, () => {
  console.log("Web server started on port", PORT);
});

bot.launch()
  .then(() => {
    console.log("Bot started");
  })
  .catch((err) => {
    console.error("Launch error:", err);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
