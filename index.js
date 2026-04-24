require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { Telegraf, Markup } = require("telegraf");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

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
const lastOrders = new Map();

const RECEIPTS_DIR = path.join(__dirname, "receipts");
if (!fs.existsSync(RECEIPTS_DIR)) {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
}

// Пути к шрифтам
const FONT_REGULAR = path.join(__dirname, "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "DejaVuSans-Bold.ttf");

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

function getLast4(value) {
  return String(value || "").replace(/[^\d]/g, "").slice(-4);
}

function getDateTime() {
  return new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

// ============ PDF С РУССКИМИ ШРИФТАМИ ============
async function generateReceiptPDF(orderData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers = [];
      
      // Регистрируем шрифты
      if (fs.existsSync(FONT_REGULAR)) {
        doc.registerFont("Regular", FONT_REGULAR);
      }
      if (fs.existsSync(FONT_BOLD)) {
        doc.registerFont("Bold", FONT_BOLD);
      }
      
      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      const useFont = fs.existsSync(FONT_BOLD) ? "Bold" : "Helvetica-Bold";
      const useFontRegular = fs.existsSync(FONT_REGULAR) ? "Regular" : "Helvetica";

      // Заголовок
      doc.font(useFont).fontSize(22).fillColor("#1d4f91");
      doc.text("ПОДТВЕРЖДЕНИЕ ОПЛАТЫ", { align: "center" });
      doc.moveDown(0.3);
      doc.font(useFont).fontSize(14).fillColor("#000");
      doc.text(`Заказ #${orderData.order}`, { align: "center" });
      doc.moveDown(1);
      
      // Линия
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke("#2563eb");
      doc.moveDown(1);

      // Дата и статус
      doc.font(useFontRegular).fontSize(12).fillColor("#000");
      doc.text(`Дата: ${getDateTime()}`);
      doc.font(useFont).fillColor("#16a34a");
      doc.text(`Статус: ОПЛАЧЕНО`);
      doc.fillColor("#000");
      doc.moveDown(1);

      // Детали заказа
      doc.font(useFont).fontSize(14);
      doc.text("Детали заказа:");
      doc.moveDown(0.5);
      
      doc.font(useFontRegular).fontSize(12);
      doc.text(`Товар: ${orderData.product}`);
      doc.text(`Сумма: ${formatAmount(orderData.amount)}`);
      
      const methodText = orderData.method === "phone" ? "По номеру телефона" : "На карту";
      doc.text(`Способ оплаты: ${methodText}`);
      doc.text(`Реквизит: ${orderData.requisite}`);
      doc.text(`Банк: ${orderData.bank}`);
      doc.text(`Получатель: ${orderData.recipient}`);
      doc.moveDown(1);

      // Данные клиента
      if (orderData.customer_name) {
        doc.font(useFont).fontSize(14);
        doc.text("Данные клиента:");
        doc.moveDown(0.5);
        doc.font(useFontRegular).fontSize(12);
        doc.text(`ФИО: ${orderData.customer_name}`);
        doc.text(`Телефон: ${orderData.customer_phone}`);
        doc.text(`Email: ${orderData.customer_email}`);
        doc.moveDown(1);
      }

      // Доставка
      if (orderData.delivery) {
        doc.font(useFont).fontSize(14);
        doc.text("Доставка:");
        doc.moveDown(0.5);
        doc.font(useFontRegular).fontSize(12);
        doc.text(`Служба: ${orderData.delivery}`);
        doc.text(`Город: ${orderData.city}`);
        doc.text(`Адрес: ${orderData.full_address}`);
        doc.text(`ПВЗ: ${orderData.pickup || "—"}`);
        doc.moveDown(1);
      }

      // Подвал
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke("#2563eb");
      doc.moveDown(1);
      doc.font(useFontRegular).fontSize(10).fillColor("#64748b");
      doc.text("Спасибо за оплату! Заказ принят в обработку.", { align: "center" });
      doc.moveDown(0.5);
      doc.font(useFontRegular).fontSize(8);
      doc.text(`Дата формирования: ${getDateTime()}`, { align: "center" });
      
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============ МЕНЮ ============
async function setupMenu() {
  try {
    await bot.telegram.setMyCommands([
      { command: "new", description: "💳 Новый платеж" },
      { command: "links", description: "📋 Мои ссылки" },
      { command: "repeat", description: "🔄 Повторить" },
      { command: "cancel", description: "❌ Отмена" }
    ]);
  } catch (e) {
    console.error("Ошибка меню:", e.message);
  }
}

const MAIN_MENU = [
  ["💳 Новый платеж"],
  ["📋 Мои ссылки"],
  ["🔄 Повторить"],
  ["❌ Отмена"]
];

function showMainMenu(ctx) {
  return ctx.reply("👇 Выберите действие:", Markup.keyboard(MAIN_MENU).resize());
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
  
  const orderId = data.order || Math.random().toString(36).substring(2, 8);
  orders.set(orderId, { ...data, id: orderId, status: "pending", createdAt: Date.now() });

  return url;
}

// ============ БОТ ============
bot.catch((err, ctx) => {
  console.error("Ошибка бота:", err.message);
});

bot.start(async (ctx) => {
  await ctx.reply("🚀 Бот для создания платёжных ссылок");
  await showMainMenu(ctx);
});

bot.command("new", async (ctx) => {
  sessions.set(ctx.from.id, { step: "order", data: {} });
  await ctx.reply("📦 Введите номер заказа:");
});

bot.hears("💳 Новый платеж", async (ctx) => {
  sessions.set(ctx.from.id, { step: "order", data: {} });
  await ctx.reply("📦 Введите номер заказа:");
});

bot.hears("📋 Мои ссылки", async (ctx) => {
  let msg = "📋 Последние заказы:\n\n";
  let count = 0;
  
  orders.forEach((order) => {
    if (count >= 5) return;
    const statusEmoji = order.status === "approved" ? "✅" : order.status === "rejected" ? "❌" : "⏳";
    msg += `${statusEmoji} Заказ: ${order.order} | ${formatAmount(order.amount)}\n`;
    count++;
  });

  if (count === 0) msg = "Нет созданных заказов.";
  await ctx.reply(msg);
});

bot.hears("🔄 Повторить", async (ctx) => {
  const last = lastOrders.get(ctx.from.id);
  if (!last) return ctx.reply("Нет последнего заказа.");
  
  const url = buildPaymentUrl({ ...last, userId: ctx.from.id });
  await ctx.reply(`🔄 Повтор:\n📦 ${last.order}\n💰 ${formatAmount(last.amount)}\n🔗 ${url}`);
});

bot.hears("❌ Отмена", async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply("❌ Отменено.");
});

// Обработка текста
bot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const text = ctx.message.text;

  try {
    switch (session.step) {
      case "order":
        session.data.order = text;
        session.step = "product";
        await ctx.reply("🛍 Товар:");
        break;

      case "product":
        session.data.product = text;
        session.step = "amount";
        await ctx.reply("💰 Сумма (только цифры):");
        break;

      case "amount":
        const amt = normalizeDigits(text);
        if (!amt) return ctx.reply("❌ Только цифры!");
        session.data.amount = amt;
        session.step = "method";
        await ctx.reply("💳 Выберите способ:", 
          Markup.keyboard([["💳 По карте", "📱 По номеру телефона"]]).resize()
        );
        break;

      case "method":
        if (text.includes("карт")) {
          session.data.method = "card";
          await ctx.reply("💳 Номер карты:", Markup.removeKeyboard());
        } else if (text.includes("телефон") || text.includes("номер")) {
          session.data.method = "phone";
          await ctx.reply("📱 Номер телефона:", Markup.removeKeyboard());
        } else {
          return ctx.reply("⚠️ Выберите:", 
            Markup.keyboard([["💳 По карте", "📱 По номеру телефона"]]).resize()
          );
        }
        session.step = "requisite";
        break;

      case "requisite":
        if (session.data.method === "card") {
          if (!isValidCard(text)) return ctx.reply("❌ 15-19 цифр для карты!");
          session.data.requisite = formatCard(text);
        } else {
          if (!isValidPhone(text)) return ctx.reply("❌ 11 цифр для телефона!");
          session.data.requisite = formatPhone(text);
        }
        session.step = "bank";
        await ctx.reply("🏦 Банк:");
        break;

      case "bank":
        session.data.bank = text;
        session.step = "recipient";
        await ctx.reply("👤 Получатель:");
        break;

      case "recipient":
        session.data.recipient = text;
        session.data.userId = ctx.from.id;
        
        const url = buildPaymentUrl(session.data);
        lastOrders.set(ctx.from.id, { ...session.data });
        
        const methodEmoji = session.data.method === "card" ? "💳" : "📱";
        
        await ctx.reply(
          `✅ *Готово!*\n\n` +
          `📦 Заказ: \`${session.data.order}\`\n` +
          `🛍 Товар: \`${session.data.product}\`\n` +
          `💰 Сумма: *${formatAmount(session.data.amount)}*\n` +
          `${methodEmoji} Реквизит: \`${session.data.requisite}\`\n` +
          `🏦 Банк: \`${session.data.bank}\`\n` +
          `👤 Получатель: \`${session.data.recipient}\`\n\n` +
          `🔗 \`${url}\``,
          { parse_mode: "Markdown" }
        );
        
        sessions.delete(ctx.from.id);
        await showMainMenu(ctx);
        break;
    }
  } catch (err) {
    console.error("Ошибка:", err);
    sessions.delete(ctx.from.id);
    ctx.reply("❌ Ошибка. Начните заново: /new");
  }
});

