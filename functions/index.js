// TidyNest's push notifications. These run on Firebase (not on the phones), so a notification arrives
// even when TidyNest is closed:
//  - sendNews: when someone adds, changes or writes about a shared item, the others get a notification.
//  - sendDue:  every minute, anything whose alert time has come (a reminder, an event starting or about to,
//              a countdown finishing) sends an alert to whoever it's for.
// Each item's alert time is worked out here whenever it's saved, and kept on it as `alertAt`, so the every-minute
// check only has to look up what's due.
// The phones that get them are the ones where "Phone notifications" was turned on in Settings; each one is
// saved under households/{id}/push. The keys that sign the notifications are made here the first time and
// kept in the database (config/pushPrivate, which the app can't read; config/push holds the public half).

const { setGlobalOptions, logger } = require("firebase-functions");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const webpush = require("web-push");
const crypto = require("crypto");
const { changeNotices, dueNotices, alertAt, DUE_WINDOW_MS } = require("./logic");
const siri = require("./siri");

// The functions have to run where the database is; the deploy works that out and puts it in .env.
setGlobalOptions({ region: process.env.TIDYNEST_REGION || "us-central1", maxInstances: 2, memory: "256MiB" });

initializeApp();
const db = getFirestore();
const SITE = "https://emmersonlocksmiths.github.io/home-sort/";

let keys = null;
async function signingKeys() {
  if (keys) return keys;
  const privateRef = db.doc("config/pushPrivate");
  keys = await db.runTransaction(async tx => {
    const saved = await tx.get(privateRef);
    if (saved.exists) return saved.data();
    const made = webpush.generateVAPIDKeys();
    tx.set(privateRef, { publicKey: made.publicKey, privateKey: made.privateKey, createdAt: FieldValue.serverTimestamp() });
    tx.set(db.doc("config/push"), { publicKey: made.publicKey });
    return made;
  });
  return keys;
}

// Each piece of news goes to each person once: the first send writes a marker, and a second try finds it.
async function firstTime(key) {
  const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 40);
  try {
    await db.doc("pushSent/" + id).create({ key, at: FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    if (e.code === 6) return false;   // already sent
    throw e;
  }
}

async function sendTo(hid, uid, message) {
  const { publicKey, privateKey } = await signingKeys();
  const phones = await db.collection(`households/${hid}/push`).where("uid", "==", uid).get();
  await Promise.all(phones.docs.map(async phone => {
    const { endpoint, keys: subKeys } = phone.data();
    try {
      await webpush.sendNotification({ endpoint, keys: subKeys }, JSON.stringify(message), {
        vapidDetails: { subject: SITE, publicKey, privateKey }, TTL: 6 * 60 * 60, urgency: "high"
      });
    } catch (e) {
      // the phone has switched notifications off, or TidyNest was removed from it: forget it
      if (e.statusCode === 404 || e.statusCode === 410) await phone.ref.delete();
      else logger.warn("push failed", { status: e.statusCode, body: e.body });
    }
  }));
}

async function deliver(hid, notices) {
  for (const n of notices) {
    if (await firstTime(n.key)) await sendTo(hid, n.uid, n.message);
  }
}

exports.sendNews = onDocumentWritten("households/{hid}/items/{itemId}", async event => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  // keep its alert time up to date (writing it sets this off again, but then nothing's changed)
  const at = alertAt(after);
  const iso = at === null ? null : new Date(at).toISOString();
  if ((after.alertAt ?? null) !== iso || !("alertAt" in after)) {
    await event.data.after.ref.update({ alertAt: iso }).catch(e => logger.warn("couldn't save the alert time", e.message));   // (gone already)
  }
  if (!after.shared) return;
  const house = await db.doc("households/" + event.params.hid).get();
  if (!house.exists) return;
  await deliver(event.params.hid, changeNotices(event.params.hid, event.params.itemId, before, after, house.data()));
});

