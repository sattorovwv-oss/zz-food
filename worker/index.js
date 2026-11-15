// Cloudflare Worker: Telegram webhook для ZZ - Food.
// Кнопки заказов/отзывов + управление меню кнопками прямо в боте. Работает 24/7.
// Состояние диалога хранится в самих сообщениях бота (ответы на подсказки), поэтому база не нужна.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64FromBytes = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const strToB64 = (s) => b64FromBytes(enc.encode(s));
const b64ToStr = (b) => dec.decode(Uint8Array.from(atob(b.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

// ADMIN_CHAT_ID может содержать несколько ID через запятую
const isAdmin = (env, id) => String(env.ADMIN_CHAT_ID).split(",").map((s) => s.trim()).includes(String(id));

/* ---------- Telegram ---------- */
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
// style: "primary" (синяя) | "success" (зелёная) | "danger" (красная)
const B = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const MAIN_KB = {
  keyboard: [[{ text: "➕ Добавить блюдо", style: "success" }, { text: "📋 Блюда", style: "primary" }], [{ text: "❓ Помощь" }]],
  resize_keyboard: true, is_persistent: true,
};
const say = (env, chat, text, markup = MAIN_KB) => tg(env, "sendMessage", { chat_id: chat, text, reply_markup: markup });
const ask = (env, chat, text, ph) => tg(env, "sendMessage", { chat_id: chat, text, reply_markup: { force_reply: true, input_field_placeholder: ph || "" } });

/* ---------- GitHub ---------- */
async function gh(env, path, method = "GET", body) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${path}`, {
    method,
    headers: { Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "zz-food-bot", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${j.message || ""}`); e.status = r.status; throw e; }
  return j;
}
async function getJson(env, path, def) {
  try { const j = await gh(env, path); return { data: JSON.parse(b64ToStr(j.content)), sha: j.sha }; }
  catch (e) { if (e.status === 404) return { data: def, sha: null }; throw e; }
}
const putJson = (env, path, data, sha, msg) => gh(env, path, "PUT", { message: msg, content: strToB64(JSON.stringify(data, null, 2)), sha: sha || undefined });
async function edit(env, path, def, msg, fn) {
  for (let i = 0; i < 3; i++) {
    const { data, sha } = await getJson(env, path, def);
    const out = fn(data);
    try { await putJson(env, path, data, sha, msg); return out; }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw new Error("Конфликт версий, повторите действие");
}
async function uploadPhoto(env, m) {
  const fid = m.photo[m.photo.length - 1].file_id;
  const f = await tg(env, "getFile", { file_id: fid });
  if (!f.ok) throw new Error("не удалось получить фото");
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  const path = `images/${Date.now()}.jpg`;
  await gh(env, path, "PUT", { message: "Add photo", content: b64FromBytes(new Uint8Array(await r.arrayBuffer())) });
  return path;
}
const loadMenu = async (env) => (await getJson(env, "menu.json", { items: [], categories: [] })).data;

/* ---------- Тексты ---------- */
const HELP = `🍗 ZZ - Food — управление

Пользуйтесь кнопками внизу:
➕ Добавить блюдо — бот спросит всё по шагам
📋 Блюда — список; нажмите на блюдо, чтобы изменить цену, фото или удалить

Цены в сомони. Сайт обновляется через 1–2 минуты после изменения.`;

const fld = (t, k) => { const r = (t || "").match(new RegExp("^" + k + ": (.*)$", "m")); return r ? r[1].trim() : null; };
const addCard = (f) => "🍽 Новое блюдо\n" + [["Название", f.name], ["Описание", f.desc], ["Цена", f.price != null ? f.price + " сом." : null], ["Категория", f.cat]]
  .filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join("\n");
const readCard = (t) => ({
  name: fld(t, "Название"), desc: (fld(t, "Описание") || "—") === "—" ? "" : fld(t, "Описание"),
  price: parseFloat(fld(t, "Цена")), cat: (fld(t, "Категория") || "").match(/\[([^\]]+)\]$/)?.[1],
});
const itemText = (it, cats) => `№${it.id} · ${it.name}\n${it.desc || ""}\n\nЦена: ${it.price} сом.\nКатегория: ${cats.find((c) => c.id === it.cat)?.name || it.cat}`;
const parsePrice = (s) => parseFloat(String(s || "").replace(",", "."));

function listMarkup(items) {
  return { inline_keyboard: items.map((i) => [B(`${i.name} — ${i.price} сом.`, "it:" + i.id, "primary")]) };
}
const itemMarkup = (id) => ({ inline_keyboard: [
  [B("💰 Изменить цену", "pr:" + id, "primary"), B("🖼 Сменить фото", "ph:" + id, "primary")],
  [B("🗑 Удалить", "del:" + id, "danger")],
  [B("⬅️ К списку", "ls")],
] });