// ============ API ============
app.get("/status", (req, res) => {
  const order = orders.get(req.query.order);
  if (!order) return res.json({ ok: false });
  res.json({ ok: true, status: order.status, data: order });
});

app.get("/receipt", (req, res) => {
  const orderId = req.query.order;
  const filePath = path.join(RECEIPTS_DIR, `receipt_${orderId}.pdf`);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Чек не найден");
  }
  
  res.sendFile(filePath);
});

app.post("/send", upload.single("file"), async (req, res) => {
  try {
    const orderId = req.body.order;
    const order = orders.get(orderId);

    if (!order) {
      return res.json({ ok: false, error: "Заказ не найден" });
    }

    order.customer_name = req.body.customer_name || "";
    order.customer_phone = req.body.customer_phone || "";
    order.customer_email = req.body.customer_email || "";
    order.delivery = req.body.delivery || "";
    order.city = req.body.city || "";
    order.full_address = req.body.full_address || "";
    order.pickup = req.body.pickup || "";
    order.comment = req.body.comment || "";
    order.status = "checking";

    const methodEmoji = order.method === "phone" ? "📱" : "💳";
    const methodName = order.method === "phone" ? "По номеру телефона" : "На карту";
    const cardMask = order.method === "card" ? `***** ${getLast4(order.requisite)}` : order.requisite;

    let message = `💸 *Новое подтверждение оплаты*\n\n`;
    message += `📦 Заказ: ${order.order}\n`;
    message += `🛍 Товар: ${order.product}\n`;
    message += `💰 Сумма: ${formatAmount(order.amount)}\n`;
    message += `👤 Получатель: ${order.recipient}\n`;
    message += `🏦 Банк: ${order.bank}\n`;
    message += `${methodEmoji} ${methodName}: ${cardMask}\n`;
    
    if (order.comment) {
      message += `\n💬 Комментарий: ${order.comment}\n`;
    }
    
    message += `\n📌 Статус: *Ожидает проверки*`;

    if (TG_CHAT_ID) {
      await bot.telegram.sendMessage(TG_CHAT_ID, message, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Подтвердить", `approve_${orderId}`),
            Markup.button.callback("❌ Отклонить", `reject_${orderId}`)
          ]
        ])
      });

      if (req.file) {
        await bot.telegram.sendDocument(TG_CHAT_ID, {
          source: req.file.buffer,
          filename: req.file.originalname
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Ошибка:", e);
    res.json({ ok: false, error: e.message });
  }
});

