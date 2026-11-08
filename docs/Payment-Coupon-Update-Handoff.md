# Payment-stage coupon update

Date: 2026-10-18 (Asia/Calcutta).

## Current status

Implemented and tested locally. **Not deployed to the live DreamCabs API.**
The customer browser currently uses that live API, so the visible Apply coupon
control cannot update its hold until these backend changes are deployed.
Do not treat a visible control or a local test as production verification.

## Backend change

New authenticated customer endpoint:
`POST /fixed/seat-holds/{fixedSeatHold}/coupon`.
Send `{ "coupon_title": "CODE" }` to apply or null to remove.
Response contains the updated hold, including amount, discount, coupon title and
coupon_editable. No migration or new environment variable is required.

Files:

- `backend/routes/api.php`
- `backend/app/Http/Controllers/FixedBookingsController.php`
- `backend/app/Services/FixedSeatHoldService.php`
- `backend/app/Services/FixedBookingService.php`
- `backend/app/Models/FixedSeatHold.php`

Only the owner can edit an approved, unexpired hold before payment starts.
Hold/departure locking prevents concurrent repricing and order creation.
Existing coupon eligibility and minimum-payment rules remain enforced.
Seat assignments, approval and expiry are retained; coupon usage is recorded at
successful booking confirmation, as before. The frontend keeps the current fare
on failure and never falls back to a cosmetic discount.

## Local evidence

- FixedBookingPhase4Test: 23 tests / 132 assertions passed. Coverage includes
  apply/remove, retained seats/expiry, ownership, invalid coupon, payment-start and
  expiry rejection, and confirmation at the updated discounted amount.
- Customer fixed booking checks: 22 passed, including server-confirmed totals,
  removal, failed update, original request order, cancellation and footer slots.
- Customer production build passed.
- Logs: `release-apks/fixed-hold-coupon-backend-tests.log`,
  `release-apks/customer-payment-footer-coupon-tests.log`,
  `release-apks/customer-payment-footer-coupon-build.log`.

## Remaining work

Deploy the backend through the project's normal release process, refresh any route
cache, and then verify apply/remove in an approved request before payment begins.
Check that the live checkout amount matches the updated hold. Live deployment,
live coupon redemption and payment have not been performed by the agent.