exports.sendDue = onSchedule({ schedule: "every 1 minutes", timeZone: "Australia/Brisbane", retryCount: 0 }, async () => {
  const now = Date.now();
  await signingKeys();   // (the first run after setting up makes the keys, so phones can sign up)
  const houses = await db.collection("households").get();
  for (const house of houses.docs) {
    const from = new Date(now - DUE_WINDOW_MS).toISOString(), to = new Date(now).toISOString();
    const items = house.ref.collection("items");
    // what's due by its alert time, plus anything saved before alert times were worked out (none of those alert early)
    const [due, older] = await Promise.all([
      items.where("alertAt", ">=", from).where("alertAt", "<=", to).get(),
      items.where("date", ">=", from).where("date", "<=", to).get()
    ]);
    const found = [...due.docs, ...older.docs.filter(d => !("alertAt" in d.data()))];
    if (!found.length) continue;
    await deliver(house.id, dueNotices(house.id, found.map(d => ({ id: d.id, data: d.data() })), house.data(), now));
  }
  // once an hour, clear out the markers of what's been sent, after a few days
  if (new Date(now).getUTCMinutes() === 0) {
    const old = await db.collection("pushSent").where("at", "<", new Date(now - 3 * 86400000)).limit(400).get();
    if (!old.empty) {
      const batch = db.batch();
      old.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }
});

// Siri. Each person's "TidyNest" Shortcut sends what they said here, with their private Siri link (?k=…), and
// speaks whatever comes back. The link's key is made in the app's Settings; only a fingerprint of it is kept
// (siriKeys/{sha-256 of the key}: who it belongs to and their household), so the key itself is never stored.
// Anything added here is just like adding it in the app: it shows on both phones and sends the other person a
// notification (through sendNews).
exports.siri = onRequest({ cors: false, timeoutSeconds: 20, invoker: "public" }, async (req, res) => {
  const reply = text => res.status(200).set("Content-Type", "text/plain; charset=utf-8").send(text);
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = { text: body }; } }
    body = body && typeof body === "object" ? body : {};
    const key = String(req.query.k || body.key || "");
    const text = String(body.text ?? req.query.text ?? "").slice(0, 500);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) return reply("This Siri link isn't right. Copy it again from TidyNest's Settings, under Siri.");
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const found = await db.doc("siriKeys/" + hash).get();
    if (!found.exists) return reply("This Siri link isn't working any more. Make a new one in TidyNest's Settings, under Siri.");
    const { uid, hid } = found.data();
    const house = await db.doc("households/" + hid).get();
    if (!house.exists || !(house.data().members || []).includes(uid)) return reply("You're not in that household any more, so I can't add anything.");
    const household = house.data();
    const now = Date.now();
    const myName = (household.memberNames || {})[uid] || "Someone";
    const items = db.collection(`households/${hid}/items`);
    const plan = siri.understand(text, { uid, household, now, listName: String(body.list || req.query.list || "") });

    if (plan.kind === "say") return reply(plan.text);

    if (plan.kind === "agenda") {
      const got = await items.where("date", ">=", new Date(siri.startOfDay(now) - 60 * 86400000).toISOString()).where("date", "<", new Date(plan.to).toISOString()).get();
      return reply(siri.agendaText(plan, got.docs.map(d => d.data()), uid, now));
    }

    if (plan.kind === "list") {
      if (!plan.entries.length) return reply(`What should I add to ${plan.list.name}?`);
      const there = (await items.where("category", "==", plan.list.id).get()).docs.filter(d => d.data().listItem);
      const added = [], already = [];
      const batch = db.batch();
      let order = Date.now();
      for (const title of plan.entries) {
        const same = there.filter(d => String(d.data().title || "").trim().toLowerCase() === title.toLowerCase());
        const live = same.find(d => !d.data().done && !d.data().cleared);
        if (live) { already.push(title); continue; }
        const back = same.find(d => d.data().cleared) || same.find(d => d.data().done);
        if (back) batch.update(back.ref, { done: false, cleared: false, doneBy: null, doneAt: null, listOrder: order++, updatedAt: FieldValue.serverTimestamp() });
        else batch.set(items.doc(), {
          title, type: "reminder", listItem: true, category: plan.list.id, date: "", notes: "", location: "", allDay: false, offCalendar: true,
          shared: plan.list.shared !== false, assignedTo: [uid], done: false, cleared: false, listOrder: order++,
          createdBy: uid, createdByName: myName, createdByEmail: "", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), comments: [], ackBy: []
        });
        added.push(title);
      }
      if (added.length) await batch.commit();
      const join = a => a.length < 2 ? a[0] : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
      return reply([added.length ? `Added ${join(added)} to ${plan.list.name}.` : "", already.length ? `${join(already)} ${already.length === 1 ? "is" : "are"} already on ${plan.list.name}.` : ""].filter(Boolean).join(" "));
    }

    if (plan.kind === "item") {
      const members = household.members || [uid];
      const item = { ...plan.item, assignedTo: plan.item.assignedTo.filter(m => members.includes(m)) };
      if (!item.assignedTo.length) item.assignedTo = [uid];
      await items.doc().set({
        ...item, done: false, createdBy: uid, createdByName: myName, createdByEmail: "",
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), comments: []
      });
      return reply(plan.say);
    }
    return reply("Sorry, something went wrong.");
  } catch (e) {
    logger.error("siri failed", e);
    return reply("Sorry, TidyNest couldn't do that just now. Try again in a moment.");
  }
});
