/**
 * Exit flow (A5 / F-10, decision D4).
 *
 * The customer shows an exit QR; staff of that store scan it, tick every paid
 * line against the bag, and complete the exit. Completing is ONE atomic write
 * that only succeeds while the order has not exited, so a QR works once.
 *
 * Rules (founder decisions, Task 6 checkpoint 1):
 *   - QR content is "DQX1:<exitCode>", a random code only the owner receives.
 *     Orders created before exit codes existed show their raw id; that is
 *     accepted for those orders only, and only once.
 *   - An order with an open flag cannot exit until an admin clears the flag.
 *   - Staff cannot exit their own order; admins can.
 *   - Paid orders nobody exited are never completed automatically. Staff and
 *     admins can exit them from the open-paid-orders list, with a reason, and
 *     that is recorded as a manual exit.
 *
 * Resolvers apply the auth/role/store guards (src/utils/guards.js) before
 * calling in here; every lookup below is additionally store-scoped.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { GraphQLError } = require('graphql');
const Order = require('../models/Order');
const Store = require('../models/Store');

const EXIT_QR_PREFIX = 'DQX1:';
const OPEN_STATUSES = ['pending', 'preparing', 'ready'];
// Orders written before paymentStatus existed have no field; they were paid.
const PAID = { $in: ['success', null] };

const OUTCOME_MESSAGES = {
  OK_TO_EXIT: 'Paid. Check every item, then complete the exit.',
  EXITED: 'Exit complete.',
  ALREADY_EXITED: 'This order has already exited. Do not let the items through on this QR.',
  CANCELLED: 'This order was cancelled.',
  NOT_PAID: 'This order has not been paid.',
  OWN_ORDER: 'You cannot complete the exit for your own order. Ask another staff member or an admin.',
  FLAGGED: 'This order has an open issue. An admin must clear it before the customer can exit.',
  LINES_NOT_VERIFIED: 'Tick every item before completing the exit.',
  NOT_FOUND: 'No paid order for this QR code in your store.',
};

const badInput = (message) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

function newExitCode() {
  return crypto.randomBytes(16).toString('base64url'); // 128 bits, 22 chars
}

/**
 * What the customer's app should render as the exit QR, or null when there is
 * nothing to exit. Pre-cutover orders (no exitCode) fall back to the raw id.
 */
function exitQrFor(order) {
  if (order.exitedAt || !OPEN_STATUSES.includes(order.status)) return null;
  return order.exitCode ? `${EXIT_QR_PREFIX}${order.exitCode}` : order._id.toString();
}

/** Turns a scanned QR into an order filter, or null if it is not an exit QR. */
function filterForScannedCode(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.startsWith(EXIT_QR_PREFIX)) {
    const code = s.slice(EXIT_QR_PREFIX.length);
    return /^[A-Za-z0-9_-]{22}$/.test(code) ? { exitCode: code } : null;
  }
  // Legacy QR: the raw order id. Only for orders that never had an exit code,
  // so the id of a new order (partly predictable) can never stand in for its code.
  if (/^[a-f0-9]{24}$/i.test(s)) return { _id: s, exitCode: null };
  return null;
}

function hasOpenFlag(order) {
  return !!order.flaggedIssue && !order.flaggedIssue.resolvedAt;
}

/**
 * Why this order cannot exit now, or null if it can.
 * A legacy order already set to 'completed' by the old status flow counts as
 * exited: under that flow 'completed' was what let the customer out.
 */
function exitBlocker(order, caller, isAdmin) {
  if (order.exitedAt || order.status === 'completed') return 'ALREADY_EXITED';
  if (order.status === 'cancelled') return 'CANCELLED';
  if ((order.paymentStatus ?? 'success') !== 'success') return 'NOT_PAID';
  if (!isAdmin && order.user && caller?._id && order.user.toString() === caller._id.toString()) return 'OWN_ORDER';
  if (hasOpenFlag(order)) return 'FLAGGED';
  return null;
}

function scoped(filter, storeScope) {
  return storeScope ? { ...filter, storeId: storeScope } : filter;
}

async function withStoreName(order) {
  if (!order) return order;
  const store = await Store.findById(order.storeId);
  order._storeName = store?.name ?? null;
  order._storeCode = store?.storeCode ?? null;
  order._userId = order.user;
  return order;
}

// ExitResult.exitedAt is a GraphQL String: a raw Date would be sent as epoch
// milliseconds ("1791010482714"), so always send ISO-8601.
// (checked by shape, not instanceof: a Date from another realm is still a Date)
const toIso = (d) => (d && typeof d.toISOString === 'function' ? d.toISOString() : d ?? null);

function result(outcome, order = null) {
  return {
    outcome,
    message: OUTCOME_MESSAGES[outcome],
    order,
    exitedAt: toIso(order?.exitedAt ?? (order?.status === 'completed' ? order.completedAt : null)),
    exitedByName: order?.exitedBy?.staffName ?? null,
  };
}

/**
 * Read-only: what staff see after scanning. Never writes.
 * @param storeScope the caller's store, or null for a platform admin (any store)
 */
async function verifyExit({ code, caller, isAdmin, storeScope }) {
  const filter = filterForScannedCode(code);
  if (!filter) return result('NOT_FOUND');
  const order = await Order.findOne(scoped(filter, storeScope));
  if (!order) return result('NOT_FOUND'); // includes another store's order: reveal nothing
  return result(exitBlocker(order, caller, isAdmin) ?? 'OK_TO_EXIT', await withStoreName(order));
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw badInput('requestId must be 8-64 letters, digits, - or _');
  }
}

