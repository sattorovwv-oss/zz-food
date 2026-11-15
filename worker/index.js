// Cloudflare Worker: Telegram webhook для ZZ - Food.
// Кнопки заказов/отзывов + управление меню прямо из бота. Работает 24/7.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64FromBytes = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const strToB64 = (s) => b64FromBytes(enc.encode(s));
const b64ToStr = (b) => dec.decode(Uint8Array.from(atob(b.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const say = (env, chat, text) => tg(env, "sendMessage", { chat_id: chat, text });

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

// Изменить файл JSON с повтором при конфликте версий
async function edit(env, path, def, msg, fn) {
  for (let i = 0; i < 3; i++) {
    const { data, sha } = await getJson(env, path, def);
    const out = fn(data);
    try { await putJson(env, path, data, sha, msg); return out; }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw new Error("Конфликт версий, повторите команду");
}

const HELP = `🍗 ZZ - Food — управление

/list — список блюд
/cats — категории
/add Название | Описание | Цена | Категория
  (можно отправить ФОТО с этой подписью — фото станет картинкой блюда)
/price 5 120 — поставить цену 120 сом. блюду №5
/del 5 — удалить блюдо №5
/photo 5 — подпись к фото: заменить фото блюда №5

Пример:
/add Чикен бургер | Сыр, салат, соус | 55 | burgers

Цены в сомони. Сайт обновляется через 1–2 минуты.`;

async function uploadPhoto(env, m) {
  const fid = m.photo[m.photo.length - 1].file_id;
  const f = await tg(env, "getFile", { file_id: fid });
  if (!f.ok) throw new Error("не удалось получить фото");
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  const path = `images/${Date.now()}.jpg`;
  await gh(env, path, "PUT", { message: "Add photo", content: b64FromBytes(new Uint8Array(await r.arrayBuffer())) });
  return path;
}

async function onMessage(env, m) {
  const chat = m.chat.id;
  if (String(m.from.id) !== String(env.ADMIN_CHAT_ID)) return say(env, chat, "⛔ Нет доступа");
  const text = (m.text || m.caption || "").trim();
  const first = text.split(/\s+/)[0] || "";
  const cmd = first.toLowerCase().replace(/@.*/, "");
  const rest = text.slice(first.length).trim();
  const hasPhoto = Array.isArray(m.photo) && m.photo.length;

  if (cmd === "/start" || cmd === "/help" || (!cmd && !hasPhoto)) return say(env, chat, HELP);

  if (cmd === "/list") {
    const { data } = await getJson(env, "menu.json", { items: [] });
    return say(env, chat, data.items.length ? data.items.map((i) => `${i.id}. ${i.name} — ${i.price} сом. (${i.cat})`).join("\n") : "Меню пустое");
  }
  if (cmd === "/cats") {
    const { data } = await getJson(env, "menu.json", { categories: [] });
    return say(env, chat, data.categories.filter((c) => c.id !== "all").map((c) => `${c.id} — ${c.name}`).join("\n"));
  }
  if (cmd === "/add") {
    const p = rest.split("|").map((s) => s.trim());
    const price = parseFloat((p[2] || "").replace(",", "."));
    if (!p[0] || isNaN(price) || !p[3]) return say(env, chat, "Формат:\n/add Название | Описание | Цена | Категория\n\nКатегории: /cats");
    const photo = hasPhoto ? await uploadPhoto(env, m) : null;
    const item = await edit(env, "menu.json", null, "Add item via bot", (d) => {
      const key = p[3].toLowerCase();
      const c = d.categories.find((c) => c.id !== "all" && (c.id.toLowerCase() === key || c.name.toLowerCase() === key));
      if (!c) throw new Error("Нет такой категории. Список: /cats");
      const it = { id: Math.max(0, ...d.items.map((x) => x.id)) + 1, cat: c.id, name: p[0], desc: p[1], price, img: photo || c.img };
      d.items.push(it);
      return it;
    });
    return say(env, chat, `✅ Добавлено: №${item.id} ${item.name} — ${item.price} сом.${photo ? "" : "\n(без фото; чтобы поставить своё — отправьте фото с подписью /photo " + item.id + ")"}\nСайт обновится через 1–2 минуты.`);
  }
  if (cmd === "/price") {
    const [id, pr] = rest.split(/\s+/);
    const price = parseFloat((pr || "").replace(",", "."));
    if (!id || isNaN(price)) return say(env, chat, "Формат: /price 5 120");
    const name = await edit(env, "menu.json", null, "Change price via bot", (d) => {
      const it = d.items.find((x) => x.id == id); if (!it) throw new Error("Нет блюда №" + id);
      it.price = price; return it.name;
    });
    return say(env, chat, `✅ ${name}: теперь ${price} сом.\nСайт обновится через 1–2 минуты.`);
  }
  if (cmd === "/del") {
    if (!rest) return say(env, chat, "Формат: /del 5");
    const name = await edit(env, "menu.json", null, "Delete item via bot", (d) => {
      const it = d.items.find((x) => x.id == rest); if (!it) throw new Error("Нет блюда №" + rest);
      d.items = d.items.filter((x) => x.id != rest); return it.name;
    });
    return say(env, chat, `🗑 Удалено: ${name}\nСайт обновится через 1–2 минуты.`);
  }
  if (cmd === "/photo") {
    if (!hasPhoto || !rest) return say(env, chat, "Отправьте фото с подписью: /photo 5");
    const photo = await uploadPhoto(env, m);
    const name = await edit(env, "menu.json", null, "Change photo via bot", (d) => {
      const it = d.items.find((x) => x.id == rest); if (!it) throw new Error("Нет блюда №" + rest);
      it.img = photo; return it.name;
    });
    return say(env, chat, `✅ Фото обновлено: ${name}\nСайт обновится через 1–2 минуты.`);
  }
  if (hasPhoto) return say(env, chat, "Добавьте подпись к фото:\n/add Название | Описание | Цена | Категория\nили /photo 5");
  return say(env, chat, "Не понял команду. /help");
}

async function onCallback(env, q) {
  const answer = (text, alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });
  if (String(q.from.id) !== String(env.ADMIN_CHAT_ID)) return answer("Нет доступа", true);
  const [act, id] = (q.data || "").split(":");
  const orig = q.message.text || "";
  let status, toast;
  if (act === "rv") {
    if (id === "ok") {
      const m = orig.match(/Блюдо #(\d+)[^\n]*\nОценка: (\d)\/5\nИмя: ([^\n]*)\nТекст: ([\s\S]*?)(\n\n(✅|❌)[\s\S]*)?$/);
      if (!m) return answer("Не разобрал отзыв", true);
      try {
        await edit(env, "reviews.json", [], "Add review", (r) => { r.push({ item: +m[1], stars: +m[2], name: m[3], text: m[4].trim(), date: new Date().toISOString().slice(0, 10) }); });
      } catch (e) { return answer("Ошибка: " + e.message, true); }
      status = "✅ ОПУБЛИКОВАН"; toast = "Отзыв опубликован";
    } else { status = "❌ ОТКЛОНЁН"; toast = "Отзыв отклонён"; }
  } else {
    const acc = act === "ok";
    status = acc ? "✅ Статус: ПРИНЯТ" : "❌ Статус: ОТКЛОНЁН"; toast = acc ? "Заказ принят" : "Заказ отклонён";
  }
  const base = orig.replace(/\n*(⏳|✅|❌) Статус[\s\S]*$/, "");
  await tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: base + "\n\n" + status });
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
      if (chat) await say(env, chat, "⚠️ Ошибка: " + e.message);
    }
    return new Response("ok");
  },
};
