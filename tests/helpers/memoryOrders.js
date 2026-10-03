/**
 * In-memory stand-in for the Order model, for service tests.
 *
 * Filters are matched the way MongoDB matches them for the operators the
 * services use (equality, null = missing-or-null, $in, $ne, $exists, $gte,
 * $lt, $or, dotted paths). findOneAndUpdate yields to the event loop and then
 * matches + updates in one synchronous step — the per-document atomicity
 * MongoDB gives — so concurrent calls genuinely interleave and only the
 * filter can stop a second writer. It does not test MongoDB itself (no
 * mongodb-memory-server, by decision).
 *
 * Use from a test file:
 *   jest.mock('../src/models/Order', () => require('./helpers/memoryOrders').OrderModel);
 *   const db = require('./helpers/memoryOrders');
 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const state = { orders: [] };

const get = (doc, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);

function set(doc, path, value) {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

const isOperatorObject = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
  && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));

const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : String(a) === String(b));

function matchValue(actual, cond) {
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$in': return v.some((x) => (x === null ? actual == null : actual != null && same(actual, x)));
        case '$ne': return v === null ? actual != null : !(actual != null && same(actual, v));
        case '$exists': return v ? actual !== undefined : actual === undefined;
        case '$gte': return actual != null && actual >= v;
        case '$lt': return actual != null && actual < v;
        default: throw new Error(`memoryOrders: unsupported operator ${op}`);
      }
    });
  }
  if (cond === null) return actual == null;
  return actual != null && same(actual, cond);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) =>
    (k === '$or' ? v.some((f) => matches(doc, f)) : matchValue(get(doc, k), v)));
}

function applyUpdate(doc, update) {
  for (const [k, v] of Object.entries(update)) {
    if (k === '$set') for (const [p, x] of Object.entries(v)) set(doc, p, x);
    else if (k === '$push') {
      for (const [p, x] of Object.entries(v)) {
        if (!Array.isArray(get(doc, p))) set(doc, p, []);
        get(doc, p).push(x);
      }
    } else if (k.startsWith('$')) throw new Error(`memoryOrders: unsupported update ${k}`);
    else set(doc, k, v);
  }
}

const clone = (doc) => (doc ? structuredClone(doc) : null);

function query(results) {
  let rows = results;
  const q = {
    sort(spec) {
      const [[key, dir]] = Object.entries(spec);
      rows = [...rows].sort((a, b) => (get(a, key) > get(b, key) ? dir : get(a, key) < get(b, key) ? -dir : 0));
      return q;
    },
    limit(n) { rows = rows.slice(0, n); return q; },
    select() { return q; },
    then(resolve, reject) { return Promise.resolve(rows.map(clone)).then(resolve, reject); },
  };
  return q;
}

const OrderModel = {
  findOne: jest.fn(async (filter) => {
    await tick();
    return clone(state.orders.find((o) => matches(o, filter)));
  }),
  findById: jest.fn((id) => {
    const p = (async () => {
      await tick();
      return clone(state.orders.find((o) => same(o._id, id)));
    })();
    p.select = () => p;
    return p;
  }),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    await tick();
    const doc = state.orders.find((o) => matches(o, filter));
    if (!doc) return null;
    applyUpdate(doc, update);
    return clone(doc);
  }),
  find: jest.fn((filter) => query(state.orders.filter((o) => matches(o, filter)))),
  countDocuments: jest.fn(async (filter) => state.orders.filter((o) => matches(o, filter)).length),
};

function reset(orders = []) {
  state.orders = orders.map((o) => structuredClone(o));
}

const stored = (id) => state.orders.find((o) => same(o._id, id));

module.exports = { OrderModel, state, reset, stored, matches };
