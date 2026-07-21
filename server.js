// ============================================================
// ComFit Zone — WhatsApp Order Confirmation Automation
// Shopify webhook → Meta WhatsApp Cloud API
// Product image + order details + Confirm/Cancel buttons
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

// ---------- ENVIRONMENT VARIABLES (Railway/Render mein set karo) ----------
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;          // Meta permanent access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;        // WhatsApp phone number ID
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "comfit123"; // Meta webhook verify token (khud ka rakho)
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;            // e.g. myshop4848.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || "order_confirmation_buttons";

const GRAPH = "https://graph.facebook.com/v21.0";
const SHOPIFY_API = () => `https://${SHOPIFY_STORE}/admin/api/2026-01`;

// Shopify client-credentials token (Dev Dashboard apps) - auto-refreshes
let _shopifyToken = null;
let _shopifyTokenExp = 0;
async function getShopifyToken() {
  if (_shopifyToken && Date.now() < _shopifyTokenExp) return _shopifyToken;
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    console.error("Shopify token error:", JSON.stringify(data));
    throw new Error("Shopify token fetch failed");
  }
  _shopifyToken = data.access_token;
  const ttl = (data.expires_in || 86400) * 1000;
  _shopifyTokenExp = Date.now() + ttl - 5 * 60 * 1000; // refresh 5 min early
  return _shopifyToken;
}

// ---------- HELPERS ----------

// Pakistani phone format: 0300xxxxxxx / +92300xxxxxxx → 92300xxxxxxx
function formatPhone(raw) {
  let p = (raw || "").replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "92" + p.slice(1);
  if (p.length === 10 && p.startsWith("3")) p = "92" + p; // 300xxxxxxx case
  return p.startsWith("92") && p.length === 12 ? p : null;
}

async function shopifyGet(path) {
  const token = await getShopifyToken();
  const r = await fetch(`${SHOPIFY_API()}${path}`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!r.ok) throw new Error(`Shopify GET ${path} failed: ${r.status}`);
  return r.json();
}

async function shopifyPut(path, body) {
  const token = await getShopifyToken();
  const r = await fetch(`${SHOPIFY_API()}${path}`, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Shopify PUT ${path} failed: ${r.status}`);
  return r.json();
}

async function getProductImage(productId) {
  try {
    const data = await shopifyGet(`/products/${productId}.json`);
    return data.product?.image?.src || null;
  } catch {
    return null;
  }
}

async function sendWhatsApp(payload) {
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) console.error("WhatsApp send error:", JSON.stringify(data));
  return data;
}

// ---------- 1) SHOPIFY WEBHOOK: naya order aaya ----------
app.post("/webhook/order-created", async (req, res) => {
  res.sendStatus(200); // Shopify ko foran OK — warna wo retry karta rehta hai

  try {
    const order = req.body;
    const phone = formatPhone(order.shipping_address?.phone || order.phone);
    if (!phone) {
      console.log(`Order #${order.order_number}: valid phone nahi mila, skip.`);
      return;
    }

    const item = order.line_items?.[0];
    const imageUrl = item ? await getProductImage(item.product_id) : null;

    const components = [];

    // Header image sirf tab bhejo jab image mil jaye
    if (imageUrl) {
      components.push({
        type: "header",
        parameters: [{ type: "image", image: { link: imageUrl } }],
      });
    }

    components.push({
      type: "body",
      parameters: [
        { type: "text", text: order.customer?.first_name || "Customer" },
        { type: "text", text: (item?.title || "Your order").slice(0, 60) },
        { type: "text", text: String(order.order_number) },
        { type: "text", text: `Rs. ${order.total_price}` },
      ],
    });

    const result = await sendWhatsApp({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: "en" },
        components,
      },
    });

    console.log(
      `Order #${order.order_number} → WhatsApp sent to ${phone}:`,
      result?.messages?.[0]?.id || "FAILED"
    );
  } catch (err) {
    console.error("order-created handler error:", err.message);
  }
});

