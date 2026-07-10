# Zoca Booking CSV — Universal Migration Format

**Status:** For team review
**Author:** durga@zoca.ai
**Date:** 2026-07-06
**Format version:** `1.0`

> **How to read this doc (for reviewers):** this defines a **file format**, not code. Phase 1 (this document) is the _contract_ — every file, every column, and **why each column exists**. Phase 2 (later) is the importer that reads this format and writes it into our database. If a column seems unnecessary, or one you need is missing — that's exactly the feedback we want. Add a comment against the row.

---

## 0. The one-paragraph summary

When a merchant moves to Zoca from another platform (Mindbody, Vagaro, Fresha, Booksy, Square, GlossGenius, StyleSeat…), they arrive with years of history: leads, bookings, the services they sold, who performed them, what was paid, what discounts applied. **The Zoca Booking CSV is one standard file format that can hold _all_ of that history**, so any platform's export can be converted into it and loaded into Zoca — and the imported records look and behave exactly like they were always here, keeping their **original dates**. Build the reader once; add each new platform with a thin converter.

## 0.1 Phasing — what's in scope now vs later

|            | **Phase 1 — the format (THIS doc, current work)**                                                             | **Phase 2 — the importer (later)**                            |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Goal**   | Define the robust CSV: which files, which columns, why, and the rules for values (dates, money, status, IDs). | Build the code that reads a bundle and writes it into the DB. |
| **Owner**  | Product / this spec.                                                                                          | Engineering.                                                  |
| **Output** | A frozen `v1.0` format every converter targets + the `Load SQL` per file (§4).                                | _(Optional, later)_ a one-click background importer.          |
| **Status** | Ready for team review.                                                                                        | Not started — nice-to-have after this is signed off.          |

The rest of this document is Phase 1: the files, the **required columns** (§4), and the **SQL to load them** (§5). Phase 2 (a polished importer) is optional and only sketched.

---

## 1. Problem & Purpose

- **Problem:** there's no single, lossless way to bring a merchant's historical leads and bookings into Zoca. Each platform exports differently, and naive imports silently drop the important parts — applied offers, multiple payments, taxes, tips, deposits, refunds.
- **Purpose:** define **one canonical format** rich enough to carry _everything_ Zoca stores about a lead or booking, so:
  1. any platform's export can be converted into it,
  2. the importer is built once, and
  3. imported rows are indistinguishable from native ones, **with their original historical dates**.

---

## 2. What we're actually doing (and what already exists)

**Our job here is one thing:** define the **zoca-booking CSV** — the files and the **required columns** below (§4) — and **load those rows into the DB with straightforward SQL inserts** (the `Load SQL` block under each file). That's it. Produce the CSV → run the inserts → the history shows up in Zoca with its original dates.

> **Context only — what Zoca already has (we are NOT rebuilding this):** there's an existing platform-migration framework (`libs/integrated-platforms/`) with per-platform adapters (Square, Mindbody, Vagaro, GlossGenius, Booksy, Fresha…) that pull data **live over API**. That path handles the booking skeleton (appointment + who/what/when) but **not money** (sales, payments, refunds, offers, tax, tip). Our CSV+SQL path is separate and simpler — it's for cases where we just have a file (e.g. StyleSeat, a manual export) and it also carries the money history the live path doesn't. _Chrone_ is Zoca's own legacy system, not an external platform. A plain list of what already exists is in §8 — reviewers can skip it.

---

## 3. The format at a glance

- **A bundle = one `.zip`** containing several CSV files + a `manifest.json`.
- **One bundle = one location** (one Zoca `entity_id`), and that location must already exist in Zoca. Multi-location merchants send one bundle per location.
- **Relational, not flat.** Because a booking has many moving parts (several services, several payments, an offer), the format is a _set of linked files_ joined by IDs — nothing gets crammed into one giant row and lost.

### 3.1 `manifest.json` — the bundle's cover sheet

| Field                           | Why it's here                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `format_version`                | So we can evolve the format later without breaking old converters. Pin `"1.0"`.                                              |
| `source_platform`               | Where the data came from (`MINDBODY`, `VAGARO`, `FRESHA`, `STYLESEAT`, …). Drives attribution + which converter produced it. |
| `entity_id`                     | The target Zoca location. Everything in the bundle belongs to it. Import fails fast if it doesn't exist.                     |
| `default_currency`              | Fallback currency (e.g. `USD`) for any money cell that omits one.                                                            |
| `default_timezone`              | Fallback IANA timezone (e.g. `America/New_York`) for interpreting any timestamp that lacks an offset.                        |
| `generated_at` / `generated_by` | When/what produced the bundle — for support + debugging.                                                                     |
| `files[]`                       | List of `{ filename, row_count, sha256 }` — lets the importer verify nothing was truncated or corrupted.                     |

### 3.2 Universal value rules (apply to every file)

