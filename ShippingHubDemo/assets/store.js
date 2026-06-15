// In-browser "backend": a localStorage-backed store that plays the role of the
// Express API + PostgreSQL. It enforces the same invariants as the real thing —
// append-only tracking events and ledger, idempotent money movements, and
// state-machine-validated transitions — but everything lives in the visitor's
// browser. No network, no server, no shared data between devices.

import { buildTrackingCode, canTransition, computeQuote } from "./domain.js";
import { buildSeed, ORIGIN } from "./seed.js";

const DB_KEY = "shippinghub.demo.v1";
const SESSION_KEY = "shippinghub.demo.session";
const LOCALE_KEY = "shippinghub.demo.locale";

let db = null;
let seq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function persist() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

/** Load the demo database, seeding it on first run. */
export function init() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    db = raw ? JSON.parse(raw) : buildSeed();
  } catch {
    db = buildSeed();
  }
  if (!localStorage.getItem(DB_KEY)) persist();
}

export function resetDemo() {
  db = buildSeed();
  persist();
  localStorage.removeItem(SESSION_KEY);
}

/* ----------------------------------------------------------- locale ------- */

export function getLocale() {
  return localStorage.getItem(LOCALE_KEY) || "es";
}
export function setLocale(locale) {
  localStorage.setItem(LOCALE_KEY, locale);
}

/* ------------------------------------------------------------ auth -------- */

export function currentUser() {
  const id = localStorage.getItem(SESSION_KEY);
  return id ? db.users.find((u) => u.id === id) ?? null : null;
}

export function login(email, password) {
  const user = db.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!user || user.password !== password) return { error: "invalid_credentials" };
  localStorage.setItem(SESSION_KEY, user.id);
  return { user };
}

export function register(name, email, password) {
  const clean = String(email).trim().toLowerCase();
  if (!name || !clean || !password) return { error: "required" };
  if (password.length < 8) return { error: "weak_password" };
  if (db.users.some((u) => u.email.toLowerCase() === clean)) return { error: "email_taken" };
  const user = { id: uid("usr"), email: clean, name: String(name).trim(), role: "CUSTOMER", password };
  db.users.push(user);
  persist();
  localStorage.setItem(SESSION_KEY, user.id);
  return { user };
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
}

export function isStaff(user) {
  return !!user && (user.role === "ADMIN" || user.role === "COURIER");
}

/* -------------------------------------------------------- shipments ------- */

export function trackByCode(code) {
  const wanted = String(code).trim().toUpperCase();
  return db.shipments.find((s) => s.trackingCode === wanted) ?? null;
}

export function getById(id) {
  return db.shipments.find((s) => s.id === id) ?? null;
}

export function userById(id) {
  return db.users.find((u) => u.id === id) ?? null;
}

function sortByCreatedDesc(list) {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listForUser(userId, status) {
  let list = db.shipments.filter((s) => s.userId === userId);
  if (status) list = list.filter((s) => s.status === status);
  return sortByCreatedDesc(list);
}

export function allShipments(status) {
  const list = status ? db.shipments.filter((s) => s.status === status) : db.shipments;
  return sortByCreatedDesc(list);
}

/** Create a shipment for the current user (CREATED + first tracking event). */
export function createShipment(input) {
  const user = currentUser();
  if (!user) return { error: "unauthorized" };

  db.counter.shipment += 1;
  const trackingCode = buildTrackingCode(new Date().getUTCFullYear(), db.counter.shipment);
  const quote = computeQuote({
    destinationCountry: input.destination.country,
    weightGrams: input.weightGrams,
    lengthCm: input.lengthCm,
    widthCm: input.widthCm,
    heightCm: input.heightCm,
    serviceLevel: input.serviceLevel,
  });
  const now = new Date().toISOString();
  const shipment = {
    id: uid("shp"), trackingCode, userId: user.id,
    serviceLevel: input.serviceLevel, status: "CREATED",
    weightGrams: input.weightGrams, lengthCm: input.lengthCm, widthCm: input.widthCm, heightCm: input.heightCm,
    priceCents: quote.priceCents, currency: "USD", zoneCode: quote.zoneCode,
    estimatedDeliveryAt: quote.estimatedDeliveryAt.toISOString(), createdAt: now,
    originAddress: { ...ORIGIN }, destinationAddress: { ...input.destination },
    events: [{ id: uid("evt"), status: "CREATED", location: `${ORIGIN.city}, ${ORIGIN.country}`, description: "Shipment created", occurredAt: now }],
  };
  db.shipments.push(shipment);
  persist();
  return { shipment };
}

/** Append a tracking event (staff), validated against the state machine. */
export function addEvent(shipmentId, { status, location, description }) {
  const shipment = getById(shipmentId);
  if (!shipment) return { error: "not_found" };
  if (!canTransition(shipment.status, status)) return { error: "invalid_transition" };
  shipment.events.push({
    id: uid("evt"), status, location: location || "", description: description || "",
    occurredAt: new Date().toISOString(),
  });
  shipment.status = status; // shipment.status tracks the latest event; events stay append-only
  persist();
  return { shipment };
}

/* --------------------------------------------------------- wallet --------- */

export function ledgerForUser(userId) {
  return db.ledger
    .filter((e) => e.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function balanceForUser(userId) {
  return db.ledger.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.amountCents, 0);
}

function findByKey(userId, idempotencyKey) {
  return db.ledger.find((e) => e.userId === userId && e.idempotencyKey === idempotencyKey) ?? null;
}

/** Add funds to the current user's wallet (idempotent by key). */
export function topUp(amountCents, idempotencyKey) {
  const user = currentUser();
  if (!user) return { error: "unauthorized" };
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { error: "invalid_amount" };
  const existing = findByKey(user.id, idempotencyKey);
  if (existing) return { entry: existing }; // double-click safe
  const entry = {
    id: uid("led"), userId: user.id, kind: "TOPUP", amountCents: Math.round(amountCents),
    shipmentId: null, idempotencyKey, createdAt: new Date().toISOString(),
  };
  db.ledger.push(entry);
  persist();
  return { entry };
}

/** Pay for a shipment's label from the wallet (CREATED -> LABEL_PAID). */
export function payLabel(shipmentId, idempotencyKey) {
  const user = currentUser();
  if (!user) return { error: "unauthorized" };
  const shipment = getById(shipmentId);
  if (!shipment || shipment.userId !== user.id) return { error: "not_found" };

  // Idempotent: a replay with the same key returns the original result.
  const existing = findByKey(user.id, idempotencyKey);
  if (existing) return { shipment };

  if (shipment.status !== "CREATED") return { error: "not_payable" };
  const amount = shipment.priceCents;
  if (balanceForUser(user.id) < amount) return { error: "insufficient_funds" };

  db.ledger.push({
    id: uid("led"), userId: user.id, kind: "PAYMENT", amountCents: -amount,
    shipmentId: shipment.id, idempotencyKey, createdAt: new Date().toISOString(),
  });
  shipment.events.push({
    id: uid("evt"), status: "LABEL_PAID", location: `${ORIGIN.city}, ${ORIGIN.country}`,
    description: "Label paid", occurredAt: new Date().toISOString(),
  });
  shipment.status = "LABEL_PAID";
  persist();
  return { shipment };
}

export function newIdempotencyKey() {
  return uid("idem");
}
