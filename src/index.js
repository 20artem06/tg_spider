// Бот для спортивного челленджа: 2 участника, минимум 5 отчётов (фото/видео/кружок) в неделю.
// Хранилище — Cloudflare KV (binding STATE). Неделя: Пн–Вс, часовой пояс Europe/Moscow.

const TZ = "Europe/Moscow";
const NEED_PER_WEEK = 5;
const WEEK_LEN = 7;

// ---------- Telegram API ----------

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram API error", method, data);
  }
  return data;
}

function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mentionHtml(p) {
  return `<a href="tg://user?id=${p.id}">${escapeHtml(p.name)}</a>`;
}

// ---------- Дата/неделя (Europe/Moscow) ----------

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function todayStr(now = new Date()) {
  return dateFmt.format(now); // "YYYY-MM-DD" в московской дате
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`); // midday UTC, чтобы не ловить сдвиги дат
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayIndex(dateStr) {
  // Пн=0 ... Вс=6
  const d = new Date(`${dateStr}T12:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

function mondayOf(dateStr) {
  return addDays(dateStr, -weekdayIndex(dateStr));
}

function weekDates(mondayStr) {
  return Array.from({ length: WEEK_LEN }, (_, i) => addDays(mondayStr, i));
}

function formatRuDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}`;
}

// ---------- KV helpers ----------

async function getJSON(env, key, fallback) {
  const v = await env.STATE.get(key);
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function putJSON(env, key, value) {
  return env.STATE.put(key, JSON.stringify(value));
}

async function getChatId(env) {
  return env.STATE.get("chat_id");
}

async function bindChat(env, chatId) {
  const existing = await getChatId(env);
  if (!existing) {
    await env.STATE.put("chat_id", String(chatId));
    return String(chatId);
  }
  return existing;
}

async function getParticipants(env) {
  return getJSON(env, "participants", []);
}

async function addParticipant(env, user) {
  const list = await getParticipants(env);
  if (list.some((p) => p.id === user.id)) return { list, added: false, alreadyIn: true };
  if (list.length >= 2) return { list, added: false, full: true };
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Участник";
  list.push({ id: user.id, name });
  await putJSON(env, "participants", list);
  return { list, added: true };
}

async function isDone(env, userId, dateStr) {
  return (await env.STATE.get(`done:${userId}:${dateStr}`)) === "1";
}

async function markDone(env, userId, dateStr) {
  const key = `done:${userId}:${dateStr}`;
  const existing = await env.STATE.get(key);
  if (existing === "1") return false;
  await env.STATE.put(key, "1");
  const stats = await getStats(env, userId);
  stats.totalDays += 1;
  await putJSON(env, `stats:${userId}`, stats);
  return true;
}

async function getStats(env, userId) {
  return getJSON(env, `stats:${userId}`, {
    totalDays: 0,
    weeksPlayed: 0,
    weeksWon: 0,
    currentStreak: 0,
    bestStreak: 0,
  });
}

// ---------- Логика недели ----------

async function weekCountFor(env, userId, dates) {
  let count = 0;
  for (const d of dates) {
    if (await isDone(env, userId, d)) count += 1;
  }
  return count;
}

async function buildWeekGrid(env, participant, dates, today) {
  let grid = "";
  let count = 0;
  for (const d of dates) {
    if (await isDone(env, participant.id, d)) {
      grid += "✅";
      count += 1;
    } else if (d === today) {
      grid += "⏳";
    } else if (d < today) {
      grid += "❌";
    } else {
      grid += "⬜";
    }
  }
  return { grid, count };
}

// ---------- Обработка сообщений ----------

function commandName(text) {
  if (!text || !text.startsWith("/")) return null;
  return text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}

function hasReportMedia(msg) {
  return Boolean(
    msg.photo ||
      msg.video ||
      msg.video_note ||
      (msg.document && /^(image|video)\//.test(msg.document.mime_type || ""))
  );
}

const HELP_TEXT = [
  "🏋️ <b>Спортивный челлендж</b>",
  "",
  "Правила: минимум 5 отчётов (фото или кружок/видео со спортплощадки) в неделю (Пн–Вс).",
  "Отчёт засчитывается автоматически, как только участник присылает в группу фото или видео/кружок.",
  "",
  "Команды:",
  "/join — стать участником челленджа (нужно 2 человека)",
  "/participants — список участников",
  "/week — прогресс за текущую неделю",
  "/stats — общая статистика",
  "/help — это сообщение",
].join("\n");

async function handleMessage(env, msg) {
  const chat = msg.chat;
  const from = msg.from;
  if (!from || from.is_bot) return;

  if (chat.type === "private") {
    if (commandName(msg.text) === "/start" || commandName(msg.text) === "/help") {
      await sendMessage(env, chat.id, HELP_TEXT + "\n\nДобавь меня в группу с другом, чтобы начать.");
    }
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const boundChatId = await bindChat(env, chat.id);
  if (String(chat.id) !== String(boundChatId)) return; // бот привязан к другой группе

  const cmd = commandName(msg.text);

  if (cmd === "/start" || cmd === "/help") {
    await sendMessage(env, chat.id, HELP_TEXT);
    return;
  }

  if (cmd === "/join") {
    const { added, alreadyIn, full, list } = await addParticipant(env, from);
    if (alreadyIn) {
      await sendMessage(env, chat.id, "Ты уже участвуешь в челлендже 👍");
    } else if (full) {
      await sendMessage(env, chat.id, "Уже набрано 2 участника, больше мест нет.");
    } else if (added) {
      const namesLeft = 2 - list.length;
      await sendMessage(
        env,
        chat.id,
        `✅ ${escapeHtml(list[list.length - 1].name)} присоединил(ась)ся к челленджу!` +
          (namesLeft > 0 ? `\nЖдём ещё ${namesLeft} участника (/join).` : `\n🔥 Оба участника на месте, погнали!`)
      );
    }
    return;
  }

  if (cmd === "/participants") {
    const list = await getParticipants(env);
    if (list.length === 0) {
      await sendMessage(env, chat.id, "Пока никто не присоединился. Используйте /join.");
    } else {
      await sendMessage(env, chat.id, "Участники:\n" + list.map((p) => "• " + mentionHtml(p)).join("\n"));
    }
    return;
  }

  if (cmd === "/week" || cmd === "/status") {
    await sendWeekStatus(env, chat.id);
    return;
  }

  if (cmd === "/stats") {
    await sendStats(env, chat.id);
    return;
  }

  if (!msg.text && hasReportMedia(msg)) {
    const participants = await getParticipants(env);
    const participant = participants.find((p) => p.id === from.id);
    if (!participant) return; // не зарегистрирован в челлендже

    const today = todayStr();
    const marked = await markDone(env, participant.id, today);
    if (!marked) return; // на сегодня уже засчитано

    const monday = mondayOf(today);
    const dates = weekDates(monday);
    const count = await weekCountFor(env, participant.id, dates);
    const statusLine =
      count >= NEED_PER_WEEK
        ? "✅ норма на эту неделю уже выполнена!"
        : `нужно ещё ${NEED_PER_WEEK - count} до нормы (${NEED_PER_WEEK}/${WEEK_LEN})`;

    await sendMessage(
      env,
      chat.id,
      `📸 Отчёт засчитан для ${mentionHtml(participant)} (${formatRuDate(today)})!\nНеделя: ${count}/${WEEK_LEN}, ${statusLine}`
    );
  }
}

async function sendWeekStatus(env, chatId) {
  const participants = await getParticipants(env);
  if (participants.length === 0) {
    await sendMessage(env, chatId, "Пока никто не присоединился. Используйте /join.");
    return;
  }
  const today = todayStr();
  const monday = mondayOf(today);
  const dates = weekDates(monday);
  const sunday = dates[dates.length - 1];

  let text = `📅 <b>Неделя ${formatRuDate(monday)}–${formatRuDate(sunday)}</b> (нужно ≥${NEED_PER_WEEK}/${WEEK_LEN})\n\n`;
  for (const p of participants) {
    const { grid, count } = await buildWeekGrid(env, p, dates, today);
    const mark = count >= NEED_PER_WEEK ? "✅" : "⏳";
    text += `${mentionHtml(p)}: ${grid}  ${count}/${WEEK_LEN} ${mark}\n`;
  }
  text += "\nПн Вт Ср Чт Пт Сб Вс";
  await sendMessage(env, chatId, text);
}

async function sendStats(env, chatId) {
  const participants = await getParticipants(env);
  if (participants.length === 0) {
    await sendMessage(env, chatId, "Пока никто не присоединился. Используйте /join.");
    return;
  }
  let text = "📊 <b>Общая статистика</b>\n\n";
  for (const p of participants) {
    const s = await getStats(env, p.id);
    const weeksLost = s.weeksPlayed - s.weeksWon;
    text +=
      `${mentionHtml(p)}\n` +
      `  Всего отчётов: ${s.totalDays}\n` +
      `  Недель сыграно: ${s.weeksPlayed} (выиграно ${s.weeksWon} / проиграно ${weeksLost})\n` +
      `  Текущая серия побед: ${s.currentStreak} (лучшая: ${s.bestStreak})\n\n`;
  }
  await sendMessage(env, chatId, text.trim());
}

// ---------- Cron ----------

async function handleDailyReminder(env) {
  const chatId = await getChatId(env);
  const participants = await getParticipants(env);
  if (!chatId || participants.length === 0) return;

  const today = todayStr();
  const pending = [];
  for (const p of participants) {
    if (!(await isDone(env, p.id, today))) pending.push(p);
  }
  if (pending.length === 0) return;

  const text = `⏰ Напоминание: сегодня ещё нет отчёта у ${pending.map(mentionHtml).join(", ")}. Не забудьте скинуть фото/кружок!`;
  await sendMessage(env, chatId, text);
}

async function handleWeeklySummary(env) {
  const chatId = await getChatId(env);
  const participants = await getParticipants(env);
  if (!chatId || participants.length === 0) return;

  const today = todayStr();
  const monday = mondayOf(today);
  const weekKey = `weekresult:${monday}`;

  const already = await env.STATE.get(weekKey);
  if (already) return; // эта неделя уже подведена

  const dates = weekDates(monday);
  const sunday = dates[dates.length - 1];

  const results = [];
  for (const p of participants) {
    const count = await weekCountFor(env, p.id, dates);
    const passed = count >= NEED_PER_WEEK;
    results.push({ p, count, passed });

    const stats = await getStats(env, p.id);
    stats.weeksPlayed += 1;
    if (passed) {
      stats.weeksWon += 1;
      stats.currentStreak += 1;
      stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
    } else {
      stats.currentStreak = 0;
    }
    await putJSON(env, `stats:${p.id}`, stats);
  }

  await env.STATE.put(weekKey, JSON.stringify(results.map((r) => ({ id: r.p.id, count: r.count, passed: r.passed }))));

  let text = `🏁 <b>Итоги недели ${formatRuDate(monday)}–${formatRuDate(sunday)}</b>\n\n`;
  for (const r of results) {
    text += `${mentionHtml(r.p)}: ${r.count}/${WEEK_LEN} ${r.passed ? "✅" : "❌"}\n`;
  }
  const losers = results.filter((r) => !r.passed);
  if (losers.length === 0) {
    text += "\n🎉 Оба выполнили норму на этой неделе!";
  } else {
    text += "\n" + losers.map((r) => `💀 ${mentionHtml(r.p)} проиграл(а) на этой неделе!`).join("\n");
  }
  await sendMessage(env, chatId, text);
}

// ---------- Worker entrypoints ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (header !== env.WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      if (update.message) {
        try {
          await handleMessage(env, update.message);
        } catch (err) {
          console.error("handleMessage error", err);
        }
      }
      return new Response("OK");
    }

    if (url.pathname === "/") {
      return new Response("Sport challenge bot is running.");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "0 18 * * *") {
      ctx.waitUntil(handleDailyReminder(env));
    } else if (event.cron === "0 19 * * 0") {
      ctx.waitUntil(handleWeeklySummary(env));
    }
  },
};