| Rule                | What & why                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Encoding**        | UTF-8. Handles every language/name correctly.                                                                                                                                           |
| **Format**          | Comma-delimited, standard CSV quoting (RFC 4180). Quote any field with a comma, quote, or newline.                                                                                      |
| **Header row**      | Required. Columns matched **by name**, so column order doesn't matter and extra columns are safely ignored (forward-compatible).                                                        |
| **Blank cell**      | Means "not provided" (NULL / use default).                                                                                                                                              |
| **Booleans**        | `true` / `false`.                                                                                                                                                                       |
| **Money**           | Decimal dollars, always 2 places (`54.00`) + a `currency` column. Matches how Zoca stores money; no guessing cents vs dollars.                                                          |
| **Dates/times**     | ISO 8601 **with an explicit offset**: `2024-03-01T14:30:00-05:00`. The offset removes all timezone ambiguity — the #1 cause of corrupted migrations. Date-only fields use `YYYY-MM-DD`. |
| **Lists in a cell** | Semicolon-separated (`Color;Balayage`).                                                                                                                                                 |
| **IDs**             | Every row carries its **original ID from the source platform** in `external_id`. This is how children reference parents, and how a re-import updates instead of duplicating (see §5).   |

---

## 4. The files & columns (Phase 1 — the actual format)

Legend: **R** = required, O = optional. Each file starts with **why it exists** and **why these columns**. The "→ DB" column shows where the data lands (context for engineering — reviewers can ignore it).

> **About the "Load SQL" block under each file:** it's a copy-pasteable reference `INSERT` showing how that file's rows land in the DB — handy for a manual/dev hand-load or to sanity-check the mapping. It is **NOT the production import path**: the Phase-2 importer uses **Drizzle ORM** (repo standard — no raw SQL in app code) and also does `external_id → UUID` resolution, verification, skip-bad-rows, and re-run de-dup that raw INSERTs can't. Conventions in every block: mint each `id` with `gen_random_uuid()`; `:entity_id` = target location (from `manifest.json`); `:actor` = a system/migration user UUID for NOT-NULL `created_by` columns; run files in the order they appear (each references IDs from earlier ones).

### 4.1 `customers.csv` — the people _(required)_

**Why:** every booking and lead belongs to a person; this is the foundation everything else links to.
**Why these columns:** enough to identify and reach the customer (name, phone, email), preserve their history (birthday, marketing consent, when they joined), and remember their original ID so re-imports match them.

| Column                        | R/O                    | Why this column                                                                                           |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `external_id`                 | R                      | Their ID on the old platform — the match key so we never duplicate a customer. → `clients.reference_id`   |
| `first_name`                  | R                      | Minimum to create a person. → `clients.first_name`                                                        |
| `last_name`                   | O                      | Full name when available. → `clients.last_name`                                                           |
| `display_name`                | O                      | If the platform stored a preferred display name. → `clients.display_name`                                 |
| `phone_country_code`          | O                      | Dial code kept separate (e.g. `+1`) so international numbers stay correct. → `phone_numbers.country_code` |
| `phone_number`                | O                      | The number itself; matched on the last 10 digits. → `phone_numbers.number`                                |
| `email`                       | O                      | Contact + second match signal. → `emails.email`                                                           |
| `date_of_birth`               | O                      | Powers birthday campaigns; part of their real history. → `clients.date_of_birth`                          |
| `gender`                      | O                      | Kept if the source had it. → `clients.metadata`                                                           |
| `client_type`                 | O (default `CUSTOMER`) | Distinguishes a real customer from a lead-only contact. → `clients.type`                                  |
| `is_marketing_consent_given`  | O                      | Legal/compliance — don't message people who never opted in. → `clients.is_marketing_consent_given`        |
| `is_blocked` / `block_reason` | O                      | Preserve a merchant's decision to block someone. → `clients.is_blocked` / `block_reason`                  |
| `created_at`                  | R                      | **Their original join date** — so they look like a long-standing customer. → `clients.created_at`         |

_Provenance (`source`, `channel`, platform) is stamped automatically by the importer — not a column the converter fills._

**Load SQL** (a customer spans 5 tables — person + contact + phone + email + join; repeat per row):

```sql
-- 1) the person
INSERT INTO clients.clients (id, entity_id, first_name, last_name, source, channel, platform, type, reference_id, date_of_birth, created_at)
VALUES (gen_random_uuid(), :entity_id, 'Jane', 'Doe', 'IMPORTED', 'MIGRATION', 'MINDBODY', 'CUSTOMER',
        'MB-CLIENT-123' /* csv external_id */, '1990-04-12', '2021-06-01T10:00:00-05:00');

-- 2) a phone contact (contact_id ties the next rows together)
INSERT INTO clients.contacts      (contact_id, type,  is_active) VALUES (gen_random_uuid(), 'PHONE', true);
INSERT INTO clients.phone_numbers (contact_id, country_code, number) VALUES (:contact_id, '1', '5551234567');

-- 3) link person ↔ contact
INSERT INTO clients.client_contacts (id, client_id, contact_id, is_deleted)
VALUES (gen_random_uuid(), :client_id, :contact_id, false);

-- email is the same pattern: contacts(type='EMAIL') → clients.emails(contact_id, email) → client_contacts
```

