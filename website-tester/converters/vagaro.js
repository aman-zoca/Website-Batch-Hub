// Vagaro export → zoca-booking-csv bundle.
//
// Vagaro's export is thin and messy, so this converter fills gaps with the
// options passed from the UI (entityId, timezone, defaultDurationMin,
// includeDeleted) and SYNTHESIZES ids the export doesn't provide.
//
// Inputs it understands (auto-detected by header, not filename):
//   • CustomersList  — header row has "First Name"/"Last Name"/"Email"/"Mobile"
//   • AppointmentSummary — row 0 is the status filter; header row has
//     "Customer Name"/"Appointment Date"/"Service Name"/"Employee"/"Amount"
//
// Output: the §4 files it can populate — customers, staff, services,
// bookings, booking_services, sales, payments (+ manifest.json).

import * as XLSX from "xlsx";
import {
  clean,
  toCsv,
  slug,
  hash,
  nameKey,
  splitName,
  money,
  money2,
  parseVagaroDate,
  localToISO,
} from "./util.js";

// Vagaro status → zoca booking_status. "Deleted" is dropped unless includeDeleted.
const STATUS_MAP = {
  confirmed: "CONFIRMED",
  "service complete": "COMPLETED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  "no show": "NO_SHOW",
  "in progress": "BOOKED",
  "awaiting confirmation": "PENDING",
  deleted: "CANCELLED",
};

function sheetRows(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: "",
  });
}

// Find the header row index by looking for known tokens in the first ~8 rows.
function findHeader(rows, tokens) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const cells = rows[i].map((c) => clean(c).toLowerCase());
    if (tokens.every((t) => cells.includes(t))) return i;
  }
  return -1;
}

function indexOfHeader(headerRow, label) {
  return headerRow
    .map((c) => clean(c).toLowerCase())
    .indexOf(label.toLowerCase());
}

