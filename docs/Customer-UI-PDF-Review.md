# Customer UI PDF review

Reviewed: 2026-10-17 (Asia/Calcutta).
Source: `C:/Users/masud/Downloads/DreamCabs UI.pdf.pdf` (8 pages).
Preserved project copy: [Customer UI reference](design-references/customer-ui-reference.pdf).
All pages rendered and visually reviewed; document text extracted for comparison.

This document records reference content and recommendations, not authorization
to implement every pictured feature. No application code changed during review.

Follow-up: the user supplied screenshots of all seven sections and identified
them as the customer UI sections to design. This confirms the visual reference;
it does not by itself expand the earlier requirement to preserve core functionality.

## Main finding

Unlike the earlier driver images, this is a customer-app reference. It defines
seven sections and combines visual redesign with additional product features.
Use it as the customer visual reference while retaining current operating rules.

## Page-by-page mapping

| PDF page | Section | Design direction | Tracker mapping / considerations |
| --- | --- | --- | --- |
| 1 | Cover / contents | DREAMCABS branding and seven-section overview | Customer reference; does not replace the separate driver references. |
| 2 | Home | Map with search sheet, microphone, service selector, banner carousel, saved places, nearby departures, explanation cards | C02–C05. Map/search hierarchy is directly useful. Show actual enabled services, offers, availability, and fare data. Nearby ranking and marketing promises need verification. |
| 3 | AI voice booking | Listening/transcript, interpreted journey summary, Confirm and Edit actions; English, Hindi, Urdu, Kashmiri | Additional functional scope. Current mode chooser is a placeholder. A confirmed summary is a useful design principle, but a working multilingual assistant requires speech recognition, interpretation, validation, and booking integration. |
| 4 | Booking | Stop timeline, Now/Later/Date, seat map, add-ons, payment, coupon, fare summary, persistent confirmation, hold timer | C05–C08. Preserve configured layouts, seat holds, existing booking/payment flow, and service-specific scheduling. Women-only seats, repeat daily, and parcel delivery require separate assessment. |
| 5 | Live ride | Map, driver/vehicle card, boarding code, stop progress, walk-to-pickup, call/share/SOS, protection status, free rebook | C08–C09. Reuse existing tracking/code features; verify call/share/SOS coverage by ride type. Walking guidance and stop-distance/ETA need real data. Automated monitoring and free rebooking are separate product requirements. |
| 6 | My trips | Upcoming/Pre-booked/Past, track/modify/cancel, rating tags, receipt/rebook/lost item, pass banner | C10. Preserve supported booking statuses and cancellation/refund rules. Booking modification, quick rating tags, rebook, lost-item workflow, and passes need capability checks. |
| 7 | Account | Wallet/top-up, referral offer, passes/coupons, refunds/receipts, contacts/support, language/voice, Easy mode, Low-data mode, saved places, notifications | C11. Existing profile, saved locations, contacts, coupons, and refunds offer starting points. Customer wallet/top-up, referrals/passes, localization, accessibility mode, and data-saving mode require verification or new work. |
| 8 | Safety centre | SOS, automatic trusted-contact sharing, protection indicators, categorized reporting | C02/C09/C11. Existing emergency contacts and trip SOS/share provide partial foundations. A dedicated centre is a new screen; automatic sharing, speed/deviation detection, and incident workflows are not established by this review. |

## Changes from the earlier customer proposal

- PDF navigation is **Home / Trips / Voice / Safety / Account**, rather than the
  earlier proposed Home / My Trips / Wallet / Account.
- Wallet lives inside Account in this reference. Do not add a top-level Wallet
  tab without validating the actual customer wallet capabilities.
- Recommended first release: **Home / My Trips / Safety / Account**, with Safety
  limited to verified working tools. Voice can be added once functional; do not
  provide an inactive tab or a microphone that implies working voice booking.
- Home is explicitly map-first, with a sheet for search and supporting content.
- Booking combines sections in a scrollable flow with a persistent confirmation
  action. The two illustrations on pages 2, 4, and 5 show content continuation;
  they should not automatically become separate pages.
- The fixed-route booking concept cannot be copied unchanged to private,
  shuttle, or outstation services. Preserve each service's existing requirements.

These remain recommendations; the user has requested review, not approval of a
new navigation structure or functional scope.

## Local code evidence and limits

- `customer-mobile/src/app/shared/mode-select-modal/mode-select-modal.component.ts`
  explicitly describes Voice/Self selection as static/future wiring.
- Customer terms/privacy pages state that voice booking is unavailable in this
  release; the reference's multilingual assistant is not an existing capability.
- `customer-mobile/src/app/customer-tabs/customer-tabs.page.html` currently has
  Ride and Private tabs. A separate legacy `/tabs` shell also exists. Audit active
  routing before changing navigation; do not assume both shells serve the same flow.
- `pages/more/` links profile, saved places, emergency contacts, coupons, and refunds.
- `pages/fixed-ride-active/` contains boarding-code and star/comment rating flows.
- `pages/trip-active/` contains SOS and trip-sharing actions, with corresponding
  backend trip/SOS routes. Their existence does not prove all fixed-route screens
  expose them or that automatic trusted-contact delivery works.
- Searches did not establish working voice booking, recurring bookings, parcel
  booking, automated protection, passes, or the pictured customer preferences.
  This is a focused code review, not a complete capability audit or runtime test.

## Reference gaps and inconsistencies to resolve

- Example offer: FIRST10 is described as a first ride for 10 rupees on Home,
  while Booking shows 25 minus 10 equals 15 rupees. Use the actual coupon rules.
- Three-step booking progress is pictured, but the complete steps and navigation
  are not specified. Define them against the existing booking lifecycle.
- The PDF does not cover no routes/seats, expired holds, payment failure,
  pending driver acceptance, cancellation/refund exceptions, location denial,
  stale GPS/ETA, offline recovery, or keyboard/small-screen layouts.
- Seat counts, labels, hold duration, fare, balance, driver verification, and
  protection state must come from actual data rather than the illustrations.
- Promises such as free rebooking, women-only seating, no surge, and active
  safety monitoring need supported behavior and applicable business rules.

## Implementation recommendation

Continue customer-first. Complete C01 using this PDF as an input, then resolve C02
navigation/layouts and C03 visual foundations. Implement the supported Home,
booking, tracking, trips, account, and safety presentation within C04–C13.
Keep additional features in a separately scoped backlog. Driver implementation
remains pending until the customer phase handoff.
