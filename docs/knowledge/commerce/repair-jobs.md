---
type: feature
title: งานซ่อม — the repair job (server side)
description: Job steps with backward moves and who/when history, the estimate → job bill → paid bill, parts held in งานนอก until paid (owner's pick A), waiting parts with date and time, new parts linked later, cancel with a reason
tags: [repair-job, pos, stock, hold, bill, line-oa]
timestamp: 2026-11-23
status: built (server only; screens come with the design kit)
sources: [owner messages 17 Nov 2026, plan 10.1]
---

# งานซ่อม — the repair job

Plan 10.1 (owner, 17 Nov 2026). Server and database only; the screens come later.

## Steps

`in` เข้าใหม่ → `check` ตรวจเช็ค → `estimate` ประเมินราคา → `agreed` ลูกค้าตกลงราคา → the work
(`waiting_parts` รออะไหล่ while any part is missing, else `working` กำลังซ่อม) → `ready`
พร้อมรับรถ (the bill is issued to pay) → `paid` ชำระเงินแล้ว. Plus `cancelled` with a reason.

- Forward is **one step at a time**; **back to any earlier step** (owner: "backward = yes").
- รออะไหล่ is never picked by hand: a missing part puts the job there, the last one in takes it out.
- Paid and cancelled are closed. A job is never deleted.
- Every move is kept in `repair_job_events` with who and when.
- The steps that send the customer a LINE card are recorded on the event as `customer_update`:
  `in`, `check`, `estimate`, `waiting_parts`, `ready`, `paid` (plan 13.2, owner's pick A, 23 Nov
  2026; was `in`/`check`/`waiting_parts`/`working`/`ready`). A changed waiting time is told too.
  รออะไหล่ carries the time of the last part still waiting (date AND time — the one exception to the
  no-clock-time rule). See "The customer's LINE" below.
- Rules: `packages/core/src/repairJob.ts`. Database: migration 0105. Server:
  `apps/api/src/repairJobs.ts`, every write through the StockLedger Durable Object.

## Lines and stock (owner's pick A)

- Lines added before the work are the **price estimate** only (`estimate`) — no stock moves.
- Starting the work (agreed → working) puts the estimate on the job's bill: a part in stock moves
  ขายได้ → **งานนอก** (`hold`, source `repair_job`); a missing part waits. Labour goes straight on.
- Mixed parts (A in stock, B waiting, C in stock): the team starts with A and C; the job shows
  รออะไหล่ until B is in.
- A waiting part is either an existing product that ran out (staff scan › fill) or a brand-new
  part typed by name (staff add it with เพิ่มสินค้า, fill stock, then link it to the job line).
- Ending the wait (รออะไหล่ → working) takes every waiting part into งานนอก — or refuses and names
  each part still missing (`not_in_stock` / `not_linked`), changing nothing.
- พร้อมรับรถ needs every line on the bill; lines are locked until the job goes back to working.
- **Paid:** one write makes the paid bill (`onsite_sales`, `sale_type 'repair'`, the job's number),
  priced by the same cost/VAT code as the counter (`priceBillLines`), and sells the parts out of
  งานนอก (`unhold` + `onsite_sale`). A part someone put back on the shelf by hand is sold from
  ขายได้ instead. Money counts only from here — the bill row doesn't exist before payment.
- **Removed line / cancel:** taken parts go back to ขายได้; the lines are kept as `removed`.

## Numbers

Job number `JByyyymm-ddnnn`, made by the server by the Thai date. The job's bill carries the same
number, so it can never clash with a phone's `DAS…` walk-in bill.

## Addresses

`GET /repair-jobs` (filters `status`, `plate` + `province` (plan 13.11), `mechanic`, `open=1`; counts per step) ·
`GET /repair-jobs/:id` · `POST /repair-jobs` · `POST /repair-jobs/:id/status {to}` ·
`POST /repair-jobs/:id/lines` · `PATCH|DELETE /repair-jobs/:id/lines/:lineId` ·
`PUT /repair-jobs/:id/mechanics {userIds}` · `POST /repair-jobs/:id/cancel {reason}` ·
`POST /repair-jobs/:id/pay {paymentMethod: cash|promptpay}`. Every role may use them (a ช่าง moves
jobs and takes payment, like at the counter).

## Photos (plan 13.3, 23 Nov 2026)

One photo set per job (owner: *"yes, but just keep it one group of picture set"*).
`POST /repair-jobs/:id/photos` (the picture itself as the body, its `content-type` JPG/PNG/WEBP/HEIC,
up to 10 MB, up to 40 per job) · `GET /repair-jobs/:id/photos/:photoId` (the picture,
`cache-control: private`) · `DELETE /repair-jobs/:id/photos/:photoId`. The job page lists `photos`
(who added each, when). Every add and remove goes in the job's history (`photo_added`,
`photo_removed`). **Private:** pictures sit in R2 under `job-photos/`, which the public `/img/` route
never serves; only signed-in staff open them. Not through the StockLedger object (no stock moves).
Code: `apps/api/src/jobPhotos.ts`; table `repair_job_photos` (migration 0109). The customer's job
page shows them through its own link (below).

## The customer's LINE (plan 13.2, 23 Nov 2026)

From the shop's own LINE OA (owner's picks in DECISIONS.md "The customer's job in LINE").