async function showList(env, chat, messageId) {
  const d = await loadMenu(env);
  const text = d.items.length ? "📋 Блюда (нажмите, чтобы изменить):" : "Меню пустое. Нажмите «➕ Добавить блюдо».";
  if (messageId) return tg(env, "editMessageText", { chat_id: chat, message_id: messageId, text, reply_markup: listMarkup(d.items) });
  return say(env, chat, text, listMarkup(d.items));
}

/* ---------- Сообщения ---------- */
async function onReply(env, m, t) {
  const chat = m.chat.id, txt = (m.text || "").trim(), hasPhoto = Array.isArray(m.photo) && m.photo.length;

  if (t.includes("➡️ Название блюда?")) {
    if (!txt) return ask(env, chat, t, "Название");
    return ask(env, chat, addCard({ name: txt }) + "\n\n➡️ Описание? (напишите - чтобы пропустить)", "Описание");
  }
  if (t.includes("➡️ Описание?")) {
    const c = readCard(t);
    return ask(env, chat, addCard({ name: c.name, desc: !txt || txt === "-" ? "—" : txt }) + "\n\n➡️ Цена в сомони?", "Например: 55");
  }
  if (t.includes("➡️ Цена в сомони?")) {
    const price = parsePrice(txt);
    if (isNaN(price) || price < 0) return ask(env, chat, t, "Только число, например 55");
    const c = readCard(t), d = await loadMenu(env);
    return tg(env, "sendMessage", { chat_id: chat,
      text: addCard({ name: c.name, desc: c.desc || "—", price }) + "\n\n➡️ Выберите категорию:",
      reply_markup: { inline_keyboard: d.categories.filter((x) => x.id !== "all").map((x) => [B(x.name, "ac:" + x.id, "primary")]) } });
  }
  if (t.includes("➡️ Отправьте фото блюда")) {
    const c = readCard(t);
    if (!hasPhoto && txt !== "-") return ask(env, chat, t, "Фото или -");
    const photo = hasPhoto ? await uploadPhoto(env, m) : null;
    const it = await edit(env, "menu.json", null, "Add item via bot", (d) => {
      const cat = d.categories.find((x) => x.id === c.cat);
      const item = { id: Math.max(0, ...d.items.map((x) => x.id)) + 1, cat: c.cat, name: c.name, desc: c.desc, price: c.price, img: photo || cat?.img || "" };
      d.items.push(item); return item;
    });
    return say(env, chat, `✅ Добавлено: №${it.id} ${it.name} — ${it.price} сом.\nСайт обновится через 1–2 минуты.`);
  }
  if (t.includes("➡️ Новая цена")) {
    const id = t.match(/№(\d+)/)?.[1], price = parsePrice(txt);
    if (isNaN(price) || price < 0) return ask(env, chat, t, "Только число, например 55");
    const name = await edit(env, "menu.json", null, "Change price via bot", (d) => {
      const it = d.items.find((x) => x.id == id); if (!it) throw new Error("Нет блюда №" + id);
      it.price = price; return it.name;
    });
    return say(env, chat, `✅ ${name}: теперь ${price} сом.\nСайт обновится через 1–2 минуты.`);
  }
  if (t.includes("➡️ Отправьте новое фото")) {
    const id = t.match(/№(\d+)/)?.[1];
    if (!hasPhoto) return ask(env, chat, t, "Отправьте фото");
    const photo = await uploadPhoto(env, m);
    const name = await edit(env, "menu.json", null, "Change photo via bot", (d) => {
      const it = d.items.find((x) => x.id == id); if (!it) throw new Error("Нет блюда №" + id);
      it.img = photo; return it.name;
    });
    return say(env, chat, `✅ Фото обновлено: ${name}\nСайт обновится через 1–2 минуты.`);
  }
  return null;
}

async function onMessage(env, m) {
  const chat = m.chat.id;
  if (!isAdmin(env, m.from.id)) return tg(env, "sendMessage", { chat_id: chat, text: "⛔ Нет доступа" });
  const text = (m.text || m.caption || "").trim();

  if (m.reply_to_message?.text) {
    const done = await onReply(env, m, m.reply_to_message.text);
    if (done !== null) return done;
  }
  if (text === "➕ Добавить блюдо") return ask(env, chat, "🍽 Новое блюдо\n\n➡️ Название блюда?", "Название");
  if (text === "📋 Блюда") return showList(env, chat);
  if (text === "❓ Помощь" || text.startsWith("/start") || text.startsWith("/help")) return say(env, chat, HELP);
  if (text.startsWith("/add")) return say(env, chat, "Теперь всё делается кнопками: нажмите «➕ Добавить блюдо».");
  return say(env, chat, "Выберите действие кнопками внизу 👇");
}

