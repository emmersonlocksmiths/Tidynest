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
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const webpush = require("web-push");
const crypto = require("crypto");
const { changeNotices, dueNotices, alertAt, DUE_WINDOW_MS } = require("./logic");

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
