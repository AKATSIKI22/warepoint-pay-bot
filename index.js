require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

const BASE_PAYMENT_URL = process.env.BASE_PAYMENT_URL || "https://warepointpay.ru";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://warepoint-pay-bot.onrender.com";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const PORT = process.env.PORT || 3000;

const STAMP_PATH = path.join(__dirname, "stamp.png");
const FONT_REGULAR = path.join(__dirname, "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "DejaVuSans-Bold.ttf");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors());

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
const orderMeta = new Map();

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

function getReceiptDecisionKeyboard(order) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Подтвердить", `approve:${order}`),
      Markup.button.callback("❌ Отклонить", `reject:${order}`)
    ]
  ]);
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

function upsertOrderMeta(data) {
  const order = String(data.order);
  const minutes = Number(normalizeMinutes(data.minutes));
  const expiresAt = Date.now() + minutes * 60 * 1000;

  orderMeta.set(order, {
    ...(orderMeta.get(order) || {}),
    order,
    product: data.product || "",
    amount: normalizeAmount(data.amount || ""),
    card: normalizeCard(data.card || ""),
    bank: data.bank || "",
    recipient: data.recipient || "",
    minutes: String(minutes),
    status: "pending",
    expiresAt,
    updatedAt: Date.now()
  });

  return orderMeta.get(order);
}

function buildPaymentUrl(data) {
  const meta = upsertOrderMeta(data);

  const params = new URLSearchParams({
    order: meta.order,
    product: meta.product,
    amount: meta.amount,
    card: meta.card,
    bank: meta.bank,
    recipient: meta.recipient,
    method: "Перевод на карту",
    expires: String(meta.expiresAt)
  });

  return `${BASE_PAYMENT_URL}?${params.toString()}`;
}