### 4.2 `staff.csv` — providers _(optional catalogue)_

**Why:** bookings need to say _who_ performed the service; reports and payroll depend on it.
**Why these columns:** identify the provider and remember their original ID so appointments can link to them.

| Column            | R/O                | Why this column                                                                                   |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `external_id`     | R                  | Provider's ID on the old platform — match key. → `members.reference_id`                           |
| `first_name`      | R                  | Minimum to create a provider. → `members.first_name`                                              |
| `last_name`       | O                  | Full name. → `members.last_name`                                                                  |
| `title`           | O                  | E.g. "Senior Stylist" — shown to clients. → `members.title`                                       |
| `email` / `phone` | O                  | Contact + invite. → `members.email` / `phone`                                                     |
| `specializations` | O                  | What they do (semicolon list) — drives booking rules. → `members.specializations`                 |
| `is_active`       | O (default `true`) | Keep inactive/former staff off the booking page but preserve their history. → `members.is_active` |
| `created_at`      | O                  | When they joined. → `members.created_at`                                                          |

**Load SQL:**

```sql
INSERT INTO staff.members (id, entity_id, first_name, last_name, title, email, phone, is_active, order_index, reference_id, created_at, updated_at)
VALUES (gen_random_uuid(), :entity_id, 'Alex', 'Kim', 'Senior Stylist', 'alex@salon.com', '5559876543',
        true, 0, 'MB-STAFF-9' /* csv external_id */, now(), now());
```

### 4.3 `services.csv` — the menu _(optional catalogue)_

**Why:** every booking line points at a service; the menu must exist for bookings to attach to it.
**Why these columns:** name it, price it, time it — the three things a service needs — plus its original ID.

| Column             | R/O                 | Why this column                                                                            |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------ |
| `external_id`      | R                   | Service's ID on the old platform — match key. → `services.attributes.platformServiceId`    |
| `name`             | R                   | What the service is called. → `services.name`                                              |
| `description`      | O                   | Client-facing detail. → `services.description`                                             |
| `price_type`       | O (default `FIXED`) | `FIXED` / `RANGE` / `STARTS` / `NO_PRICE` — how the price is expressed. → `services.price` |
| `price_amount`     | O                   | The price (and `price_max` for a range). → `services.price`                                |
| `currency`         | O                   | Currency of the price. → `services.price`                                                  |
| `duration_minutes` | O                   | How long it takes — drives the calendar. → `services.duration`                             |
| `is_active`        | O (default `true`)  | Keep retired services for history without offering them. → `services.is_active`            |

**Load SQL** (price/duration are JSON bags; entity link is a separate join row):

```sql
INSERT INTO services.services (id, name, price, duration, is_active, created_at)
VALUES (gen_random_uuid(), 'Haircut',
        '{"type":"FIXED","amount":50.00,"currency":"USD"}'::jsonb,
        '{"minutes":30}'::jsonb, true, now());
INSERT INTO services.services_entities (service_id, entity_id) VALUES (:service_id, :entity_id);
```

### 4.4 `bookings.csv` — the appointment header _(core)_

**Why:** the top-level record of an appointment — who it's for, its status, and its lifecycle (confirmed / cancelled / rescheduled).
**Why these columns:** identity + who + status + the lifecycle timestamps that make the history real, plus deposit facts.

| Column                                      | R/O                | Why this column                                                                                                       |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `external_id`                               | R                  | Appointment ID on the old platform — match key (no duplicates on re-run). → `bookings.attributes.migration_source_id` |
| `customer_external_id`                      | R                  | Links the booking to a `customers.csv` row. → resolves `client_id`                                                    |
| `status`                                    | R                  | `BOOKED` / `COMPLETED` / `CANCELLED` / `NO_SHOW` / … — the appointment's outcome. → `bookings.status`                 |
| `original_status`                           | O                  | The source's own word, kept for audit if it doesn't map cleanly. → `bookings.attributes`                              |
| `deposit_amount`                            | O (default `0.00`) | If a deposit was taken — part of the money history. → `bookings.deposit_amount`                                       |
| `is_deposit_paid` / `is_deposit_waived_off` | O                  | Whether/why the deposit was settled. → `bookings.is_deposit_paid` / `is_deposit_waived_off`                           |
| `is_confirmed` / `confirmed_at`             | O                  | Confirmation state + when. → `bookings.is_confirmed` / `confirmed_at`                                                 |
| `cancelled_at` / `cancellation_reason`      | O                  | Preserve cancellations accurately. → `bookings.cancelled_at` / `cancellation_reason`                                  |
| `rescheduled_at` / `rescheduled_reason`     | O                  | Preserve reschedules. → `bookings.rescheduled_at` / `rescheduled_reason`                                              |
| `created_at`                                | R                  | **The original booking date** — the whole point of a faithful migration. → `bookings.created_at`                      |