function linesMatch(order, verifiedLineIds) {
  const expected = (order.items ?? []).map((i) => i._id?.toString()).filter(Boolean);
  if (expected.length === 0 || !Array.isArray(verifiedLineIds)) return false;
  const got = new Set(verifiedLineIds.map(String));
  return got.size === expected.length && expected.every((id) => got.has(id));
}

/**
 * Completes an exit. Every refusal happens before the single atomic write;
 * the write itself re-checks "not exited, open, paid, no open flag", so two
 * staff completing the same order at once produce exactly one exit.
 *
 * A retry carrying the same requestId as the exit that succeeded returns
 * EXITED again (the first response was lost); any other request gets
 * ALREADY_EXITED.
 */
async function _completeExit({ filter, caller, isAdmin, storeScope, verifiedLineIds, requestId, method, reason }) {
  const order = await Order.findOne(scoped(filter, storeScope));
  if (!order) return result('NOT_FOUND');
  if (order.exitedAt && order.exitRequestId === requestId) return result('EXITED', await withStoreName(order));

  const blocker = exitBlocker(order, caller, isAdmin);
  if (blocker) return result(blocker, await withStoreName(order));
  if (!linesMatch(order, verifiedLineIds)) return result('LINES_NOT_VERIFIED', await withStoreName(order));

  const now = new Date();
  const staffId = caller._id.toString();
  const staffName = caller.name ?? 'Staff';
  const exited = await Order.findOneAndUpdate(
    {
      _id: order._id,
      exitedAt: null,
      status: { $in: OPEN_STATUSES },
      paymentStatus: PAID,
      $or: [{ flaggedIssue: null }, { 'flaggedIssue.resolvedAt': { $ne: null } }],
    },
    {
      $set: {
        status: 'completed',
        completedAt: now,
        exitedAt: now,
        exitedBy: { staffId, staffName },
        exitMethod: method,
        ...(reason ? { exitReason: reason } : {}),
        exitRequestId: requestId,
        exitVerifiedLineIds: verifiedLineIds.map(String),
      },
      $push: {
        staffActions: {
          staffId,
          staffName,
          action: method === 'manual' ? 'manual_exit' : 'exited',
          ...(reason ? { note: reason } : {}),
          timestamp: now,
        },
      },
    },
    { new: true }
  );

  if (!exited) {
    // Lost a race (or the order changed since it was read). Report the truth.
    const current = await Order.findById(order._id);
    if (current?.exitedAt && current.exitRequestId === requestId) return result('EXITED', await withStoreName(current));
    const why = current ? exitBlocker(current, caller, isAdmin) : null;
    return result(why ?? 'ALREADY_EXITED', await withStoreName(current ?? order));
  }
  return result('EXITED', await withStoreName(exited));
}

/** Exit by scanning the customer's QR. */
async function completeExit({ code, caller, isAdmin, storeScope, verifiedLineIds, requestId }) {
  validateRequestId(requestId);
  const filter = filterForScannedCode(code);
  if (!filter) return result('NOT_FOUND');
  return _completeExit({ filter, caller, isAdmin, storeScope, verifiedLineIds, requestId, method: 'qr' });
}

/** Exit from the open-paid-orders list (no QR). A reason is required and recorded. */
async function completeManualExit({ orderId, reason, caller, isAdmin, storeScope, verifiedLineIds, requestId }) {
  validateRequestId(requestId);
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 5 || why.length > 500) throw badInput('Give a reason for the manual exit (5-500 characters).');
  if (!mongoose.isValidObjectId(orderId)) return result('NOT_FOUND');
  return _completeExit({
    filter: { _id: orderId }, caller, isAdmin, storeScope, verifiedLineIds, requestId, method: 'manual', reason: why,
  });
}

/** Paid orders in one store that have not exited and are not cancelled, oldest first. */
async function getOpenPaidOrders(storeId) {
  const orders = await Order.find({
    storeId,
    paymentStatus: PAID,
    status: { $in: OPEN_STATUSES },
    exitedAt: null,
  }).sort({ createdAt: 1 }).limit(200);
  const store = await Store.findById(storeId);
  return orders.map((o) => {
    o._storeName = store?.name ?? null;
    o._storeCode = store?.storeCode ?? null;
    o._userId = o.user;
    return o;
  });
}

/** Admin-only (resolver enforces role + store scope): resolve an open flag, audited. */
async function clearOrderFlag({ orderId, note, caller }) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length < 3 || text.length > 500) throw badInput('Say how the issue was resolved (3-500 characters).');
  const now = new Date();
  const staffId = caller._id.toString();
  const staffName = caller.name ?? 'Admin';
  const order = await Order.findOneAndUpdate(
    { _id: orderId, flaggedIssue: { $ne: null }, 'flaggedIssue.resolvedAt': null },
    {
      $set: {
        'flaggedIssue.resolvedAt': now,
        'flaggedIssue.resolvedBy': { staffId, staffName },
        'flaggedIssue.resolutionNote': text,
      },
      $push: { staffActions: { staffId, staffName, action: 'flag_cleared', note: text, timestamp: now } },
    },
    { new: true }
  );
  if (!order) throw badInput('This order has no open flag.');
  return withStoreName(order);
}

module.exports = {
  EXIT_QR_PREFIX,
  OPEN_STATUSES,
  newExitCode,
  exitQrFor,
  filterForScannedCode,
  exitBlocker,
  verifyExit,
  completeExit,
  completeManualExit,
  getOpenPaidOrders,
  clearOrderFlag,
};
