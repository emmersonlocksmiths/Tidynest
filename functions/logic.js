// TidyNest push notifications: deciding who gets told what.
// Everything in here is plain logic with no Firebase in it, so it can be checked on its own.
// It follows the app: the bell on someone's phone lists the shared things another person added, changed or
// wrote about that they haven't acknowledged yet. A push goes out at the moment one lands in their bell,
// and again for each new message or change after that.

const TIME_ZONE = "Australia/Brisbane";
const DUE_WINDOW_MS = 15 * 60 * 1000;   // a due alert can still go out up to 15 minutes late (same as the app)

const actorOf = item => (item.lastChange && item.lastChange.by) || item.createdBy;

// Does this item sit in this person's bell?
function needs(item, uid) {
  return !!item.shared && !item.done && !item.listItem && actorOf(item) !== uid
    && !(Array.isArray(item.ackBy) && item.ackBy.includes(uid));
}

// What happened to it last: a new message or change has a new stamp; ticking, acknowledging and tidying don't.
function stampOf(item) {
  const c = item.lastChange;
  if (!c) return "added";
  const at = c.at && typeof c.at.toMillis === "function" ? c.at.toMillis() : c.at && c.at._seconds ? c.at._seconds * 1000 : c.at;
  return [c.kind || "edit", c.by || "", String(at || ""), c.text || "", c.what || ""].join("|");
}

const kindName = type => type === "calendar" ? "an event" : type === "timer" ? "a timer" : "a reminder";

function whenText(iso, allDay) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-AU", { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
  if (allDay) return day;
  const time = new Intl.DateTimeFormat("en-AU", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s/g, " ").toLowerCase();
  return `${day}, ${time}`;
}
const timeText = iso => new Intl.DateTimeFormat("en-AU", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).toLowerCase();

function nameFor(uid, item, household) {
  const c = item.lastChange;
  if (c && c.by === uid && c.byName) return c.byName;
  if (household && household.memberNames && household.memberNames[uid]) return household.memberNames[uid];
  if (item.createdBy === uid && item.createdByName) return item.createdByName;
  return "Someone";
}

// The notification for an item that has just landed in someone's bell (or had something new happen to it).
function changeMessage(item, id, household) {
  const who = nameFor(actorOf(item), item, household);
  const c = item.lastChange;
  const url = "./?item=" + encodeURIComponent(id);
  if (c && c.kind === "chat") return { title: `${who} · ${item.title}`, body: `“${c.text || ""}”`, tag: "chat-" + id, url };
  if (c) return { title: who, body: `Changed ${c.what || "it"}: ${item.title}`, tag: "edit-" + id, url };
  const when = item.date ? whenText(item.date, item.allDay) : "";
  return { title: who, body: `Added ${kindName(item.type)}: ${item.title}${when ? " · " + when : ""}`, tag: "add-" + id, url };
}

// Who to tell after an item was written. `before` is null for a new item; `after` is null when it was deleted.
// Each entry has a `key`: the same news is only ever sent once to a person (a change made to a whole repeating
// series writes to every date in it, but it's one piece of news).
function changeNotices(hid, id, before, after, household) {
  if (!after) return [];
  // A repeat's later dates are written when it's made and topped up now and then: only the first one is news.
  if (!before && after.seriesId && after.seriesId !== id) return [];
  const stamp = stampOf(after);
  if (before && stampOf(before) === stamp) return [];
  const members = (household && household.members) || [];
  const message = changeMessage(after, id, household);
  return members.filter(uid => needs(after, uid)).map(uid => ({
    uid, key: ["news", hid, after.seriesId || id, stamp, uid].join("|"), message
  }));
}

function timerMode(item) {
  if (item.timerMode === "down" || item.timerMode === "up") return item.timerMode;
  const made = item.createdAt && typeof item.createdAt.toMillis === "function" ? item.createdAt.toMillis() : Date.now();
  return new Date(item.date).getTime() > made ? "down" : "up";
}

// Things that sound an alert when their time comes (the same as the app, except that something for a whole day
// doesn't wake anyone at midnight).
function alertable(item) {
  if (item.listItem || item.allDay) return false;
  if (item.type === "reminder") return !item.done;
  if (item.type === "calendar") return true;
  if (item.type === "timer") return timerMode(item) === "down";
  return false;
}

// Who an alert is for: the people it's for if it's shared, otherwise whoever made it.
function ownersOf(item, household) {
  const members = (household && household.members) || [];
  if (!item.shared) return [item.createdBy];
  const picked = [].concat(item.assignedTo || []);
  const owners = members.filter(m => picked.includes(m));
  return owners.length ? owners : [item.createdBy];
}

function dueMessage(item, id) {
  const title = item.type === "reminder" ? "Reminder" : item.type === "timer" ? "Timer finished" : "Starting now";
  return { title, body: `${item.title}, ${timeText(item.date)}`, tag: "due-" + id, url: "./?item=" + encodeURIComponent(id) };
}

// Alerts due now, from one household's items whose time is in the last 15 minutes.
function dueNotices(hid, items, household, now) {
  const out = [];
  for (const { id, data } of items) {
    const t = new Date(data.date).getTime();
    if (!Number.isFinite(t) || t > now || now - t > DUE_WINDOW_MS || !alertable(data)) continue;
    for (const uid of ownersOf(data, household)) {
      out.push({ uid, key: ["due", hid, id, data.date, uid].join("|"), message: dueMessage(data, id) });
    }
  }
  return out;
}

module.exports = { needs, stampOf, changeNotices, dueNotices, alertable, ownersOf, whenText, DUE_WINDOW_MS };