**Load SQL** (keep the source id in `attributes.migration_source_id` for de-dup; audit columns → `:actor`):

```sql
INSERT INTO scheduling.bookings (id, entity_id, client_id, status, attributes,
        created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type,
        should_collect_deposit, should_cancel_automatically)
VALUES (gen_random_uuid(), :entity_id, :client_id, 'COMPLETED',
        '{"migration_source":"MINDBODY","migration_source_id":"MB-APPT-555"}'::jsonb,
        '2024-03-01T14:30:00-05:00', :actor, 'MIGRATION', '2024-03-01T14:30:00-05:00', :actor, 'MIGRATION',
        false, false);
```

### 4.5 `booking_services.csv` — one service within a booking _(core)_

**Why:** a booking can hold several services, each with its own time, provider, and price. This is where date/time and money-per-service live.
**Why these columns:** pin each service to _when_, _who_, and _how much_ — including its share of tax, tip, and discount.

| Column                    | R/O                | Why this column                                                                                                               |
| ------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `external_id`             | R                  | Line ID on the old platform — match key. → line `attributes`                                                                  |
| `booking_external_id`     | R                  | Which booking this line belongs to. → resolves `booking_id`                                                                   |
| `service_external_id`     | R                  | Which service was performed. → resolves `service_id`                                                                          |
| `provider_external_id`    | O                  | Who performed it. → resolves `provider_id`                                                                                    |
| `start_at`                | R                  | **When it happened** (ISO + offset) — drives the calendar/history. → `booking_items.start_at`                                 |
| `end_at`                  | O                  | End time (derived from duration if blank). → `booking_items.end_at`                                                           |
| `duration_minutes`        | R                  | Length of the service. → `booking_items.duration_minutes`                                                                     |
| `price`                   | R                  | The service's price on that booking. → `service_line_items.price`                                                             |
| `qty`                     | O (default `1`)    | For quantity-based lines. → `service_line_items.qty`                                                                          |
| `discount_amount`         | O (default `0.00`) | Any per-service discount (this is how simple discounts are carried — no offer record needed). → `service_line_items.discount` |
| `tax_amount` / `tax_rate` | O                  | Tax on this line — part of an accurate money picture. → `service_line_items.tax`                                              |
| `tip_amount`              | O (default `0.00`) | Tip attributed to this service. → `service_line_items.tip`                                                                    |

**Load SQL** — this file feeds two tables: the scheduling row (`booking_items`, below) and the money row (`service_line_items`, created with the sale in §4.6):

```sql
INSERT INTO scheduling.booking_items (id, booking_id, service_id, provider_id, status,
        start_at, end_at, duration_minutes, price, amount, currency, is_tax_updated_manually,
        created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type)
VALUES (gen_random_uuid(), :booking_id, :service_id, :provider_id, 'COMPLETED',
        '2024-03-01T14:30:00-05:00', '2024-03-01T15:00:00-05:00', 30, 50.00, 50.00, 'USD', false,
        now(), :actor, 'MIGRATION', now(), :actor, 'MIGRATION');
```

### 4.6 `sales.csv` — the invoice/receipt header _(money)_

**Why:** the financial summary of a booking (or a walk-in "quick sale") — the totals a merchant sees on a receipt.
**Why these columns:** every number on a receipt — subtotal, discount, tax, tip, fees, total, and how much was paid vs still owed.

| Column                                         | R/O | Why this column                                                                         |
| ---------------------------------------------- | --- | --------------------------------------------------------------------------------------- |
| `external_id`                                  | R   | Sale ID on the old platform — match key. → `sales.idempotency_key`                      |
| `booking_external_id`                          | O   | Links to a booking (blank = a walk-in quick sale). → resolves `booking_id`              |
| `customer_external_id`                         | O   | Who paid. → resolves `client_id`                                                        |
| `status`                                       | R   | `PAID` / `PARTIALLY_PAID` / `REFUNDED` / … — the money state. → `sales.status`          |
| `subtotal`                                     | O   | Pre-discount, pre-tax total. → `sales.subtotal`                                         |
| `discount_amount`                              | O   | Total discount on the sale. → `sales.discount_amount`                                   |
| `tax_amount` / `tip_amount` / `processing_fee` | O   | The rest of the money breakdown. → `sales.tax_amount` / `tip_amount` / `processing_fee` |
| `total_amount`                                 | R   | What the sale came to. → `sales.total_amount`                                           |
| `amount_paid`                                  | R   | What was actually collected. → `sales.amount_paid`                                      |
| `amount_due`                                   | O   | Outstanding balance (total − paid). → `sales.amount_due`                                |
| `created_at`                                   | R   | **When the sale happened.** → `sales.created_at`                                        |

**Load SQL** (the sale header + one `service_line_item` per booking-service line from §4.5):