// ---------- 2) META WEBHOOK VERIFICATION (GET) ----------
// Meta App setup ke waqt ye endpoint verify hota hai
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---------- 3) META WEBHOOK: customer ne button dabaya ----------
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== "button") return;

    const from = msg.from; // 92300xxxxxxx
    const replyText = msg.button?.text || "";
    const confirmed = replyText.toLowerCase().includes("confirm");
    const tag = confirmed ? "confirmed" : "cancelled-by-customer";

    // Customer ke phone se uska latest order dhoondo
    const localPhone = "0" + from.slice(2); // 92300... → 0300...
    const search = await shopifyGet(
      `/orders.json?status=any&limit=20&fields=id,order_number,tags,phone,shipping_address`
    );

    const order = (search.orders || []).find((o) => {
      const p = formatPhone(o.shipping_address?.phone || o.phone);
      return p === from;
    });

    if (!order) {
      console.log(`Reply from ${from} (${replyText}) — matching order nahi mila.`);
      return;
    }

    // Order par tag lagao (purane tags preserve karo)
    const existingTags = (order.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!existingTags.includes(tag)) existingTags.push(tag);

    await shopifyPut(`/orders/${order.id}.json`, {
      order: { id: order.id, tags: existingTags.join(", ") },
    });

    console.log(`Order #${order.order_number} tagged: ${tag}`);

    // Customer ko thank-you / acknowledgement bhejo (24h window ke andar free-form allowed)
    await sendWhatsApp({
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: {
        body: confirmed
          ? `Shukriya! Aapka order #${order.order_number} CONFIRM ho gaya hai. ✅\nHum jald hi dispatch kar ke tracking details bhejenge. — ComFit Zone 🌸`
          : `Aapka order #${order.order_number} cancel kar diya gaya hai. ❌\nAgar ghalti se cancel hua hai to isi number par message kar dein. — ComFit Zone`,
      },
    });
  } catch (err) {
    console.error("whatsapp webhook handler error:", err.message);
  }
});

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => res.send("ComFit Zone WhatsApp bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// ============================================================
// ComFit Zone — WhatsApp Order Confirmation Automation
// Shopify webhook → Meta WhatsApp Cloud API
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "comfit123";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || "order_confirmation_buttons";

const GRAPH = "https://graph.facebook.com/v21.0";
const SHOPIFY_API = () => `https://${SHOPIFY_STORE}/admin/api/2026-01`;

function formatPhone(raw) {
  let p = (raw || "").replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "92" + p.slice(1);
  if (p.length === 10 && p.startsWith("3")) p = "92" + p;
  return p.startsWith("92") && p.length === 12 ? p : null;
}

async function shopifyGet(path) {
  const r = await fetch(`${SHOPIFY_API()}${path}`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN },
  });
  if (!r.ok) throw new Error(`Shopify GET ${path} failed: ${r.status}`);
  return r.json();
}

async function shopifyPut(path, body) {
  const r = await fetch(`${SHOPIFY_API()}${path}`, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Shopify PUT ${path} failed: ${r.status}`);
  return r.json();
}

async function getProductImage(productId) {
  try {
    const data = await shopifyGet(`/products/${productId}.json`);
    return data.product?.image?.src || null;
  } catch {
    return null;
  }
}

async function sendWhatsApp(payload) {
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) console.error("WhatsApp send error:", JSON.stringify(data));
  return data;
}

app.post("/webhook/order-created", async (req, res) => {
  res.sendStatus(200);

  try {
    const order = req.body;
    const phone = formatPhone(order.shipping_address?.phone || order.phone);
    if (!phone) {
      console.log(`Order #${order.order_number}: valid phone nahi mila, skip.`);
      return;
    }

    const item = order.line_items?.[0];
    const imageUrl = item ? await getProductImage(item.product_id) : null;

    const components = [];

    if (imageUrl) {
      components.push({
        type: "header",
        parameters: [{ type: "image", image: { link: imageUrl } }],
      });
    }

    components.push({
      type: "body",
      parameters: [
        { type: "text", text: order.customer?.first_name || "Customer" },
        { type: "text", text: (item?.title || "Your order").slice(0, 60) },
        { type: "text", text: String(order.order_number) },
        { type: "text", text: `Rs. ${order.total_price}` },
      ],
    });

    const result = await sendWhatsApp({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: "en" },
        components,
      },
    });

    console.log(
      `Order #${order.order_number} → WhatsApp sent to ${phone}:`,
      result?.messages?.[0]?.id || "FAILED"
    );
  } catch (err) {
    console.error("order-created handler error:", err.message);
  }
});

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== "button") return;

    const from = msg.from;
    const replyText = msg.button?.text || "";
    const confirmed = replyText.toLowerCase().includes("confirm");
    const tag = confirmed ? "confirmed" : "cancelled-by-customer";

    const search = await shopifyGet(
      `/orders.json?status=any&limit=20&fields=id,order_number,tags,phone,shipping_address`
    );

    const order = (search.orders || []).find((o) => {
      const p = formatPhone(o.shipping_address?.phone || o.phone);
      return p === from;
    });

    if (!order) {
      console.log(`Reply from ${from} (${replyText}) — matching order nahi mila.`);
      return;
    }

    const existingTags = (order.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!existingTags.includes(tag)) existingTags.push(tag);

    await shopifyPut(`/orders/${order.id}.json`, {
      order: { id: order.id, tags: existingTags.join(", ") },
    });

    console.log(`Order #${order.order_number} tagged: ${tag}`);

    await sendWhatsApp({
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: {
        body: confirmed
          ? `Shukriya! Aapka order #${order.order_number} CONFIRM ho gaya hai.\nHum jald hi dispatch kar ke tracking details bhejenge. — ComFit Zone`
          : `Aapka order #${order.order_number} cancel kar diya gaya hai.\nAgar ghalti se cancel hua hai to isi number par message kar dein. — ComFit Zone`,
      },
    });
  } catch (err) {
    console.error("whatsapp webhook handler error:", err.message);
  }
});

app.get("/", (req, res) => res.send("ComFit Zone WhatsApp bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
