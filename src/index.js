// Бот для спортивного челленджа: 2 участника, минимум 5 отчётов (фото/видео/кружок) в неделю.
// Хранилище — Cloudflare KV (binding STATE). Неделя: Пн–Вс, часовой пояс Europe/Moscow.

const TZ = "Europe/Moscow";
const NEED_PER_WEEK = 5;
const WEEK_LEN = 7;

// Челлендж начался в четверг 13.08.2026, поэтому первая неделя неполная:
// в ней всего 4 дня (Чт–Вс) и норма пропорционально меньше — 3 отчёта.
const CHALLENGE_START = "2026-08-13";

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

// Постоянная клавиатура: висит снизу, чтобы не набирать команды руками.
const BTN_WEEK = "📅 Неделя";
const BTN_MONTH = "📆 Месяц";
const BTN_STATS = "📊 Статистика";
const BTN_HELP = "❓ Помощь";

const KEYBOARD = {
  keyboard: [
    [{ text: BTN_WEEK }, { text: BTN_MONTH }],
    [{ text: BTN_STATS }, { text: BTN_HELP }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: KEYBOARD,
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

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function monthOf(dateStr) {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

function monthTitle(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${dateStr.slice(0, 7)}-${String(days).padStart(2, "0")}`;
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

async function unmarkDone(env, userId, dateStr) {
  const key = `done:${userId}:${dateStr}`;
  if ((await env.STATE.get(key)) !== "1") return false;
  await env.STATE.delete(key);
  const stats = await getStats(env, userId);
  stats.totalDays = Math.max(0, stats.totalDays - 1);
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

// Дни недели, которые входят в челлендж (на первой неделе их меньше семи).
function activeDates(dates) {
  return dates.filter((d) => d >= CHALLENGE_START);
}

// Норма недели: на полной — 5, на неполной — пропорционально числу её дней.
function requiredForWeek(mondayStr) {
  const active = activeDates(weekDates(mondayStr)).length;
  if (active >= WEEK_LEN) return NEED_PER_WEEK;
  return Math.max(1, Math.ceil((active * NEED_PER_WEEK) / WEEK_LEN));
}

async function buildWeekGrid(env, participant, dates, today) {
  let grid = "";
  let count = 0;
  for (const d of dates) {
    if (d < CHALLENGE_START) {
      grid += "▫️"; // до старта челленджа
    } else if (await isDone(env, participant.id, d)) {
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

// Нажатие кнопки приходит обычным текстом — сводим его к соответствующей команде.
const BUTTON_COMMANDS = {
  [BTN_WEEK]: "/week",
  [BTN_MONTH]: "/month",
  [BTN_STATS]: "/stats",
  [BTN_HELP]: "/help",
};

// Принимает "13.08", "13.8.2026" или "2026-08-13" и возвращает "YYYY-MM-DD".
function parseDateArg(text, today) {
  const arg = (text || "").trim().split(/\s+/)[1];
  if (!arg) return null;

  let iso = null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(arg);
  if (m) {
    iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  } else if ((m = /^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/.exec(arg))) {
    let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    if (year < 100) year += 2000;
    iso = `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if (!iso) return null;

  // Отсекаем несуществующие даты вроде 31.02.
  const d = new Date(`${iso}T12:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
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
  "На неполной первой неделе (старт 13.08) норма меньше — 3 отчёта из 4 дней.",
  "",
  "Внизу есть кнопки — статистику можно смотреть ими, команды набирать не обязательно.",
  "",
  "Команды:",
  "/join — стать участником челленджа (нужно 2 человека)",
  "/participants — список участников",
  "/week — прогресс за текущую неделю",
  "/month — статистика за текущий месяц по неделям",
  "/stats — общая статистика за всё время",
  "/mark 13.08 — отметить прошедший день (если бот тогда не работал)",
  "/unmark 13.08 — снять отметку",
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

  const cmd = BUTTON_COMMANDS[(msg.text || "").trim()] || commandName(msg.text);

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

  if (cmd === "/month") {
    await sendMonthStatus(env, chat.id);
    return;
  }

  if (cmd === "/mark" || cmd === "/unmark") {
    await handleManualMark(env, chat.id, from, msg.text, cmd === "/unmark");
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
    const need = requiredForWeek(monday);
    const statusLine =
      count >= need
        ? "✅ норма на эту неделю уже выполнена!"
        : `нужно ещё ${need - count} до нормы (${need} из ${activeDates(dates).length})`;

    await sendMessage(
      env,
      chat.id,
      `📸 Отчёт засчитан для ${mentionHtml(participant)} (${formatRuDate(today)})!\nНеделя: ${count}, ${statusLine}`
    );
  }
}

// Отметить (или снять) день задним числом — например, если бот тогда ещё не работал.
async function handleManualMark(env, chatId, from, text, removing) {
  const participants = await getParticipants(env);
  const participant = participants.find((p) => p.id === from.id);
  if (!participant) {
    await sendMessage(env, chatId, "Сначала присоединись к челленджу: /join");
    return;
  }

  const today = todayStr();
  const date = parseDateArg(text, today);
  if (!date) {
    await sendMessage(
      env,
      chatId,
      `Укажи дату: <code>${removing ? "/unmark" : "/mark"} 13.08</code>`
    );
    return;
  }
  if (date > today) {
    await sendMessage(env, chatId, "Будущие дни отмечать нельзя 🙂");
    return;
  }
  if (date < CHALLENGE_START) {
    await sendMessage(
      env,
      chatId,
      `Челлендж начался ${formatRuDate(CHALLENGE_START)}, более ранние дни не считаются.`
    );
    return;
  }

  const changed = removing
    ? await unmarkDone(env, participant.id, date)
    : await markDone(env, participant.id, date);

  if (!changed) {
    await sendMessage(
      env,
      chatId,
      removing
        ? `У ${escapeHtml(participant.name)} за ${formatRuDate(date)} отметки и не было.`
        : `${formatRuDate(date)} у ${escapeHtml(participant.name)} уже отмечен ✅`
    );
    return;
  }

  const monday = mondayOf(date);
  const count = await weekCountFor(env, participant.id, weekDates(monday));
  const need = requiredForWeek(monday);
  await sendMessage(
    env,
    chatId,
    `${removing ? "🗑 Отметка снята" : "✅ День отмечен"}: ${formatRuDate(date)}, ${mentionHtml(participant)}\n` +
      `Та неделя: ${count}/${need} до нормы`
  );
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

  const need = requiredForWeek(monday);
  const total = activeDates(dates).length;

  let text = `📅 <b>Неделя ${formatRuDate(monday)}–${formatRuDate(sunday)}</b> (нужно ≥${need} из ${total})\n\n`;
  for (const p of participants) {
    const { grid, count } = await buildWeekGrid(env, p, dates, today);
    const mark = count >= need ? "✅" : "⏳";
    text += `${mentionHtml(p)}: ${grid}  ${count}/${total} ${mark}\n`;
  }
  text += "\nПн Вт Ср Чт Пт Сб Вс";
  await sendMessage(env, chatId, text);
}

async function sendMonthStatus(env, chatId) {
  const participants = await getParticipants(env);
  if (participants.length === 0) {
    await sendMessage(env, chatId, "Пока никто не присоединился. Используйте /join.");
    return;
  }
  const today = todayStr();
  const month = monthOf(today);
  const monthEnd = lastDayOfMonth(today);

  // Недели (Пн–Вс), которые пересекаются с этим месяцем, уже начались и входят в челлендж.
  const weeks = [];
  let monday = mondayOf(`${month}-01`);
  while (monday <= monthEnd && monday <= today) {
    if (activeDates(weekDates(monday)).length > 0) weeks.push(monday);
    monday = addDays(monday, 7);
  }

  let text = `📆 <b>${monthTitle(today)}</b>\n`;
  for (const p of participants) {
    let monthCount = 0;
    let weeksPassed = 0;
    let rows = "";

    for (const weekStart of weeks) {
      const dates = weekDates(weekStart);
      const { grid, count } = await buildWeekGrid(env, p, dates, today);
      for (const d of dates) {
        if (monthOf(d) === month && (await isDone(env, p.id, d))) monthCount += 1;
      }

      const need = requiredForWeek(weekStart);
      const done = count >= need;
      if (done) weeksPassed += 1;
      const isCurrent = weekStart === mondayOf(today);
      const mark = done ? "✅" : isCurrent ? "⏳" : "❌";
      rows += `${formatRuDate(weekStart)}–${formatRuDate(dates[6])}  ${grid}  ${count}/${activeDates(dates).length} (нужно ${need}) ${mark}\n`;
    }

    text += `\n<b>${escapeHtml(p.name)}</b> — ${monthCount} отчётов за месяц, норма выполнена в ${weeksPassed} из ${weeks.length} недель\n${rows}`;
  }
  text += "\nПн Вт Ср Чт Пт Сб Вс — порядок дней в строке";
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

  const need = requiredForWeek(monday);
  const total = activeDates(dates).length;
  if (total === 0) return; // неделя целиком до старта челленджа

  const results = [];
  for (const p of participants) {
    const count = await weekCountFor(env, p.id, dates);
    const passed = count >= need;
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

  let text = `🏁 <b>Итоги недели ${formatRuDate(monday)}–${formatRuDate(sunday)}</b> (нужно ≥${need} из ${total})\n\n`;
  for (const r of results) {
    text += `${mentionHtml(r.p)}: ${r.count}/${total} ${r.passed ? "✅" : "❌"}\n`;
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
    // Воскресный триггер (19:00 UTC) подводит итоги недели, ежедневный (18:00 UTC) напоминает.
    if (event.cron.startsWith("0 19")) {
      ctx.waitUntil(handleWeeklySummary(env));
    } else {
      ctx.waitUntil(handleDailyReminder(env));
    }
  },
};