```sql
INSERT INTO scheduling.sales (id, entity_id, booking_id, client_id, status,
        subtotal, discount_amount, tax_amount, tip_amount, total_amount, amount_paid, amount_due, currency,
        idempotency_key, created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type)
VALUES (gen_random_uuid(), :entity_id, :booking_id, :client_id, 'PAID',
        50.00, 0.00, 4.13, 10.00, 64.13, 64.13, 0.00, 'USD',
        'MB-SALE-777' /* csv external_id */, now(), :actor, 'MIGRATION', now(), :actor, 'MIGRATION');

INSERT INTO scheduling.service_line_items (id, entity_id, sale_id, booking_id, booking_item_id, service_id, provider_id,
        qty, price, amount, currency, service, status, created_at, created_by, created_by_type, updated_at, updated_by, updated_by_type)
VALUES (gen_random_uuid(), :entity_id, :sale_id, :booking_id, :booking_item_id, :service_id, :provider_id,
        1, 50.00, 50.00, 'USD', '{"name":"Haircut"}'::jsonb, 'COMPLETED', now(), :actor, 'MIGRATION', now(), :actor, 'MIGRATION');
```

### 4.7 `payments.csv` — money in _(money)_

**Why:** one sale can be paid in several parts (deposit, then partial, then final) and by different methods. Each is its own row.
**Why these columns:** how much, how, when, and its outcome.

| Column                      | R/O                     | Why this column                                                                                  |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `external_id`               | R                       | Payment ID on the old platform — match key. → payment `attributes`                               |
| `sale_external_id`          | R                       | Which sale this payment is against. → resolves `sale_id`                                         |
| `amount`                    | R                       | How much was paid. → `payments.amount`                                                           |
| `payment_type`              | O (default `FINAL`)     | `DEPOSIT` / `PARTIAL` / `FINAL` / fee — where it sits in the sequence. → `payments.payment_type` |
| `payment_method`            | R                       | `CASH` / `CARD` / `VENMO` / … (unknown → `OTHER` + name). → `payments.payment_method`            |
| `status`                    | O (default `COMPLETED`) | Whether it went through. → `payments.status`                                                     |
| `card_brand` / `card_last4` | O                       | For card payments — matches receipts. → `payments.card_brand` / `card_last4`                     |
| `created_at`                | R                       | **When it was paid.** → `payments.created_at`                                                    |

**Load SQL** (one row per payment — a sale can have several):

```sql
INSERT INTO scheduling.payments (id, sale_id, entity_id, amount, currency, payment_type, payment_method, status,
        created_at, created_by, created_by_type)
VALUES (gen_random_uuid(), :sale_id, :entity_id, 64.13, 'USD', 'FINAL', 'CARD', 'COMPLETED',
        '2024-03-01T15:05:00-05:00', :actor, 'MIGRATION');
```

### 4.8 `refunds.csv` — money out _(money)_

**Why:** refunds are part of the true financial history; without them totals are wrong.

| Column                | R/O | Why this column                                     |
| --------------------- | --- | --------------------------------------------------- |
| `external_id`         | R   | Refund ID on the old platform — match key.          |
| `payment_external_id` | R   | Which payment was refunded. → resolves `payment_id` |
| `sale_external_id`    | R   | Which sale it belongs to. → resolves `sale_id`      |
| `amount`              | R   | How much was refunded. → `refunds.amount`           |
| `reason`              | O   | Why. → `refunds.reason`                             |
| `created_at`          | R   | **When.** → `refunds.created_at`                    |

**Load SQL** (only if a refund happened):

```sql
INSERT INTO scheduling.refunds (id, payment_id, sale_id, entity_id, amount, currency, refund_method, status,
        reason, created_at, created_by, created_by_type)
VALUES (gen_random_uuid(), :payment_id, :sale_id, :entity_id, 20.00, 'USD', 'CARD', 'COMPLETED',
        'Partial refund', '2024-03-05T09:00:00-05:00', :actor, 'MIGRATION');
```

### 4.9 `offers_applied.csv` — a named offer/coupon that was used _(money)_

**Why:** to preserve _which_ offer or coupon a customer redeemed (not just the dollar amount). **Simple discounts with no named offer don't need this file** — they ride on `booking_services.discount_amount`.

| Column                                     | R/O | Why this column                                                        |
| ------------------------------------------ | --- | ---------------------------------------------------------------------- |
| `external_id`                              | R   | Redemption ID on the old platform — match key.                         |
| `booking_external_id` / `sale_external_id` | R\* | What it applied to (at least one). → resolves `booking_id` / `sale_id` |
| `customer_external_id`                     | R   | Who redeemed it. → resolves `client_id`                                |
| `offer_title` / `coupon_code`              | O   | The offer's name/code — kept for history. → offer snapshot             |
| `discount_type`                            | R   | `PERCENTAGE` or `FIXED`. → discount snapshot                           |
| `discount_value`                           | R   | `20` (= 20%) or `10.00` (= $10). → discount snapshot                   |
| `discount_amount`                          | R   | The actual dollars taken off. → discount snapshot                      |
| `created_at`                               | R   | **When it was redeemed.**                                              |