function buildReceiptUrl(order) {
  return `${APP_BASE_URL}/receipt?order=${encodeURIComponent(order)}`;
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

function ensureFonts() {
  if (!fs.existsSync(FONT_REGULAR)) {
    throw new Error("Не найден файл DejaVuSans.ttf");
  }
  if (!fs.existsSync(FONT_BOLD)) {
    throw new Error("Не найден файл DejaVuSans-Bold.ttf");
  }
}

function drawField(doc, x, y, w, h, label, value) {
  doc
    .roundedRect(x, y, w, h, 16)
    .fillColor("#F8FAFC")
    .fill();

  doc
    .roundedRect(x, y, w, h, 16)
    .lineWidth(1)
    .strokeColor("#E2E8F0")
    .stroke();

  doc
    .font("regular")
    .fontSize(10)
    .fillColor("#64748B")
    .text(label, x + 16, y + 12, {
      width: w - 32
    });

  doc
    .font("bold")
    .fontSize(15)
    .fillColor("#111827")
    .text(String(value || "—"), x + 16, y + 30, {
      width: w - 32,
      ellipsis: true
    });
}

function generateConfirmationPdfBuffer(meta) {
  return new Promise((resolve, reject) => {
    try {
      ensureFonts();

      const doc = new PDFDocument({
        size: "A4",
        margin: 0
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.registerFont("regular", FONT_REGULAR);
      doc.registerFont("bold", FONT_BOLD);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      // Фон страницы
      doc.rect(0, 0, pageWidth, pageHeight).fill("#EEF3F8");

      // Основная карточка
      const cardX = 34;
      const cardY = 34;
      const cardW = pageWidth - 68;
      const cardH = pageHeight - 68;

      doc
        .roundedRect(cardX, cardY, cardW, cardH, 28)
        .fillColor("#FFFFFF")
        .fill();

      doc
        .roundedRect(cardX, cardY, cardW, cardH, 28)
        .lineWidth(1)
        .strokeColor("#D8E1EC")
        .stroke();

      // Верхняя синяя полоса
      doc
        .roundedRect(cardX, cardY, cardW, 10, 28)
        .fillColor("#0B4A98")
        .fill();

      // Логотип-текст
      doc
        .font("bold")
        .fontSize(30)
        .fillColor("#0B4A98")
        .text("WAREPOINT", 0, 68, {
          width: pageWidth,
          align: "center"
        });

      doc
        .font("regular")
        .fontSize(11)
        .fillColor("#64748B")
        .text("Интернет-магазин компьютерных комплектующих", 0, 104, {
          width: pageWidth,
          align: "center"
        });

      // Разделитель
      doc
        .moveTo(76, 132)
        .lineTo(pageWidth - 76, 132)
        .lineWidth(1)
        .strokeColor("#DCE6F1")
        .stroke();

      // Зеленая плашка
      doc
        .roundedRect(76, 154, pageWidth - 152, 54, 18)
        .fillColor("#EAF8EF")
        .fill();

      doc
        .roundedRect(76, 154, pageWidth - 152, 54, 18)
        .lineWidth(1)
        .strokeColor("#CBE8D5")
        .stroke();

      doc
        .font("bold")
        .fontSize(20)
        .fillColor("#118548")
        .text("✓ ОПЛАТА ПОДТВЕРЖДЕНА", 76, 171, {
          width: pageWidth - 152,
          align: "center"
        });

      // Заголовок
      doc
        .font("bold")
        .fontSize(18)
        .fillColor("#1E293B")
        .text("Подтверждение получения оплаты", 76, 235, {
          width: pageWidth - 152,
          align: "left"
        });

      const order = meta.order || "—";
      const product = meta.product || "—";
      const amount = formatAmount(meta.amount || "0");
      const bank = meta.bank || "—";
      const recipient = meta.recipient || "—";
      const dateText = new Date().toLocaleString("ru-RU");
      const confirmId = `WP-${new Date().getFullYear()}-${String(order).padStart(6, "0")}`;

      const left = 76;
      const gap = 16;
      const fullW = pageWidth - 152;
      const colW = (fullW - gap) / 2;

      let y = 272;

      drawField(doc, left, y, colW, 72, "Номер заказа", `# ${order}`);
      drawField(doc, left + colW + gap, y, colW, 72, "ID подтверждения", confirmId);

      y += 88;
      drawField(doc, left, y, fullW, 72, "Товар", product);

      y += 88;
      drawField(doc, left, y, colW, 72, "Сумма", amount);
      drawField(doc, left + colW + gap, y, colW, 72, "Дата подтверждения", dateText);

      y += 88;
      drawField(doc, left, y, colW, 72, "Банк", bank);
      drawField(doc, left + colW + gap, y, colW, 72, "Получатель", recipient);

      // Инфо-блок
      y += 98;
      doc
        .roundedRect(76, y, fullW, 112, 18)
        .fillColor("#F8FAFC")
        .fill();

      doc
        .roundedRect(76, y, fullW, 112, 18)
        .lineWidth(1)
        .strokeColor("#E2E8F0")
        .stroke();

      doc
        .font("bold")
        .fontSize(12)
        .fillColor("#334155")
        .text("Информация", 96, y + 16);

      doc
        .font("regular")
        .fontSize(11.5)
        .fillColor("#475569")
        .text(
          "Данный документ подтверждает, что магазин Warepoint получил оплату по указанному заказу. " +
          "Документ является подтверждением от магазина и не относится к банковским или кассовым документам.",
          96,
          y + 38,
          {
            width: fullW - 40,
            align: "left",
            lineGap: 4
          }
        );

      // Печать/лого
      if (fs.existsSync(STAMP_PATH)) {
        try {
          doc.image(STAMP_PATH, pageWidth - 240, pageHeight - 235, {
            fit: [150, 150],
            align: "center",
            valign: "center"
          });
        } catch (e) {
          console.error("STAMP IMAGE ERROR:", e);
        }
      }

      // Подвал
      doc
        .moveTo(76, pageHeight - 86)
        .lineTo(pageWidth - 76, pageHeight - 86)
        .lineWidth(1)
        .strokeColor("#E2E8F0")
        .stroke();

      doc
        .font("regular")
        .fontSize(10)
        .fillColor("#64748B")
        .text("© Warepoint — подтверждение оплаты от магазина", 76, pageHeight - 72, {
          width: pageWidth - 152,
          align: "center"
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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

function buildReceiptHtml(meta) {
  const order = meta.order || "—";
  const product = meta.product || "—";
  const amount = formatAmount(meta.amount || "0");
  const dateText = new Date().toLocaleString("ru-RU");
  const id = `WP-${new Date().getFullYear()}-${String(order).padStart(6, "0")}`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Подтверждение оплаты</title>
<style>
  body{
    margin:0;
    background:#0b0f14;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    color:#fff;
  }
  .wrap{
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:24px;
    box-sizing:border-box;
  }
  .card{
    width:100%;
    max-width:680px;
    background:
      radial-gradient(120% 120% at 50% 0%, rgba(255,255,255,.08) 0%, rgba(255,255,255,0) 55%),
      linear-gradient(180deg,#111827 0%, #0b0f14 100%);
    border:1px solid rgba(255,255,255,.08);
    border-radius:28px;
    box-shadow:0 30px 80px rgba(0,0,0,.45);
    padding:28px;
  }
  .brand{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:16px;
    margin-bottom:22px;
  }
  .logo{
    font-size:24px;
    font-weight:900;
    letter-spacing:.08em;
  }
  .badge{
    display:inline-flex;
    align-items:center;
    gap:10px;
    padding:12px 16px;
    border-radius:999px;
    background:rgba(34,197,94,.12);
    border:1px solid rgba(34,197,94,.25);
    color:#bbf7d0;
    font-weight:700;
  }
  .title{
    font-size:28px;
    font-weight:800;
    margin:10px 0 24px;
    line-height:1.15;
  }
  .grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:14px;
  }
  .row{
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.06);
    border-radius:18px;
    padding:16px 18px;
  }
  .k{
    color:#94a3b8;
    font-size:13px;
    margin-bottom:8px;
  }
  .v{
    color:#fff;
    font-size:17px;
    font-weight:700;
    word-break:break-word;
  }
  .big{
    grid-column:1 / -1;
  }
  .note{
    margin-top:22px;
    padding:16px 18px;
    border-radius:18px;
    background:rgba(255,255,255,.03);
    border:1px solid rgba(255,255,255,.06);
    color:#cbd5e1;
    line-height:1.55;
  }
  .footer{
    margin-top:20px;
    color:#64748b;
    font-size:12px;
    text-align:center;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="brand">
        <div class="logo">WAREPOINT</div>
        <div class="badge">✔ Оплата подтверждена</div>
      </div>

      <div class="title">Подтверждение оплаты от магазина</div>

      <div class="grid">
        <div class="row">
          <div class="k">Номер заказа</div>
          <div class="v"># ${escapeHtml(order)}</div>
        </div>

        <div class="row">
          <div class="k">ID подтверждения</div>
          <div class="v">${escapeHtml(id)}</div>
        </div>

        <div class="row big">
          <div class="k">Товар</div>
          <div class="v">${escapeHtml(product)}</div>
        </div>

        <div class="row">
          <div class="k">Сумма</div>
          <div class="v">${escapeHtml(amount)}</div>
        </div>

        <div class="row">
          <div class="k">Дата подтверждения</div>
          <div class="v">${escapeHtml(dateText)}</div>
        </div>
      </div>
      
      <div class="footer">
        © Warepoint
      </div>
    </div>
  </div>
</body>
</html>`;
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
      `❌ Отмена — отменить текущее создание`
    ].join("\n"),
    getMainKeyboard()
  );
});

bot.command("newpay", async (ctx) => {
  setSession(ctx.from.id, { stepIndex: 0, data: {} });
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

bot.command("cancel", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("❌ Создание ссылки отменено.", getMainKeyboard());
});

bot.hears("💸 Новый платеж", async (ctx) => {
  setSession(ctx.from.id, { stepIndex: 0, data: {} });
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
  setSession(ctx.from.id, { stepIndex: 0, data: {} });
  await ctx.answerCbQuery("Начинаем заново");
  await askNextStep(ctx, getSession(ctx.from.id));
});

bot.action(/^approve:(.+)$/, async (ctx) => {
  try {
    const order = String(ctx.match[1]);
    const current = orderMeta.get(order) || { order, status: "pending" };

    orderMeta.set(order, {
      ...current,
      status: "approved",
      updatedAt: Date.now()
    });

    await ctx.answerCbQuery("Оплата подтверждена");

    const originalText =
      (ctx.update.callback_query.message.caption || ctx.update.callback_query.message.text || "").trim();

    const newText = `${originalText}\n\n✅ <b>Статус:</b> Оплата подтверждена`;

    if (ctx.update.callback_query.message.photo || ctx.update.callback_query.message.document) {
      await ctx.editMessageCaption(newText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([]).reply_markup
      }).catch(() => {});
    } else {
      await ctx.editMessageText(newText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([]).reply_markup
      }).catch(() => {});
    }

    const meta = orderMeta.get(order);
    const pdfBuffer = await generateConfirmationPdfBuffer(meta);
    const receiptUrl = buildReceiptUrl(order);

    await ctx.reply(`✅ Заказ #${order} подтвержден.`);

    await bot.telegram.sendDocument(
      ctx.chat.id,
      {
        source: pdfBuffer,
        filename: `Подтверждение_оплаты_заказ_${order}.pdf`
      },
      {
        caption: [
          `📄 Подтверждение оплаты от магазина`,
          `Заказ: #${order}`,
          ``,
          `Ссылка для клиента:`,
          receiptUrl
        ].join("\n")
      }
    );
  } catch (err) {
    console.error("APPROVE ERROR:", err);
    await ctx.answerCbQuery("Ошибка");
  }
});

bot.action(/^reject:(.+)$/, async (ctx) => {
  try {
    const order = String(ctx.match[1]);
    const current = orderMeta.get(order) || { order, status: "pending" };

    orderMeta.set(order, {
      ...current,
      status: "rejected",
      updatedAt: Date.now()
    });

    await ctx.answerCbQuery("Оплата отклонена");

    const originalText =
      (ctx.update.callback_query.message.caption || ctx.update.callback_query.message.text || "").trim();

    const newText = `${originalText}\n\n❌ <b>Статус:</b> Оплата отклонена`;

    if (ctx.update.callback_query.message.photo || ctx.update.callback_query.message.document) {
      await ctx.editMessageCaption(newText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([]).reply_markup
      }).catch(() => {});
    } else {
      await ctx.editMessageText(newText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([]).reply_markup
      }).catch(() => {});
    }

    await ctx.reply(`❌ Заказ #${order} отклонен.`);
  } catch (err) {
    console.error("REJECT ERROR:", err);
    await ctx.answerCbQuery("Ошибка");
  }
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

app.get("/status", (req, res) => {
  const order = String(req.query.order || "").trim();

  if (!order) {
    return res.status(400).json({
      ok: false,
      error: "Не передан номер заказа"
    });
  }

  const meta = orderMeta.get(order);

  if (!meta) {
    return res.json({
      ok: true,
      status: "pending",
      expiresAt: null
    });
  }

  return res.json({
    ok: true,
    status: meta.status || "pending",
    expiresAt: meta.expiresAt || null
  });
});

app.get("/receipt", (req, res) => {
  const order = String(req.query.order || "").trim();

  if (!order) {
    return res.status(400).send("Не передан номер заказа");
  }

  const meta = orderMeta.get(order);

  if (!meta || meta.status !== "approved") {
    return res.status(404).send("Подтверждение не найдено или заказ не подтвержден");
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(buildReceiptHtml(meta));
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

    const orderKey = String(order || "");
    const current = orderMeta.get(orderKey) || {};

    orderMeta.set(orderKey, {
      ...current,
      order: orderKey,
      product: product || current.product || "",
      amount: normalizeAmount(amount || current.amount || ""),
      recipient: recipient || current.recipient || "",
      bank: bank || current.bank || "",
      method: method || current.method || "Перевод на карту",
      cardLast4: card_last4 || current.cardLast4 || "",
      status: current.status || "pending",
      expiresAt: current.expiresAt || null,
      updatedAt: Date.now()
    });

    const status = (orderMeta.get(orderKey)?.status) || "pending";

    let statusText = "🟡 <b>Статус:</b> Ожидает проверки";
    if (status === "approved") statusText = "✅ <b>Статус:</b> Оплата подтверждена";
    if (status === "rejected") statusText = "❌ <b>Статус:</b> Оплата отклонена";

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
      `💬 <b>Комментарий:</b> ${escapeHtml(comment || "—")}`,
      "",
      statusText
    ].join("\n");

    const keyboard = getReceiptDecisionKeyboard(orderKey).reply_markup;
    const isImage = (req.file.mimetype || "").startsWith("image/");

    if (isImage) {
      await bot.telegram.sendPhoto(
        TG_CHAT_ID,
        { source: req.file.buffer, filename: req.file.originalname },
        {
          caption,
          parse_mode: "HTML",
          reply_markup: keyboard
        }
      );
    } else {
      await bot.telegram.sendDocument(
        TG_CHAT_ID,
        { source: req.file.buffer, filename: req.file.originalname },
        {
          caption,
          parse_mode: "HTML",
          reply_markup: keyboard
        }
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