- **Link once.** Every job gets a private 32-character code (`customer_token`). Staff read
  `GET /repair-jobs/:id/customer-links` → `{pageUrl, lineLinkUrl, linkedLines}` and print
  `lineLinkUrl` as the QR on the job slip / bill (null until the OA is connected). Scanning it opens a
  chat with the OA holding a ready message with the code; when the customer sends it, their LINE
  follows the car (plate + province) for this job and every later one (`line_links`). The reply
  confirms it with the job's latest card. Blocking the OA removes the links.
- **Cards.** After every staff job write, the job's new card steps are taken once
  (`card_queued_at`) and put on the `teampit-line-cards` queue; the Worker's `queue` handler pushes the
  card to every LINE linked to the car, retrying when LINE is busy (same `X-Line-Retry-Key`, so a
  retry arrives once), and gives up to the `-dlq` queue after 5 tries. Staff never wait for LINE.
  Steps that happened while the OA was not connected are never sent later.
- **อนุมัติราคา.** The price card's button sends `approve=<code>&total=<satang>`; the job moves to
  ลูกค้าตกลงราคา only from a LINE linked to the car and only for that exact price (else the reply
  sends them to the latest price). The history note is `approved_in_line`, no staff member.
- **Job page.** `GET /job-page/:code` (public — the code is the key): shop, car, problem, the steps
  told so far, the price lines and total, the waiting time, the photos
  (`GET /job-page/:code/photos/:id`), and at พร้อมรับรถ the shop's default PromptPay QR for exactly the
  bill with the account name. No staff names, costs or ids. Staff mark the job paid as today.
- **Connecting the OA** (owner): three Worker secrets in the Cloudflare dashboard —
  `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_OA_ID` — and the OA's webhook set to
  `https://api.airplusauto.com/line/webhook`. Only Den Air's OA exists; no other shop can send.
  Practice copy: any three values + `LINE_FAKE="1"` write the cards to the log.
- Code: `packages/core/src/jobCard.ts` (the card, the QR link, the approve data),
  `apps/api/src/line.ts` (LINE's API), `apps/api/src/lineCards.ts`, `apps/api/src/jobPage.ts`.
  Migration 0110. The card look and the job page screen are drawn with Stage 12.
- **Open, for Stage 12** (security read, 23 Nov 2026): a link follows the car and never ends, so
  staff need to see a car's linked LINEs and unlink one (sold car, wrong person); the job page's own
  screen (`/j/<code>`) must send `no-referrer` like the API does, so the code never leaves in a
  Referer.
