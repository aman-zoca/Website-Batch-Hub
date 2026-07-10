// Shared helpers for platform → zoca-booking-csv converters.

/** Values Vagaro uses to mean "empty". */
const EMPTY = new Set(["", "---", "--", "n/a", "na", "null", "."]);

export function clean(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return EMPTY.has(s.toLowerCase()) ? "" : s;
}

/** RFC-4180 CSV cell. */
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** rows: array of objects; columns: ordered list of keys → CSV string. */
export function toCsv(columns, rows) {
  const head = columns.join(",");
  const body = rows
    .map((r) => columns.map((c) => csvCell(r[c])).join(","))
    .join("\n");
  return body ? head + "\n" + body + "\n" : head + "\n";
}

export function slug(s) {
  return (
    clean(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "x"
  );
}

/** Stable short hash (djb2 → base36) for synthesizing external ids. */
export function hash(...parts) {
  const s = parts.map((p) => clean(p).toLowerCase()).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Normalized person-name key for joining appointments ↔ customers. */
export function nameKey(s) {
  return clean(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,]+$/g, "")
    .trim();
}

export function splitName(full) {
  const t = clean(full).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!t.length) return { first: "", last: "" };
  if (t.length === 1) return { first: t[0], last: "" };
  return { first: t[0], last: t.slice(1).join(" ") };
}

export function money(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
export const money2 = (v) => money(v).toFixed(2);

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse "Apr 28, 2026 - 10:30 AM" or "May 27, 2026" → {y,mo,d,h,mi} (local wall clock). */
export function parseVagaroDate(s) {
  const str = clean(s);
  if (!str) return null;
  const m = str.match(
    /([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})(?:\s*[-,]\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/
  );
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mo === undefined) return null;
  const d = +m[2],
    y = +m[3];
  let h = m[4] ? +m[4] : 0;
  const mi = m[5] ? +m[5] : 0;
  if (m[6]) {
    const pm = /pm/i.test(m[6]);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return { y, mo, d, h, mi };
}

/** Offset (minutes) of IANA tz at a given UTC instant. */
function tzOffsetMin(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf
    .formatToParts(date)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour === "24" ? 0 : p.hour,
    p.minute,
    p.second
  );
  return (asUTC - date.getTime()) / 60000;
}

/** Local wall-clock {y,mo,d,h,mi} in tz → ISO 8601 string with the correct offset. */
export function localToISO(parts, tz, addMinutes = 0) {
  if (!parts) return "";
  let guess =
    Date.UTC(parts.y, parts.mo, parts.d, parts.h, parts.mi) +
    addMinutes * 60000;
  // Resolve the offset for that instant (two passes handle DST edges).
  let off = tzOffsetMin(new Date(guess), tz);
  let real = guess - off * 60000;
  off = tzOffsetMin(new Date(real), tz);
  real = guess - off * 60000;
  const dt = new Date(real);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf
    .formatToParts(dt)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hh = p.hour === "24" ? "00" : p.hour;
  // `off` is the ISO offset itself (minutes to add to UTC to get local):
  // New York EDT = -240 → "-04:00".
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}${sign}${oh}:${om}`;
}
