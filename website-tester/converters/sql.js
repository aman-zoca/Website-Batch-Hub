// zoca-booking-csv bundle → Postgres INSERTs (matches §4 / Appendix B of the spec).
//
// Uses DETERMINISTIC uuid v5 (derived from each row's external_id) so:
//   • child rows can reference their parent's id at generation time, and
//   • re-running the same data yields the same ids (safe to re-run with
//     ON CONFLICT — we emit ON CONFLICT DO NOTHING on primary keys).
//
// NOTE: this is a migration artifact you run once, not application code.

import crypto from "node:crypto";
import { parse } from "csv-parse/sync";

const NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // uuid v5 namespace (fixed)

function uuid5(name) {
  const nsBytes = Buffer.from(NS.replace(/-/g, ""), "hex");
  const h = crypto
    .createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(String(name))]))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(
    16,
    20
  )}-${x.slice(20)}`;
}

const uid = (extId) => uuid5(extId);

// SQL literals
const S = (v) =>
  v === "" || v === null || v === undefined
    ? "NULL"
    : `'${String(v).replace(/'/g, "''")}'`;
const N = (v) =>
  v === "" || v === null || v === undefined ? "NULL" : Number(v);
const J = (obj) => `'${JSON.stringify(obj).replace(/'/g, "''")}'::jsonb`;

function rowsOf(csvs, name) {
  const raw = csvs[name];
  if (!raw) return [];
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
}