export function convertVagaro(inputs, opts = {}) {
  const entityId = clean(opts.entityId) || ":entity_id";
  const tz = clean(opts.timezone) || "America/New_York";
  const durMin =
    Number(opts.defaultDurationMin) > 0 ? Number(opts.defaultDurationMin) : 60;
  const includeDeleted = !!opts.includeDeleted;
  const warnings = [];

  const customers = new Map(); // nameKey → row
  const staff = new Map(); // slug → row
  const services = new Map(); // slug → row
  const bookings = [];
  const bookingServices = [];
  const sales = [];
  const payments = [];

  const ensureCustomerFromName = (fullName) => {
    const key = nameKey(fullName);
    if (!key) return null;
    if (!customers.has(key)) {
      const { first, last } = splitName(fullName);
      customers.set(key, {
        external_id: "cust_" + slug(fullName),
        first_name: first || fullName,
        last_name: last,
        phone_country_code: "",
        phone_number: "",
        email: "",
        date_of_birth: "",
        gender: "",
        created_at: "",
      });
    }
    return customers.get(key);
  };
  const ensureStaff = (name) => {
    const id = "emp_" + slug(name);
    if (clean(name) && !staff.has(id)) {
      const { first, last } = splitName(name);
      staff.set(id, {
        external_id: id,
        first_name: first || name,
        last_name: last,
        is_active: "true",
      });
    }
    return id;
  };
  const ensureService = (name) => {
    const id = "svc_" + slug(name);
    if (clean(name) && !services.has(id)) {
      services.set(id, {
        external_id: id,
        name: clean(name),
        duration_minutes: durMin,
        is_active: "true",
      });
    }
    return id;
  };

  // ---- Pass 1: customers ----
  for (const { name, buf } of inputs) {
    let rows;
    try {
      rows = sheetRows(buf);
    } catch (e) {
      warnings.push(`${name}: unreadable (${e.message})`);
      continue;
    }
    const h = findHeader(rows, ["first name", "last name"]);
    if (h < 0) continue; // not a customer file
    const H = rows[h];
    const col = (l) => indexOfHeader(H, l);
    const c = {
      since: col("customer since"),
      first: col("first name"),
      last: col("last name"),
      email: col("email"),
      dob: col("birthdate"),
      gender: col("gender"),
      mobile: col("mobile"),
    };
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const first = clean(r[c.first]),
        last = clean(r[c.last]);
      const full = [first, last].filter(Boolean).join(" ");
      const key = nameKey(full);
      if (!key) continue;
      const dob = parseVagaroDate(r[c.dob]);
      customers.set(key, {
        external_id: "cust_" + slug(full),
        first_name: first || full,
        last_name: last,
        phone_country_code: clean(r[c.mobile]) ? "1" : "",
        phone_number: clean(r[c.mobile]).replace(/\D/g, ""),
        email: clean(r[c.email]),
        date_of_birth: dob
          ? `${dob.y}-${String(dob.mo + 1).padStart(2, "0")}-${String(
              dob.d
            ).padStart(2, "0")}`
          : "",
        gender: clean(r[c.gender]),
        created_at: localToISO(parseVagaroDate(r[c.since]), tz) || "",
      });
    }
  }

  // ---- Pass 2: appointments ----
  let apptFiles = 0,
    apptRows = 0,
    skippedDeleted = 0;
  for (const { name, buf } of inputs) {
    let rows;
    try {
      rows = sheetRows(buf);
    } catch {
      continue;
    }
    const h = findHeader(rows, [
      "customer name",
      "appointment date",
      "service name",
    ]);
    if (h < 0) continue; // not an appointment file
    apptFiles++;
    const fileStatus = clean(rows[0] && rows[0][0]); // row 0 = status filter
    const H = rows[h];
    const col = (l) => indexOfHeader(H, l);
    const c = {
      cust: col("customer name"),
      date: col("appointment date"),
      status: col("status"),
      service: col("service name"),
      emp: col("employee"),
      amount: col("amount"),
    };
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const custName = clean(r[c.cust]);
      const svcName = clean(r[c.service]);
      const dt = parseVagaroDate(r[c.date]);
      if (!custName && !svcName) continue;
      const rawStatus = (clean(r[c.status]) || fileStatus).toLowerCase();
      const status = STATUS_MAP[rawStatus] || "BOOKED";
      if (rawStatus === "deleted" && !includeDeleted) {
        skippedDeleted++;
        continue;
      }
      if (!dt) {
        warnings.push(
          `${name} row ${i + 1}: unparseable date "${clean(
            r[c.date]
          )}" — skipped`
        );
        continue;
      }
      apptRows++;

      const cust =
        ensureCustomerFromName(custName) ||
        ensureCustomerFromName("Unknown Guest");
      const svcId = ensureService(svcName);
      const empId = ensureStaff(r[c.emp]);
      const amount = money(r[c.amount]);
      const startISO = localToISO(dt, tz);
      const endISO = localToISO(dt, tz, durMin);
      const bkExt =
        "appt_" + hash(custName, r[c.date], svcName, r[c.emp], rawStatus);

      bookings.push({
        external_id: bkExt,
        customer_external_id: cust.external_id,
        status,
        original_status: clean(r[c.status]) || fileStatus,
        created_at: startISO,
      });
      bookingServices.push({
        external_id: "line_" + hash(bkExt, svcId),
        booking_external_id: bkExt,
        service_external_id: svcId,
        provider_external_id: empId,
        start_at: startISO,
        end_at: endISO,
        duration_minutes: durMin,
        price: money2(amount),
        qty: 1,
      });
      // Money: only when the visit actually completed with a charge.
      if (status === "COMPLETED" && amount > 0) {
        const saleExt = "sale_" + bkExt.slice(5);
        sales.push({
          external_id: saleExt,
          booking_external_id: bkExt,
          customer_external_id: cust.external_id,
          status: "PAID",
          subtotal: money2(amount),
          total_amount: money2(amount),
          amount_paid: money2(amount),
          amount_due: "0.00",
          currency: "USD",
          created_at: startISO,
        });
        payments.push({
          external_id: "pay_" + bkExt.slice(5),
          sale_external_id: saleExt,
          amount: money2(amount),
          currency: "USD",
          payment_type: "FINAL",
          payment_method: "OTHER",
          status: "COMPLETED",
          created_at: startISO,
        });
      }
    }
  }

  // ---- Assemble CSV files ----
  const COLS = {
    customers: [
      "external_id",
      "first_name",
      "last_name",
      "phone_country_code",
      "phone_number",
      "email",
      "date_of_birth",
      "gender",
      "created_at",
    ],
    staff: ["external_id", "first_name", "last_name", "is_active"],
    services: ["external_id", "name", "duration_minutes", "is_active"],
    bookings: [
      "external_id",
      "customer_external_id",
      "status",
      "original_status",
      "created_at",
    ],
    booking_services: [
      "external_id",
      "booking_external_id",
      "service_external_id",
      "provider_external_id",
      "start_at",
      "end_at",
      "duration_minutes",
      "price",
      "qty",
    ],
    sales: [
      "external_id",
      "booking_external_id",
      "customer_external_id",
      "status",
      "subtotal",
      "total_amount",
      "amount_paid",
      "amount_due",
      "currency",
      "created_at",
    ],
    payments: [
      "external_id",
      "sale_external_id",
      "amount",
      "currency",
      "payment_type",
      "payment_method",
      "status",
      "created_at",
    ],
  };
  const data = {
    customers: [...customers.values()],
    staff: [...staff.values()],
    services: [...services.values()],
    bookings,
    booking_services: bookingServices,
    sales,
    payments,
  };

  const csvs = {};
  const manifestFiles = [];
  for (const key of Object.keys(COLS)) {
    if (!data[key].length && key !== "customers") continue; // always emit customers
    const fname = `${key}.csv`;
    csvs[fname] = toCsv(COLS[key], data[key]);
    manifestFiles.push({ filename: fname, row_count: data[key].length });
  }
  const manifest = {
    format_version: "1.0",
    source_platform: "VAGARO",
    entity_id: entityId,
    default_currency: "USD",
    default_timezone: tz,
    generated_by: "website-tester/converters/vagaro.js",
    files: manifestFiles,
  };
  csvs["manifest.json"] = JSON.stringify(manifest, null, 2);

  const stats = {
    platform: "VAGARO",
    appointmentFiles: apptFiles,
    appointmentRows: apptRows,
    skippedDeleted,
    customers: data.customers.length,
    staff: data.staff.length,
    services: data.services.length,
    bookings: bookings.length,
    sales: sales.length,
    payments: payments.length,
    warnings,
  };
  return { csvs, manifest, stats };
}
