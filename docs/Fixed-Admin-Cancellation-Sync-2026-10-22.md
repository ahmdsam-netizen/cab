# Fixed ride admin cancellation synchronization — 2026-10-22

## Client report

Client screenshots show All Rides marking fixed trips cancelled while the driver
still sees a departed fixed route with a passenger. Report also says the customer
still sees an active booking. Screenshots are evidence of the reported mismatch,
not independent verification of current production records.

## Cause and change

`AdminTripsController::cancel` previously transitioned only the parent Trip and
invoked shuttle refund handling. Fixed driver screens read RouteDeparture and
fixed customer screens read SeatReservation. Those remained active. Fixed vehicle
admin cancellation already had per-passenger full-refund handling, but did not
transition its linked parent Trip in the other direction.

- All Rides now routes fixed cancellations through
  FixedDepartureService::cancelAdminDeparture, cancelling active passenger bookings
  (including boarded), releasing capacity and using existing refund/notification
  rules. Emits the existing fixed catalog update for subscribers.
- The shared admin fixed cancellation service also transitions the linked Trip;
  private and shuttle cancellation paths retain their existing handling.
- A previously cancelled parent with an active fixed departure can be reconciled
  by the authorized cancellation endpoint. Completed trips remain protected.
- Driver manifest polling now clears cancelled/completed active departures,
  passenger/seat/request state, detail/OTP sheets and GPS streaming, then refreshes
  the route list. A realtime catalog event is helpful but not the only way to clear
  a terminated ride.

## Verification and delivery

Regression coverage uses local `cab_test`, mocked gateway refunds and both
waiting/boarded passengers. Checks both admin entry points, historical mismatched
parent repair, customer booking API cancellation status, absence of active driver
vehicle state and repeat-refund/capacity protection. Driver tests feed terminal
manifest responses and verify screen/stream cleanup.

Evidence logs: admin-fixed-cancel-regression-tests.log,
driver-cancel-sync-tests.log, driver-cancel-sync-build.log. An initial SQLite
attempt could not run existing MySQL-specific migrations; final backend checks
use the installed local MySQL test service.

Final results: **4 backend tests passed, 69 assertions; 2 driver regression tests
passed; driver production build passed.** PHP syntax and focused diff whitespace
checks passed. These are local test results, not proof of deployed behavior.

No live cancellation, refund, production data repair or deployment was performed.
Existing client records need targeted reconciliation after backend deployment;
the fix does not silently rewrite historical live records. The final driver change
needs to be included in a driver app release. Customer source did not need changing
for its existing status refresh to read corrected reservation data.

## Requested customer/driver browser follow-up — 2026-10-22

Restarted local customer (8100) and driver (8200) development servers and opened
both visibly in the browser. Both retained signed-in sessions. Existing test
booking #30 still displays Boarded in customer and a DEPARTED vehicle with one
passenger in driver. Both development environments point to
https://dreamcabs.in/api; they are not exercising the changed local backend.
No admin cancellation or refund was submitted to that unpatched live backend.
Evidence: ui-previews/customer-cancel-predeploy-browser.png and
ui-previews/driver-cancel-predeploy-browser.png. Tabs left open for user review.

Added an actual customer polling regression: start with BOARDED, return CANCELLED
from the booking API on the next silent poll, and verify cancelled summary,
removal of progress/destination/code/active controls and location-stream stop.
All **18 customer lifecycle checks passed** (customer-cancel-sync-tests.log).
This is a controlled component/API-response test, not a live cross-app cancellation.
Backend 4/69, driver 2 and driver build evidence above remains valid. Full live
browser cancellation verification requires backend deployment and controlled
reconciliation/cancellation of an identified test record first.

Next: deploy/release through the normal workflow,
then verify one controlled admin cancellation across all three apps and reconcile
only identified affected records. Booking #30's last recorded live state remains
boarded on a departed ride; do not infer that this local fix has cancelled it.

## Post-upload live verification — 2026-10-22

User reported uploading the fix and explicitly requested live testing. Tested
through the existing admin/customer/driver browser interfaces using the configured
live API. This section supersedes the earlier predeployment test-state notes.

1. Before repair, admin trip #54 was already Cancelled (cancelled the previous
   evening), but its only passenger, sandbox booking #30, remained BOARDED and its
   driver departure DEPARTED. Confirmed manifest contained only our test passenger.
2. In Live Fixed Vehicles, selected the 21 Oct service date and cancelled that
   test vehicle with an explicit test/reconciliation reason. Normal cancellation
   action succeeded. Customer #30 automatically changed to Cancelled; driver
   automatically returned to Choose Route. No manual refresh caused those changes.
   Admin manifest showed 0/9 seats, one cancelled passenger, Refund status Refunded.
   This was the prior ₹10 Razorpay Test Mode payment; no real-money bank settlement
   is established by this test. Other client trip #53 was not touched.
3. Opened a fresh route 5 test departure, requested seat 1A for the same stops,
   received driver acceptance and confirmed via supported Cash method. Customer
   confirmation showed Paid now ₹0 / Cash to driver ₹10. No cash was collected.
   Booking #31 was CONFIRMED/PENDING. Start Boarding created parent trip #55.
4. Opened All Rides → trip #55 → Cancel Ride. Entered explicit post-deployment test
   reason and selected fee waiver. Submitted the normal admin cancellation.
   Parent and passenger both became Cancelled. Customer changed automatically to
   Cancelled and driver returned to the route setup/Open for Bookings screen with
   no active departure. Thus the specific All Rides entry point from the client
   report was verified in addition to the dedicated fixed recovery screen.

Evidence: ui-previews/customer-admin-cancel-live-confirmed.png,
driver-admin-cancel-live-cleared.png, customer-all-rides-cancel-live.png,
driver-all-rides-cancel-live.png and admin-all-rides-cancel-live.png.

Remaining limits: old released APK was not installed/tested, and native push,
background/offline recovery and real-money refund settlement remain unverified.
Do not infer that all historical affected production records were reconciled.

Persistence/cleanup: reloaded both app tabs after the #55 cancellation. Customer
#31 remained Cancelled; driver returned Choose Route with no active departure.
Returned driver dashboard and confirmed Go Offline; final state Offline / Go
Online. Both controlled test departures are cancelled, #30/#31 are cancelled,
and no active test departure remains. Neither test was marked dropped/completed.
Three browser tabs retained for user inspection. Cancellation result evidence was
captured before restoring driver Offline. No app source changed during this pass.