/* ---------- Кнопки (callback) ---------- */
async function onCallback(env, q) {
  const answer = (text, alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });
  if (!isAdmin(env, q.from.id)) return answer("Нет доступа", true);
  const [act, arg] = (q.data || "").split(":");
  const chat = q.message.chat.id, mid = q.message.message_id, orig = q.message.text || "";
  const editMsg = (text, markup) => tg(env, "editMessageText", { chat_id: chat, message_id: mid, text, ...(markup ? { reply_markup: markup } : {}) });

  // Управление меню
  if (act === "ls") { await answer(); return showList(env, chat, mid); }
  if (act === "it") {
    const d = await loadMenu(env), it = d.items.find((x) => x.id == arg);
    if (!it) return answer("Блюдо не найдено", true);
    await answer(); return editMsg(itemText(it, d.categories), itemMarkup(it.id));
  }
  if (act === "pr" || act === "ph") {
    const d = await loadMenu(env), it = d.items.find((x) => x.id == arg);
    if (!it) return answer("Блюдо не найдено", true);
    await answer();
    return act === "pr"
      ? ask(env, chat, `💰 №${it.id} · ${it.name}\nСейчас: ${it.price} сом.\n\n➡️ Новая цена в сомони?`, "Например: 55")
      : ask(env, chat, `🖼 №${it.id} · ${it.name}\n\n➡️ Отправьте новое фото`, "Отправьте фото");
  }
  if (act === "del") {
    const d = await loadMenu(env), it = d.items.find((x) => x.id == arg);
    if (!it) return answer("Блюдо не найдено", true);
    await answer();
    return editMsg(`Удалить «${it.name}»?`, { inline_keyboard: [[B("✅ Да, удалить", "dy:" + it.id, "danger"), B("Отмена", "it:" + it.id)]] });
  }
  if (act === "dy") {
    const name = await edit(env, "menu.json", null, "Delete item via bot", (d) => {
      const it = d.items.find((x) => x.id == arg); if (!it) throw new Error("Нет блюда №" + arg);
      d.items = d.items.filter((x) => x.id != arg); return it.name;
    });
    await answer("Удалено");
    return editMsg(`🗑 Удалено: ${name}\nСайт обновится через 1–2 минуты.`, { inline_keyboard: [[B("⬅️ К списку", "ls")]] });
  }
  if (act === "ac") {
    const d = await loadMenu(env), cat = d.categories.find((x) => x.id === arg), c = readCard(orig);
    if (!cat) return answer("Категория не найдена", true);
    await answer();
    const card = addCard({ name: c.name, desc: c.desc || "—", price: c.price, cat: `${cat.name} [${cat.id}]` });
    await editMsg(card);
    return ask(env, chat, card + "\n\n➡️ Отправьте фото блюда (или напишите - если без фото)", "Фото или -");
  }

  // Заказы и отзывы
  let status, toast;
  if (act === "rv") {
    if (arg === "ok") {
      const m = orig.match(/Блюдо #(\d+)[^\n]*\nОценка: (\d)\/5\nИмя: ([^\n]*)\nТекст: ([\s\S]*?)(\n\n(✅|❌)[\s\S]*)?$/);
      if (!m) return answer("Не разобрал отзыв", true);
      try {
        await edit(env, "reviews.json", [], "Add review", (r) => { r.push({ item: +m[1], stars: +m[2], name: m[3], text: m[4].trim(), date: new Date().toISOString().slice(0, 10) }); });
      } catch (e) { return answer("Ошибка: " + e.message, true); }
      status = "✅ ОПУБЛИКОВАН"; toast = "Отзыв опубликован";
    } else { status = "❌ ОТКЛОНЁН"; toast = "Отзыв отклонён"; }
  } else if (act === "ok" || act === "no") {
    const acc = act === "ok";
    status = acc ? "✅ Статус: ПРИНЯТ" : "❌ Статус: ОТКЛОНЁН"; toast = acc ? "Заказ принят" : "Заказ отклонён";
  } else return answer();
  const base = orig.replace(/\n*(⏳|✅|❌) Статус[\s\S]*$/, "");
  await editMsg(base + "\n\n" + status);
  return answer(toast);
}

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("ZZ - Food bot OK");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    const u = await req.json();
    try {
      if (u.callback_query) await onCallback(env, u.callback_query);
      else if (u.message) await onMessage(env, u.message);
    } catch (e) {
      const chat = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
      if (chat) await tg(env, "sendMessage", { chat_id: chat, text: "⚠️ Ошибка: " + e.message });
    }
    return new Response("ok");
  },
};
