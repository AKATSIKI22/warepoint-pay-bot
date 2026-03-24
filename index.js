require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { Telegraf, Markup } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const APP_BASE_URL = process.env.APP_BASE_URL;

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== ХРАНИЛИЩЕ =====
const orders = {};

// ===== UPLOAD =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ===== ФОРМАТ СУММЫ =====
function formatAmount(value) {
  return Number(value).toLocaleString("ru-RU") + " ₽";
}

// ===== PDF =====
function generatePDF(meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });

    const buffers = [];
    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => resolve(Buffer.concat(buffers)));

    const date = new Date().toLocaleString("ru-RU");

    // ===== HEADER =====
    doc.fontSize(12).text(date);
    doc.moveDown();

    doc.fontSize(16).text("ООО «WAREPOINT»");
    doc.fontSize(11)
      .text("ИНН 5012110688 / КПП 501201001")
      .text("ОГРН 1235000092887")
      .text("г. Москва");

    doc.moveDown();
    doc.text("------------------------------------------------");
    doc.moveDown();

    // ===== PRODUCT =====
    doc.fontSize(13).text(meta.product);
    doc.text("1 шт");

    doc.moveDown();
    doc.text("Доставка: 0 ₽ (БЕСПЛАТНО)");

    doc.moveDown();
    doc.text(`Безналичный: ${formatAmount(meta.amount)}`);
    doc.text("Платёж через СБП");

    doc.moveDown();
    doc.text("------------------------------------------------");

    doc.moveDown();

    // ===== TOTAL =====
    doc.fontSize(20).text(formatAmount(meta.amount));

    doc.moveDown();
    doc.text("НДС: НЕТ");

    doc.moveDown();
    doc.text(`Заказ № ${meta.order}`);

    doc.moveDown();

    // ===== ПЕЧАТЬ =====
    if (fs.existsSync("./stamp.png")) {
      doc.image("./stamp.png", doc.page.width - 180, doc.y - 100, {
        width: 120
      });
    }

    doc.end();
  });
}

// ===== ОБРАБОТЧИКИ БОТА =====

bot.start((ctx) => {
  ctx.reply("Бот работает 🚀");
});

// ===== API ПРИЁМА ЧЕКА =====

app.post("/send", upload.single("file"), async (req, res) => {
  try {
    const { order, amount, product } = req.body;

    if (!req.file) {
      return res.json({ ok: false });
    }

    orders[order] = {
      order,
      amount,
      product
    };

    await bot.telegram.sendPhoto(
      TG_CHAT_ID,
      { source: req.file.buffer },
      {
        caption: `💸 Новый чек\n\nЗаказ: ${order}\nСумма: ${amount} ₽`,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Подтвердить", `ok_${order}`),
            Markup.button.callback("❌ Отклонить", `no_${order}`)
          ]
        ])
      }
    );

    res.json({ ok: true });

  } catch (e) {
    console.log(e);
    res.json({ ok: false });
  }
});

// ===== КНОПКИ =====

bot.action(/ok_(.+)/, async (ctx) => {
  const order = ctx.match[1];
  const data = orders[order];

  if (!data) return;

  const pdf = await generatePDF(data);

  await ctx.replyWithDocument({
    source: pdf,
    filename: `WAREPOINT_CHECK_${order}.pdf`
  });

  await ctx.answerCbQuery("Подтверждено ✅");
});

bot.action(/no_(.+)/, async (ctx) => {
  await ctx.answerCbQuery("Отклонено ❌");
});

// ===== EXPRESS =====

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});

// ===== WEBHOOK =====

app.post("/bot", bot.webhookCallback("/bot"));

(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
    console.log("Webhook set:", `${APP_BASE_URL}/bot`);
  } catch (e) {
    console.log("Webhook error:", e);
  }
})();

// ===== START SERVER =====

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