// ============ КНОПКИ ПОДТВЕРДИТЬ/ОТКЛОНИТЬ ============
bot.action(/approve_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    return ctx.answerCbQuery("Заказ не найден");
  }

  order.status = "approved";

  try {
    const pdfBuffer = await generateReceiptPDF(order);
    const pdfPath = path.join(RECEIPTS_DIR, `receipt_${orderId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    const receiptUrl = `${APP_BASE_URL}/receipt?order=${orderId}`;

    const oldText = ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption || "";
    const newText = oldText.replace("Ожидает проверки", "Оплата подтверждена ✅");

    await ctx.editMessageText(newText, { parse_mode: "Markdown" });

    await ctx.reply(
      `✅ *Оплата подтверждена!*\n\n` +
      `📦 Заказ: #${orderId}\n` +
      `🔗 Чек для клиента: ${receiptUrl}`,
      { parse_mode: "Markdown" }
    );

    await ctx.replyWithDocument({
      source: pdfBuffer,
      filename: `Подтверждение_оплаты_заказ_${orderId}.pdf`
    });

    return ctx.answerCbQuery("Подтверждено!");
  } catch (err) {
    console.error("Ошибка PDF:", err);
    return ctx.answerCbQuery("Ошибка создания PDF");
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    return ctx.answerCbQuery("Заказ не найден");
  }

  order.status = "rejected";

  const oldText = ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption || "";
  const newText = oldText.replace("Ожидает проверки", "Оплата отклонена ❌");

  await ctx.editMessageText(newText, { parse_mode: "Markdown" });

  return ctx.answerCbQuery("Отклонено!");
});

// ============ ЗАПУСК ============
app.post("/bot", bot.webhookCallback("/bot"));

app.listen(PORT, async () => {
  await setupMenu();
  await bot.telegram.deleteWebhook();
  await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
  console.log("✅ Бот и API запущены на порту", PORT);
  console.log("📁 Шрифты:", fs.existsSync(FONT_REGULAR) ? "DejaVuSans.ttf найден" : "DejaVuSans.ttf НЕ найден!");
  console.log("📁 Шрифты:", fs.existsSync(FONT_BOLD) ? "DejaVuSans-Bold.ttf найден" : "DejaVuSans-Bold.ttf НЕ найден!");
});
