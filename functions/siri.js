// TidyNest and Siri: working out what someone said to their "TidyNest" Shortcut, and what to say back.
// Everything here is plain logic with no Firebase in it (the Firebase side is in index.js), so it can be checked
// on its own. Times are Brisbane time (no daylight saving, so always UTC+10).
//
// What it understands (with or without "please", in any capitals):
//   what's on today / tomorrow / on Friday / this week          -> reads out what's on
//   add milk and bread to the shopping list                      -> adds to a list
//   remind me to put the bins out tonight at 6                   -> a reminder (for me; "remind us" is for both)
//   add event dentist on Friday at 3:30                          -> an event on the calendar
//   countdown to Christmas on the 25th of December               -> a countdown timer

const OFFSET = 10 * 3600000;   // Brisbane
const DAY = 86400000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIndex = word => MONTHS.findIndex(m => m.startsWith(word.toLowerCase().slice(0, 3)));
const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, "forty five": 45, "forty-five": 45, half: 0.5 };
const num = w => (w in WORD_NUMBERS ? WORD_NUMBERS[w] : Number(w));

// Brisbane's calendar date for a moment, and the moment for a Brisbane date and time
const parts = ms => { const d = new Date(ms + OFFSET); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() }; };
const at = (y, m, d, h = 0, min = 0) => Date.UTC(y, m, d, h, min) - OFFSET;
const startOfDay = ms => { const p = parts(ms); return at(p.y, p.m, p.d); };