\* at least one of `booking_external_id` / `sale_external_id`.

**Load SQL** (`offer_usages.offer_id` is NOT NULL — create/look-up a "Migrated offer" first, then attach):

```sql
INSERT INTO offers.offer_usages (id, offer_id, entity_id, client_id, booking_id, sale_id, discount_snapshot, is_active,
        created_at, created_by, created_by_type)
VALUES (gen_random_uuid(), :migrated_offer_id, :entity_id, :client_id, :booking_id, :sale_id,
        '{"type":"PERCENTAGE","value":20,"amount":10.00}'::jsonb, true,
        now(), :actor, 'MIGRATION');
```

### 4.10 `leads.csv` — enquiries that hadn't yet booked _(optional)_

**Why:** the pre-booking funnel is real history too — where a lead came from, what they wanted, and whether it converted.

| Column                                       | R/O | Why this column                                                            |
| -------------------------------------------- | --- | -------------------------------------------------------------------------- |
| `external_id`                                | R   | Lead ID on the old platform — match key.                                   |
| `customer_external_id`                       | R   | The person enquiring. → resolves `client_id`                               |
| `status`                                     | R   | Lead stage. → `booking_enquiries.status`                                   |
| `source`                                     | R   | Where the lead came from — key for marketing. → `booking_enquiries.source` |
| `service`                                    | O   | What they were interested in. → `booking_enquiries.service`                |
| `price` / `currency`                         | O   | Quoted price, if any. → `booking_enquiries.price` / `currency`             |
| `utm_source` / `utm_medium` / `utm_campaign` | O   | Attribution — how they found the business. → respective columns            |
| `booking_external_id`                        | O   | If the lead converted, which booking it became. → resolves `booking_id`    |
| `created_at`                                 | R   | **When the lead came in.** → `booking_enquiries.created_at`                |

**Load SQL:**

```sql
INSERT INTO website.booking_enquiries (id, entity_id, client_id, source, status, service, price, currency,
        booking_id, attributes, created_at)
VALUES (gen_random_uuid(), :entity_id, :client_id, 'INSTAGRAM', 'converted', 'Haircut', 50.00, 'USD',
        :booking_id /* if it converted, else NULL */,
        '{"migration_source":"MINDBODY","migration_source_id":"MB-LEAD-42"}'::jsonb,
        '2021-05-20T09:00:00-05:00');
```

### 4.11 Optional extras

- **`product_sale_lines.csv`** — retail products sold alongside services (name, qty, price, tax). Same idea as `booking_services.csv` for goods.
- **`notes.csv`** — free-text notes on a booking or customer, preserved for continuity.

---

## 5. How it gets loaded (CSV → SQL)

The whole flow is deliberately simple:

1. **Make the CSV.** A per-platform converter produces the files in §4 with the required columns.
2. **Load with SQL.** Run the `Load SQL` inserts under each file, **in the order the files appear** (customers → staff → services → bookings → booking_services → sales → payments → refunds → offers → leads) — each later file references IDs from an earlier one.
3. **Result:** the rows land in Zoca with their **original dates**, so the history looks native.

Notes that follow from the columns:

- **No duplicates on re-run:** each row keeps its source `external_id` (in `reference_id` / `attributes.migration_source_id`), so a re-load can match instead of duplicating.
- **Original dates preserved:** the inserts set `created_at` / `start_at` explicitly from the file.
- **Bad rows:** skip and note them rather than failing the whole load.

