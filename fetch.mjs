// Pulls long-term statistics for one power sensor out of Home Assistant over its
// websocket API and writes data.js, which index.html loads with a plain <script>
// (file:// pages cannot fetch() a sibling JSON file).
//
//   node fetch.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--entity sensor.x] [--minus sensor.y]
//
// How the window is worked out (--to is inclusive of that whole day):
//   --days N              the N days up to now             (default 35)
//   --from D              D up to now
//   --from D --days N     N days forward from D
//   --to D --days N      N days back from the end of D
//   --from D --to D       exactly that
// --minus subtracts a second power sensor bucket by bucket (entity - minus), for a load that
// has no sensor of its own but can be derived, e.g. house load = PV production - grid meter:
//   --entity sensor.solaredge_ac_power --minus sensor.solaredge_m1_ac_power
// Power is requested in W whatever unit each sensor uses. Means subtract exactly. Min and max cannot: they are bounds (max = a.max - b.min, min = a.min -
// b.max), so a derived "max of bucket" overstates the real peak. Buckets missing in either sensor
// are dropped.
// Credentials come from .env beside this script (HA_TOKEN, optional HA_URL).
//
// Two resolutions are kept because they have different retention: the recorder
// holds 5-minute statistics for ~10 days (purge_keep_days) and hourly ones
// indefinitely. Each bucket carries mean, min and max: sizing an inverter is about
// peaks, and a mean alone would hide them.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

// .env beside this script; variables already in the environment win over the file.
try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '.env')); } catch {}

const { HA_TOKEN } = process.env;
const HA_URL = process.env.HA_URL ?? 'http://192.168.2.118:8123';
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    days: { type: 'string' },
    entity: { type: 'string' },
    minus: { type: 'string' },
  },
});
const entity = args.entity ?? positionals[0] ?? 'sensor.solaredge_m1_ac_power';
const minus = args.minus;
const label = minus ? `${entity} - ${minus}` : entity;

const DAY = 864e5;
const fail = (msg) => { console.error(msg); process.exit(1); };
// Local midnight, so a date means the day as the household lived it, not UTC.
const parseDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(`Bad date "${s}", expected YYYY-MM-DD`);
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d)) fail(`Bad date "${s}"`);
  return d;
};
const days = args.days === undefined ? undefined : Number(args.days);
if (days !== undefined && !(days > 0)) fail(`--days must be a positive number`);

function window() {
  const now = new Date();
  const from = args.from && parseDay(args.from);
  const to = args.to && new Date(parseDay(args.to).getTime() + DAY);
  let start, end;
  if (from && to) {
    if (days !== undefined) fail('--from, --to and --days together are ambiguous: drop one');
    [start, end] = [from, to];
  } else if (from) {
    start = from;
    end = days === undefined ? now : new Date(from.getTime() + days * DAY);
  } else if (to) {
    end = to;
    start = new Date(to.getTime() - (days ?? 35) * DAY);
  } else {
    end = now;
    start = new Date(now.getTime() - (days ?? 35) * DAY);
  }
  if (end > now) end = now;
  if (start >= end) fail('The window is empty: --from is not before --to.');
  return { start, end };
}

if (!HA_TOKEN) {
  console.error('Set HA_TOKEN in .env (profile → Security → long-lived token). HA_URL is optional.');
  process.exit(1);
}

const ws = new WebSocket(HA_URL.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/websocket');
let nextId = 1;
const pending = new Map();

const call = (msg) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, ...msg }));
  });

ws.onmessage = async ({ data }) => {
  const m = JSON.parse(data);
  if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
  if (m.type === 'auth_invalid') { console.error('Token rejected:', m.message); process.exit(1); }
  if (m.type === 'auth_ok') return run().catch((e) => { console.error(e); process.exit(1); });
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.success ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'request failed'));
};
ws.onerror = () => { console.error(`Cannot reach ${HA_URL}`); process.exit(1); };

async function run() {
  const { start, end } = window();
  console.log(`${label}: ${start.toLocaleString()} → ${end.toLocaleString()}`);
  const out = { entity: label, fetchedAt: new Date().toISOString(), series: {} };
  for (const period of ['5minute', 'hour']) {
    const res = await call({
      type: 'recorder/statistics_during_period',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: minus ? [entity, minus] : [entity],
      // Ask HA to convert, so a kW sensor minus a W sensor (the SolarEdge inverter vs its meter) works.
      units: { power: 'W' },
      period,
      types: ['mean', 'min', 'max'],
    });
    // Compact rows: [startMs, mean, min, max]. Gaps (null) are dropped.
    const rows = (id) => (res[id] ?? []).filter((r) => r.mean != null);
    if (!minus) {
      out.series[period] = rows(entity).map((r) => [r.start, r.mean, r.min, r.max]);
      console.log(`${period}: ${out.series[period].length} buckets`);
      continue;
    }
    const [a, b] = [rows(entity), rows(minus)];
    const bByStart = new Map(b.map((r) => [r.start, r]));
    out.series[period] = a
      .filter((r) => bByStart.has(r.start))
      .map((r) => { const q = bByStart.get(r.start); return [r.start, r.mean - q.mean, r.min - q.max, r.max - q.min]; });
    console.log(`${period}: ${out.series[period].length} buckets (${entity}: ${a.length}, ${minus}: ${b.length})`);
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data.js'), 'window.DATA = ' + JSON.stringify(out) + ';\n');
  console.log('wrote data.js');
  process.exit(0);
}