const tidy = s => s.replace(/\s+/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
// Everything's matched in lower case; this puts back the capitals that were said ("call Mum", not "call mum").
let original = "";
function asSaid(piece) {
  const at = original.toLowerCase().indexOf(piece.toLowerCase());
  return capital(at >= 0 && piece ? original.slice(at, at + piece.length) : piece);
}

// Pulls a day and a time out of what was said. Returns { date (ms, or null), timed, rest } where `rest` is
// what's left once the when-words are taken out (the title).
function parseWhen(input, now) {
  let text = " " + input.toLowerCase() + " ";
  const cut = re => { const m = text.match(re); if (m) text = text.replace(m[0], " "); return m; };
  const today = parts(now);
  let day = null;            // ms at Brisbane midnight
  let hour = null, minute = 0, ampm = null, part = null;   // part of day: morning / afternoon / evening

  // "in 20 minutes", "in 2 hours", "in half an hour", "in 3 days", "in 2 weeks"
  let m = cut(/\bin (a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty[ -]five|half an?|\d+(?:\.\d+)?) (minutes?|mins?|hours?|hrs?|days?|weeks?)\b/);
  if (m) {
    const n = m[1].startsWith("half") ? 0.5 : num(m[1]);
    const unit = m[2];
    if (/^(min|hour|hr)/.test(unit)) {
      const t = now + n * (unit.startsWith("min") ? 60000 : 3600000);
      return { date: Math.round(t / 60000) * 60000, timed: true, rest: tidy(text) };
    }
    day = startOfDay(now + n * (unit.startsWith("week") ? 7 : 1) * DAY);
  }

  // times: "at 6", "6pm", "at 6:30 pm", "18:30", "noon", "midnight"
  m = cut(/\b(?:at )?(noon|midday|midnight)\b/);
  if (m) { hour = m[1] === "midnight" ? 0 : 12; ampm = "set"; }
  if (hour === null) {
    m = cut(/\b(?:at )?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)(?=\W)/);
    if (!m) m = cut(/\bat (\d{1,2})(?:[:.](\d{2}))?\b/);
    if (!m) m = cut(/\b(\d{1,2})[:.](\d{2})\b/);
    if (m) {
      hour = Number(m[1]); minute = Number(m[2] || 0);
      const suffix = (m[3] || "").replace(/\./g, "");
      if (suffix === "pm" && hour < 12) hour += 12;
      if (suffix === "am" && hour === 12) hour = 0;
      if (suffix === "am" || suffix === "pm" || hour > 12) ampm = "set";
    }
  }

  // days
  if (cut(/\b(?:the )?day after tomorrow\b/)) day = startOfDay(now + 2 * DAY);
  m = cut(/\btomorrow(?: (morning|afternoon|evening|night|arvo))?\b/);
  if (m) { day = startOfDay(now + DAY); part = m[1] || part; }
  m = cut(/\b(?:this )?(morning|afternoon|arvo|evening)\b/);
  if (m) part = m[1];
  if (cut(/\btonight\b/)) { day = day ?? startOfDay(now); part = "evening"; }
  if (cut(/\btoday\b/)) day = day ?? startOfDay(now);
  if (cut(/\bnext week\b/)) day = startOfDay(now + ((8 - today.wd) % 7 || 7) * DAY);   // Monday next week
  m = cut(new RegExp(`\\b(?:on |this |next |coming )?(${WEEKDAYS.join("|")}|mon|tues?|wed|thur?s?|fri|sat|sun)(?: (morning|afternoon|evening|night|arvo))?\\b`));
  if (m) {
    const wd = WEEKDAYS.findIndex(w => w.startsWith(m[1].slice(0, 3)));
    let ahead = (wd - today.wd + 7) % 7;
    if (ahead === 0) ahead = 7;                                // "Friday" said on a Friday means next Friday
    if (/\bnext /.test(m[0]) && ahead < 7 && wd !== 0 && today.wd !== 0 && ahead <= (7 - today.wd)) ahead += 7;   // "next Friday" = the one in next week
    day = startOfDay(now + ahead * DAY);
    if (m[2]) part = m[2];
  }
  // "on the 5th", "the 25th of December", "5 November", "November 5th", "5/11"
  const dateFrom = (d, mo, y) => {
    let year = y ?? today.y;
    let ms = at(year, mo, d);
    if (y == null && ms < startOfDay(now)) ms = at(year + 1, mo, d);   // a date that's been this year means next year
    return ms;
  };
  m = cut(new RegExp(`\\b(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}(?: (\\d{4}))?\\b`));
  if (m) day = dateFrom(Number(m[1]), monthIndex(m[2]), m[3] ? Number(m[3]) : null);
  if (!m) {
    m = cut(new RegExp(`\\b(?:on )?${MONTH_RE} (?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`));
    if (m) day = dateFrom(Number(m[2]), monthIndex(m[1]), m[3] ? Number(m[3]) : null);
  }
  if (!m) {
    m = cut(/\b(?:on )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) day = dateFrom(Number(m[1]), Number(m[2]) - 1, m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null);
  }
  if (!m) {
    m = cut(/\bon the (\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) {
      const d = Number(m[1]);
      let ms = at(today.y, today.m, d);
      if (ms < startOfDay(now)) ms = at(today.y, today.m + 1, d);
      day = ms;
    }
  }

  // a part of the day with no time gives it one; a time with no am/pm takes the likely half of the day
  if (hour === null && part) hour = { morning: 9, afternoon: 15, arvo: 15, evening: 18, night: 19 }[part];
  else if (hour !== null && ampm !== "set") {
    if (part && part !== "morning" && hour < 12) hour += 12;
    else if (!part && hour >= 1 && hour <= 6) hour += 12;     // "at 6" is 6 pm, "at 9" is 9 am
  }

  const rest = tidy(text.replace(/\b(on|at|by|for)\s*$/, "")).replace(/\s+(on|at|by)$/, "");
  if (hour === null) return { date: day, timed: false, rest };
  let base = day ?? startOfDay(now);
  let t = base + (hour * 60 + minute) * 60000;
  if (day === null && t <= now) {
    // just a time: later today, or else tomorrow (or this evening, for "at 9" said at 10 am)
    if (ampm !== "set" && hour < 12 && t + 12 * 3600000 > now) t += 12 * 3600000;
    else t += DAY;
  }
  return { date: t, timed: true, rest };
}

// how a moment is said out loud: "today at 6 pm", "tomorrow at 9:30 am", "on Friday at 3 pm", "on Thursday 12 November"
function sayWhen(ms, timed, now) {
  const p = parts(ms), days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  const weekday = capital(WEEKDAYS[p.wd]);
  const dayWords = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 && days < 7 ? `on ${weekday}` : `on ${weekday} ${p.d} ${capital(MONTHS[p.m])}`;
  if (!timed) return dayWords;
  const h12 = p.h % 12 || 12, mins = p.min ? `:${String(p.min).padStart(2, "0")}` : "";
  const time = p.h === 0 && !p.min ? "midnight" : p.h === 12 && !p.min ? "midday" : `${h12}${mins} ${p.h < 12 ? "am" : "pm"}`;
  return `${dayWords} at ${time}`;
}
const sayTime = ms => { const p = parts(ms), h12 = p.h % 12 || 12; return `${h12}${p.min ? ":" + String(p.min).padStart(2, "0") : ""} ${p.h < 12 ? "am" : "pm"}`; };

function listOf(words) {
  return words.length < 2 ? words[0] || "" : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// who it's for: "remind us", "for both of us", "for Larissa"
function whoFrom(text, uid, household) {
  const members = (household && household.members) || [uid];
  const names = (household && household.memberNames) || {};
  if (/\b(remind us|for us|for both of us|for both|for everyone|for all of us)\b/.test(text)) return { who: members, text: text.replace(/\b(for us|for both of us|for both|for everyone|for all of us)\b/, " ") };
  for (const m of members) {
    const name = String(names[m] || "").trim().toLowerCase();
    if (!name) continue;
    const re = new RegExp(`\\b(?:for|remind) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(text)) return { who: [m], text: text.replace(new RegExp(`\\bfor ${name}\\b`), " ") };
  }
  return { who: [uid], text };
}

// What to do with what was said. Returns one of:
//   { kind: "agenda", from, to, label }
//   { kind: "list", list (the category), entries: [title…] }  /  { kind: "say", text } (nothing to do but answer)
//   { kind: "item", item: {…fields}, say }
function understand(raw, { uid, household, now = Date.now(), listName = "" }) {
  const said = tidy(String(raw || "").replace(/[“”"]/g, ""));
  original = said;
  let text = said.toLowerCase().replace(/^(hey |ok |okay )?(tidy ?nest[,:]?\s*)/, "").replace(/^(please|can you|could you|would you)\s+/, "").replace(/[.!?]+$/, "").replace(/\bplease\b/g, "").trim();
  const lists = ((household && household.reminderCategories) || []).filter(c => c && c.kind === "list" && (c.shared !== false || c.owner === uid));
  const findList = name => {
    const want = String(name || "").toLowerCase().replace(/\b(the|my|our|list)\b/g, "").trim();
    if (!want) return null;
    return lists.find(c => c.name.toLowerCase().trim() === want) || lists.find(c => c.name.toLowerCase().includes(want) || want.includes(c.name.toLowerCase()));
  };
  const listNames = () => listOf(lists.map(c => c.name));
  const help = "You can say things like: add milk to the shopping list. Remind me to put the bins out tonight at 6. Add event dentist on Friday at 3. Or, what's on tomorrow?";
  if (!text) return { kind: "say", text: "I didn't hear anything. " + help };

  // a Shortcut made for one list ("Add to shopping list") sends just the things to add
  if (listName) {
    const list = findList(listName);
    if (!list) return { kind: "say", text: `I couldn't find a list called ${listName}.${lists.length ? ` Your lists are ${listNames()}.` : ""}` };
    return { kind: "list", list, entries: splitEntries(text.replace(/^(add|put|get|buy)\s+/, "")) };
  }

  // what's on
  if (/\b(what'?s|what is|whats|anything|what have (we|i) got|what do (we|i) have)\b.*\b(on|happening|planned|today|tomorrow|week|coming up)\b/.test(text) || /^(my |our )?(day|agenda|schedule)\b/.test(text)) {
    if (/\b(this week|the week|week ahead|coming up)\b/.test(text)) {
      const from = startOfDay(now);
      return { kind: "agenda", from, to: from + 7 * DAY, label: "this week", week: true };
    }
    const w = parseWhen(text.replace(/\b(what'?s|what is|whats|on|happening|planned|anything)\b/g, " "), now);
    const from = w.date != null ? startOfDay(w.date) : startOfDay(now);
    return { kind: "agenda", from, to: from + DAY, label: sayWhen(from, false, now) };
  }

  // lists: "add milk and eggs to the shopping list", "put bread on shopping", "shopping list: milk"
  let m = text.match(/^(?:add|put|get|buy|we need|i need)\s+(.+?)\s+(?:to|on|onto|in|into)\s+(?:the\s+|my\s+|our\s+)?(.+?)(?:\s+list)?$/);
  let list = m && findList(m[2]);
  if (m && !list && /\blist$/.test(text)) return { kind: "say", text: `I couldn't find a list called ${m[2]}.${lists.length ? ` Your lists are ${listNames()}.` : ""}` };
  if (!m || !list) {
    const m2 = text.match(/^(.+?)\s+list[:,]?\s+(?:add\s+)?(.+)$/);
    if (m2 && findList(m2[1])) { m = [null, m2[2]]; list = findList(m2[1]); }
  }
  if (list && m && !/\b(calendar|event)\b/.test(m[2] || "")) return { kind: "list", list, entries: splitEntries(m[1]) };

  const { who, text: rest0 } = whoFrom(text, uid, household);
  const shared = who.length > 1 || who[0] !== uid || true;   // things added by voice are shared, like the app's default

  // countdowns: "countdown to Christmas on 25 December", "start a timer for the holiday on the 5th of January"
  m = rest0.match(/^(?:start|add|make|set up|set|create|new)?\s*(?:a\s+|an\s+|new\s+)?(?:countdown|count down|timer)\s+(?:to|for|until|till|til)\s+(.+)$/);
  if (m) {
    const w = parseWhen(m[1], now);
    const title = asSaid(w.rest || "Countdown");
    if (w.date == null || w.date <= now) return { kind: "say", text: `When is ${title}? Try: countdown to ${title} on the 25th of December.` };
    return {
      kind: "item", say: `Countdown to ${title} added, ${sayWhen(w.date, w.timed, now)}.`,
      item: { title, type: "timer", timerMode: "down", date: new Date(w.date).toISOString(), notes: "", location: "", assignedTo: who, shared }
    };
  }

  // events: "add event dentist on Friday at 3", "put footy training on the calendar tomorrow at 5", "book the plumber for Monday at 8"
  m = rest0.match(/^(?:add|new|create|put|make|book|schedule)\s+(?:an?\s+|the\s+)?(?:event|appointment)\s*[:,-]?\s*(?:for\s+|called\s+)?(.+)$/)
    || rest0.match(/^(?:add|put)\s+(.+?)\s+(?:to|on|in|into)\s+(?:the\s+|our\s+|my\s+)?calendar\b\s*(.*)$/)
    || rest0.match(/^(?:new\s+)?(?:event|appointment)\s*[:,-]?\s*(.+)$/);
  if (m) {
    const w = parseWhen([m[1], m[2] || ""].join(" "), now);
    const title = asSaid(w.rest || "Event");
    if (w.date == null) return { kind: "say", text: `When is ${title}? Try: add event ${title} on Friday at 3.` };
    const start = w.timed ? w.date : startOfDay(w.date);
    const end = w.timed ? start + 3600000 : start + DAY - 60000;
    return {
      kind: "item", say: `Added ${title}, ${sayWhen(start, w.timed, now)}.`,
      item: { title, type: "calendar", date: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: !w.timed, alert: w.timed ? 0 : false, notes: "", location: "", assignedTo: who, shared }
    };
  }

  // reminders: "remind me to put the bins out tonight at 6", "reminder to call Mum tomorrow", "remind us to pay the rates on the 15th"
  m = rest0.match(/^remind\s+(?:me|us|\w+)\s+(?:to\s+|about\s+|that\s+)?(.+)$/)
    || rest0.match(/^(?:add|set|create|make|new)?\s*(?:a\s+|an\s+)?reminder\s*(?:to\s+|for\s+|about\s+|that\s+|[:,-]\s*)?(.+)$/)
    || rest0.match(/^(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+|our\s+|the\s+)?reminders$/);
  if (m) {
    const w = parseWhen(m[1], now);
    const title = asSaid(w.rest.replace(/^(to|about)\s+/, "") || "Reminder");
    const when = w.date == null ? null : w.timed ? w.date : startOfDay(w.date);
    const forWho = who.length > 1 ? " for both of you" : who[0] !== uid ? ` for ${(household.memberNames || {})[who[0]] || "them"}` : "";
    return {
      kind: "item", say: `Reminder added${forWho}: ${title}${when == null ? "" : ", " + sayWhen(when, w.timed, now)}.`,
      item: { title, type: "reminder", date: when == null ? "" : new Date(when).toISOString(), allDay: when != null && !w.timed, alert: when != null && w.timed ? 0 : false, category: "", offCalendar: false, notes: "", location: "", assignedTo: who, shared }
    };
  }

  return { kind: "say", text: "Sorry, I didn't catch that. " + help };
}

function splitEntries(text) {
  return text.split(/\s*,\s*|\s+and\s+|\s*&\s*|\s+plus\s+/).map(s => s.replace(/^(some|a|an|more)\s+/, "").trim()).filter(Boolean).map(asSaid).slice(0, 20);
}

// What's on, read out: today's (or that day's) events and reminders in time order, then all-day things,
// and overdue reminders when it's today.
function agendaText(plan, items, uid, now) {
  const mine = items.filter(i => !i.listItem && (i.shared || i.createdBy === uid));
  const inRange = mine.filter(i => {
    if (!i.date || (i.type === "reminder" && i.done)) return false;
    if (i.type === "timer") return false;
    const t = Date.parse(i.date), e = i.end ? Date.parse(i.end) : t;
    return t < plan.to && Math.max(e, t) >= plan.from && !(i.type === "reminder" && t < plan.from);
  }).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const overdue = plan.from === startOfDay(now)
    ? mine.filter(i => i.type === "reminder" && !i.done && i.date && Date.parse(i.date) < startOfDay(now)) : [];
  const describe = i => {
    const t = Date.parse(i.date);
    if (plan.week) return `${sayWhen(Math.max(t, plan.from), !i.allDay, now).replace(/^on /, "")}, ${i.title}`;
    return i.allDay || t < plan.from ? `${i.title}, all day` : `${sayTime(t)}, ${i.title}`;
  };
  const timed = inRange.filter(i => !i.allDay), allDay = inRange.filter(i => i.allDay);
  const ordered = plan.week ? inRange : [...allDay, ...timed];
  let out = !ordered.length ? `Nothing's on ${plan.label}.` : `${capital(plan.label)}, you've got ${ordered.length === 1 ? "one thing" : ordered.length + " things"}. ${ordered.slice(0, 12).map(describe).join(". ")}.`;
  if (ordered.length > 12) out += ` And ${ordered.length - 12} more.`;
  if (overdue.length) out += ` ${overdue.length === 1 ? "One reminder is" : overdue.length + " reminders are"} overdue: ${listOf(overdue.slice(0, 5).map(i => i.title))}.`;
  return out;
}

module.exports = { understand, parseWhen, sayWhen, agendaText, splitEntries, startOfDay };