_(If this later becomes a one-click background importer, it would use Drizzle ORM per repo standard — but that's a Phase-2 decision, not required for the CSV+SQL approach here.)_

---

## 6. Design decisions (final — for reference)

These are settled; they explain choices baked into the format.

| Decision         | Choice & why                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Bundle shape     | **Relational multi-file**, because bookings have many services/payments/offers and a flat row would lose them.    |
| Money            | **Decimal dollars + currency**, matching how Zoca stores money.                                                   |
| Dates            | **ISO 8601 with offset**, to eliminate timezone corruption.                                                       |
| Status           | Carry a **canonical status + the source's original word**; the importer maps it.                                  |
| IDs / de-dup     | Carry the **source platform's IDs**; store them so re-imports match, never duplicate.                             |
| Services & staff | **Match if they exist, else create** — works for empty or already-onboarded accounts.                             |
| Errors           | **Skip bad rows + report**, so a big migration isn't blocked by a few typos.                                      |
| Bundle scope     | **One bundle = one existing location.**                                                                           |
| Named offers     | Auto-create a placeholder "migrated offer" so redemption history is preserved; simple discounts ride on the line. |
| Fresha           | Add `FRESHA` as a first-class platform value.                                                                     |
| Products & notes | Included in the format.                                                                                           |

---

## 7. Glossary

- **Bundle** — the `.zip` of CSV files + `manifest.json` for one location.
- **`external_id`** — a record's original ID on the source platform; the key that links files and prevents duplicates.
- **Catalogue** — the reusable building blocks: customers, staff, services.
- **Booking skeleton** — the appointment itself (who/what/when), without the money.
- **Money stack** — sales, payments, refunds, and applied offers.
- **Entity / location** — the Zoca `entity_id` a bundle belongs to.

---

## 8. What already exists today (for reference)

A quick list of what Zoca already has, so nobody rebuilds it. **None of this is part of our CSV+SQL work** — it's just context.

- **Live-API migration framework** — `libs/integrated-platforms/`, with per-platform adapters: Square, Mindbody, Vagaro, GlossGenius, Booksy, Fresha, Boulevard, Acuity, MassageBook (+ native Zoca). Pulls data live over each platform's API.
- **What that framework covers:** the **booking skeleton** only — the appointment plus who/what/when (`scheduling.bookings` + `booking_items`).
- **What it does NOT cover:** any **money** — no sales, payments, refunds, offers, tax, tip, or deposits. (Our CSV carries all of that.)
- **StyleSeat:** no adapter — a file-only case, which is exactly why the CSV path exists.
- **Chrone:** Zoca's own legacy system, not an external platform.
- **Existing CSV plumbing we could borrow later:** the inventory CSV importer (`libs/inventory`) and the loyalty client-CSV importer (`libs/clients`) — reference only, not required for the SQL-load approach.

### 8.1 How the existing (live-API) flow works today

For context — this is the flow the framework above runs. Our CSV+SQL path is a separate, simpler flow (see §5); it is **not** this.

```
   Merchant connects a platform (OAuth / credentials)
                     │
                     ▼
   ┌───────────────────────────────────────────────┐
   │  Per-platform ADAPTER  (libs/integrated-       │
   │  platforms/adapters/<platform>.adapter.ts)     │
   │                                                │
   │   syncClients()   → reads customers  ─┐        │
   │   syncStaff()     → reads providers   ├─► create/match in DB
   │   syncServices()  → reads the menu   ─┘   (remember platform IDs)
   │                                                │
   │   getAppointments({from,to})  → reads history  │
   │        (day-by-day, live over the API)         │
   └───────────────────────┬────────────────────────┘
                           ▼
   extractAppointmentRefs()  → appointment in platform IDs
                           ▼
   mapAppointmentToBooking()  ── VERIFY every reference ──┐
        client? service? provider? valid time?           │
          ├─ all resolve  → booking draft                 │
          └─ missing ref  → gap (skip + report) ──────────┘
                           ▼
   save → scheduling.bookings + scheduling.booking_items
                           ▼
   ┌───────────────────────────────────────────────┐
   │  RESULT: appointments in Zoca                  │
   │   ✓ who / what / when (booking skeleton)       │
   │   ✗ NO money — no sales, payments, refunds,    │
   │      offers, tax, tip, deposits                │
   └───────────────────────────────────────────────┘
```

**Takeaway:** the live path stops at the booking skeleton and reads over an API. **Our CSV carries the money too, and loads from a file via SQL** — which is why it's a separate flow.

#### 8.1.1 How it authenticates (the part that makes the "read" possible)

There are **two auth families** — how Zoca gets permission to read a platform differs a lot:

| Family                        | Platforms                                                                                                                                                           | How auth works                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API partner / OAuth**       | **Square, Acuity** (OAuth2 authorization-code); **Mindbody** (API-key + owner username/password → short-lived user token, plus an owner "activation code" approval) | The merchant clicks connect → redirected to the platform's consent page → Zoca gets an access token (Square also gets a **refresh token**; Acuity tokens are long-lived; Mindbody tokens are re-issued/renewed on expiry). Scopes requested cover appointments, customers, orders/payments, staff, catalog.                                                                                                                           |
| **Browser capture (scraper)** | **GlossGenius, Vagaro, Fresha, Booksy, Boulevard, MassageBook** (no partner API)                                                                                    | The owner logs in through a **Zoca-driven remote browser**; as they log in, Zoca **captures the session** — cookies / bearer tokens / header keys (e.g. Fresha `_partners_session`, Vagaro `ci_session`, Booksy `X-Access-Token`) — off the platform's own network calls. After that, Zoca calls the platform's **internal REST/GraphQL API directly over HTTP** with those captured credentials (no headless browser at fetch time). |

**Where the credentials live:** two tables — `entities.integrated_platforms` (one row per `entity_id` + platform: which platform, the account/site/merchant IDs, validity flags) and `auth.auth` (the actual token/cookie blob in a JSONB column). The adapter for a platform is chosen at runtime by **detection**: "is native Zoca scheduling on? else which `integrated_platforms` row is valid?" → `PlatformRegistryService` hands back the matching adapter.

**Staying connected:** Square refreshes its token before each call; Mindbody re-issues its user token when expired; scraper cookies **rotate on every response and are auto-saved back**, and a nightly health cron re-verifies credentials (and can re-capture from a live browser profile) so long migrations don't die mid-way.

_(Security note for the team: per-merchant tokens/cookies are currently stored **unencrypted** as JSONB in `auth.auth` — only Square's app-level secret comes from AWS Secrets Manager. Worth hardening, but out of scope for our CSV work.)_

#### 8.1.2 How it pulls the data

- **Detection & adapter pick** — `PlatformDetectionService.getConnectedPlatform(entityId)` → `PlatformRegistryService.get(platform)`.
- **Catalogue first** — `syncClients` / `syncStaff` / `syncServices` page through the platform (cursor-based for Square, offset/limit for Mindbody, `page/per_page` for scrapers) and upsert into Zoca, **remembering each platform ID** so appointments can later resolve to real rows.
- **Appointments, day by day** — the migration walks a window (default **365 days back → 180 days forward**), calling `getAppointments({from, to})` **one day at a time**. That day-windowing _is_ the pagination and the rate-limit strategy (calendar APIs page by date, and it's gentle on session-token limits). Each appointment is reduced to platform IDs (`extractAppointmentRefs`), verified + mapped (`mapAppointmentToBooking`), and saved — **idempotently**, deduped on `bookings.attributes.migration_source_id`, so re-runs don't duplicate.

#### 8.1.3 How it's run (orchestration)

- **Connect + first sync** happens on the **relay server**, event-driven: the moment credentials are captured, it auto-runs `connect` → resolve location (multi-location platforms) → a **blocking `syncAll`** (staff/services/preferences, ~120s budget) → clients sync in the background.
- **The historical appointment backfill** runs on a **Bull queue** (`APPOINTMENT_MIGRATION`) with **concurrency pinned to 1** — deliberately, so two migrations never hammer the same session-token API at once. It returns a job ID immediately and produces a per-day report with catalogue "gaps."
- **Resilience:** hard page caps prevent runaway loops (e.g. Square bookings ≤ 50 pages), per-request timeouts (~30s), 401 → mark-invalid + heal cron. **No explicit 429/exponential-backoff retry** exists today beyond the SDK's own — the `concurrency:1` worker + day-windowing are the main throttles.

---

## 9. All CSVs in one place (quick reference)

The complete format at a glance — every file and its header row. `*` = required column; the rest are optional. Load top-to-bottom (each file references IDs from the ones above it). Full column meanings are in §4; the SQL to load each is under its §4 section.

```
# ── CATALOGUE ─────────────────────────────────────────────
customers.csv        external_id*, first_name*, last_name, display_name, phone_country_code, phone_number, email, date_of_birth, gender, client_type, is_marketing_consent_given, is_blocked, block_reason, created_at*

staff.csv            external_id*, first_name*, last_name, title, email, phone, specializations, is_active, created_at

services.csv         external_id*, name*, description, price_type, price_amount, price_max, currency, duration_minutes, is_active

# ── BOOKINGS ──────────────────────────────────────────────
bookings.csv         external_id*, customer_external_id*, status*, original_status, deposit_amount, is_deposit_paid, is_deposit_waived_off, is_confirmed, confirmed_at, cancelled_at, cancellation_reason, rescheduled_at, rescheduled_reason, created_at*

booking_services.csv external_id*, booking_external_id*, service_external_id*, provider_external_id, start_at*, end_at, duration_minutes*, price*, qty, discount_amount, tax_amount, tax_rate, tip_amount

# ── MONEY ─────────────────────────────────────────────────
sales.csv            external_id*, booking_external_id, customer_external_id, status*, subtotal, discount_amount, tax_amount, tip_amount, processing_fee, total_amount*, amount_paid*, amount_due, currency, created_at*

payments.csv         external_id*, sale_external_id*, amount*, currency, payment_type, payment_method*, status, card_brand, card_last4, created_at*

refunds.csv          external_id*, payment_external_id*, sale_external_id*, amount*, currency, refund_method, status, reason, created_at*

offers_applied.csv   external_id*, booking_external_id†, sale_external_id†, customer_external_id*, offer_title, coupon_code, discount_type*, discount_value*, discount_amount*, created_at*
                     († at least one of booking_external_id / sale_external_id)

# ── LEADS ─────────────────────────────────────────────────
leads.csv            external_id*, customer_external_id*, status*, source*, service, price, currency, utm_source, utm_medium, utm_campaign, booking_external_id, created_at*

# ── OPTIONAL EXTRAS ───────────────────────────────────────
product_sale_lines.csv  external_id*, sale_external_id*, product_external_id*, provider_external_id, qty, price*, amount, currency, tax_amount, discount_amount, created_at
notes.csv               external_id*, parent_type*, parent_external_id*, note_text*, created_at
```

Plus **`manifest.json`** in the bundle: `format_version`, `source_platform`, `entity_id`, `default_currency`, `default_timezone`, `generated_at`, `files[]` (see §3.1).