export function bundleToSql(csvs, manifest, opts = {}) {
  const entityId =
    (manifest && manifest.entity_id) || opts.entityId || ":entity_id";
  const tz = (manifest && manifest.default_timezone) || "America/New_York";
  const actor = opts.actor || "00000000-0000-0000-0000-000000000000"; // replace with a real migration user
  const header = [
    `-- Zoca migration load — generated from ${
      manifest ? manifest.source_platform : "CSV"
    } bundle`,
    `-- entity_id=${entityId}  timezone=${tz}`,
    `-- Replace the actor uuid below with a real system/migration user if you have one.`,
    `\\set entity_id '${entityId}'`,
    `\\set actor '${actor}'`,
  ];
  const sections = {}; // { "customers.csv": [lines...] }
  let cur = [];
  const p = (s) => cur.push(s);
  const section = (file) => (cur = sections[file] = []);

  // ---- customers (person + phone/email contact graph) ----
  section("customers.csv");
  for (const r of rowsOf(csvs, "customers.csv")) {
    const cid = uid(r.external_id);
    p(
      `INSERT INTO clients.clients (id, entity_id, first_name, last_name, source, channel, platform, type, reference_id, date_of_birth, created_at)`
    );
    p(
      `VALUES ('${cid}', :'entity_id', ${S(r.first_name)}, ${S(
        r.last_name
      )}, 'IMPORTED', 'MIGRATION', 'VAGARO', 'CUSTOMER', ${S(
        r.external_id
      )}, ${S(r.date_of_birth)}, ${
        S(r.created_at) === "NULL" ? "now()" : S(r.created_at)
      })`
    );
    p(`ON CONFLICT (id) DO NOTHING;`);
    if (r.phone_number) {
      const contactId = uuid5(r.external_id + "|phone");
      p(
        `INSERT INTO clients.contacts (contact_id, type, is_active) VALUES ('${contactId}', 'PHONE', true) ON CONFLICT (contact_id) DO NOTHING;`
      );
      p(
        `INSERT INTO clients.phone_numbers (contact_id, country_code, number) VALUES ('${contactId}', ${S(
          r.phone_country_code || "1"
        )}, ${S(r.phone_number)}) ON CONFLICT (contact_id) DO NOTHING;`
      );
      p(
        `INSERT INTO clients.client_contacts (id, client_id, contact_id, is_deleted) VALUES ('${uuid5(
          r.external_id + "|pc"
        )}', '${cid}', '${contactId}', false) ON CONFLICT (id) DO NOTHING;`
      );
    }
    if (r.email) {
      const contactId = uuid5(r.external_id + "|email");
      p(
        `INSERT INTO clients.contacts (contact_id, type, is_active) VALUES ('${contactId}', 'EMAIL', true) ON CONFLICT (contact_id) DO NOTHING;`
      );
      p(
        `INSERT INTO clients.emails (contact_id, email) VALUES ('${contactId}', ${S(
          r.email
        )}) ON CONFLICT (contact_id) DO NOTHING;`
      );
      p(
        `INSERT INTO clients.client_contacts (id, client_id, contact_id, is_deleted) VALUES ('${uuid5(
          r.external_id + "|ec"
        )}', '${cid}', '${contactId}', false) ON CONFLICT (id) DO NOTHING;`
      );
    }
  }
  p("");

  // ---- staff ----
  section("staff.csv");
  for (const r of rowsOf(csvs, "staff.csv")) {
    const sid = uid(r.external_id);
    p(
      `INSERT INTO staff.members (id, entity_id, first_name, last_name, is_active, order_index, reference_id, created_at, updated_at)`
    );
    p(
      `VALUES ('${sid}', :'entity_id', ${S(r.first_name)}, ${S(r.last_name)}, ${
        r.is_active === "false" ? "false" : "true"
      }, 0, ${S(r.external_id)}, now(), now()) ON CONFLICT (id) DO NOTHING;`
    );
  }
  p("");

  // ---- services (+ entity link) ----
  section("services.csv");
  for (const r of rowsOf(csvs, "services.csv")) {
    const svcId = uid(r.external_id);
    p(
      `INSERT INTO services.services (id, name, duration, is_active, created_at)`
    );
    p(
      `VALUES ('${svcId}', ${S(r.name)}, ${J({
        minutes: Number(r.duration_minutes) || 60,
      })}, true, now()) ON CONFLICT (id) DO NOTHING;`
    );
    p(
      `INSERT INTO services.services_entities (service_id, entity_id) VALUES ('${svcId}', :'entity_id') ON CONFLICT DO NOTHING;`
    );
  }
  p("");

  // ---- bookings ----
  section("bookings.csv");
  for (const r of rowsOf(csvs, "bookings.csv")) {
    const bid = uid(r.external_id);
    const cid = uid(r.customer_external_id);
    p(
      `INSERT INTO scheduling.bookings (id, entity_id, client_id, status, attributes, created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type, should_collect_deposit, should_cancel_automatically)`
    );
    p(
      `VALUES ('${bid}', :'entity_id', '${cid}', ${S(r.status)}, ${J({
        migration_source: "VAGARO",
        migration_source_id: r.external_id,
        original_status: r.original_status,
      })}, ${S(r.created_at)}, :'actor', 'MIGRATION', ${S(
        r.created_at
      )}, :'actor', 'MIGRATION', false, false) ON CONFLICT (id) DO NOTHING;`
    );
  }
  p("");

  // ---- booking_services → booking_items (+ service_line_items when a sale exists) ----
  const salesRows = rowsOf(csvs, "sales.csv");
  const saleByBooking = new Map(
    salesRows.map((s) => [s.booking_external_id, s])
  );
  section("booking_services.csv");
  for (const r of rowsOf(csvs, "booking_services.csv")) {
    const itemId = uid(r.external_id);
    const bid = uid(r.booking_external_id);
    const svcId = uid(r.service_external_id);
    const provId = r.provider_external_id ? uid(r.provider_external_id) : null;
    p(
      `INSERT INTO scheduling.booking_items (id, booking_id, service_id, provider_id, status, start_at, end_at, duration_minutes, price, amount, currency, is_tax_updated_manually, created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type)`
    );
    p(
      `VALUES ('${itemId}', '${bid}', '${svcId}', ${
        provId ? `'${provId}'` : "NULL"
      }, 'BOOKED', ${S(r.start_at)}, ${S(r.end_at)}, ${N(
        r.duration_minutes
      )}, ${N(r.price)}, ${N(r.price)}, 'USD', false, ${S(
        r.start_at
      )}, :'actor', 'MIGRATION', ${S(
        r.start_at
      )}, :'actor', 'MIGRATION') ON CONFLICT (id) DO NOTHING;`
    );

    const sale = saleByBooking.get(r.booking_external_id);
    if (sale) {
      const saleId = uid(sale.external_id);
      p(
        `INSERT INTO scheduling.service_line_items (id, entity_id, sale_id, booking_id, booking_item_id, service_id, provider_id, qty, price, amount, currency, service, status, created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type)`
      );
      p(
        `VALUES ('${uuid5(
          r.external_id + "|sli"
        )}', :'entity_id', '${saleId}', '${bid}', '${itemId}', '${svcId}', ${
          provId ? `'${provId}'` : "NULL"
        }, ${N(r.qty || 1)}, ${N(r.price)}, ${N(r.price)}, 'USD', ${J({
          migrated: true,
        })}, 'COMPLETED', ${S(r.start_at)}, :'actor', 'MIGRATION', ${S(
          r.start_at
        )}, :'actor', 'MIGRATION') ON CONFLICT (id) DO NOTHING;`
      );
    }
  }
  p("");

  // ---- sales ----
  section("sales.csv");
  for (const r of salesRows) {
    const saleId = uid(r.external_id);
    const bid = r.booking_external_id ? uid(r.booking_external_id) : null;
    const cid = r.customer_external_id ? uid(r.customer_external_id) : null;
    p(
      `INSERT INTO scheduling.sales (id, entity_id, booking_id, client_id, status, subtotal, discount_amount, tax_amount, tip_amount, total_amount, amount_paid, amount_due, currency, idempotency_key, created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type)`
    );
    p(
      `VALUES ('${saleId}', :'entity_id', ${bid ? `'${bid}'` : "NULL"}, ${
        cid ? `'${cid}'` : "NULL"
      }, ${S(r.status)}, ${N(r.subtotal)}, 0, 0, 0, ${N(r.total_amount)}, ${N(
        r.amount_paid
      )}, ${N(r.amount_due)}, 'USD', ${S(r.external_id)}, ${S(
        r.created_at
      )}, :'actor', 'MIGRATION', ${S(
        r.created_at
      )}, :'actor', 'MIGRATION') ON CONFLICT (id) DO NOTHING;`
    );
  }
  p("");

  // ---- payments ----
  section("payments.csv");
  for (const r of rowsOf(csvs, "payments.csv")) {
    const payId = uid(r.external_id);
    const saleId = uid(r.sale_external_id);
    p(
      `INSERT INTO scheduling.payments (id, sale_id, entity_id, amount, currency, payment_type, payment_method, status, created_at, created_by, created_by_type)`
    );
    p(
      `VALUES ('${payId}', '${saleId}', :'entity_id', ${N(
        r.amount
      )}, 'USD', ${S(r.payment_type || "FINAL")}, ${S(
        r.payment_method || "OTHER"
      )}, ${S(r.status || "COMPLETED")}, ${S(
        r.created_at
      )}, :'actor', 'MIGRATION') ON CONFLICT (id) DO NOTHING;`
    );
  }
  // ---- assemble per-file sections + one combined script ----
  const order = [
    "customers.csv",
    "staff.csv",
    "services.csv",
    "bookings.csv",
    "booking_services.csv",
    "sales.csv",
    "payments.csv",
  ];
  const sectionStr = {}; // { file: sql-for-that-file }
  for (const f of order) {
    const lines = (sections[f] || []).filter((l) => l && l.trim());
    if (lines.length) sectionStr[f] = `-- ${f}\n` + lines.join("\n");
  }
  const body = order
    .filter((f) => sectionStr[f])
    .map((f) => sectionStr[f])
    .join("\n\n");
  const sql = `${header.join("\n")}\n\nBEGIN;\n\n${body}\n\nCOMMIT;\n`;
  return { sql, sections: sectionStr };
}
