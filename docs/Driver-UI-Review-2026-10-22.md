# Driver app review — 2026-10-22

Subsequent authorized fix: Choose Route now finalizes both refresh requests on
success or error, ending loading once both settle. Reload is usable after errors.
The no-routes-assigned card is hidden on errors so offline rejection is not
misrepresented as missing route assignment. Browser confirmed offline restriction
with no spinner, enabled Reload, and successful retry back to the same restriction.
Driver remained Offline; no operational writes. Five targeted checks passed
(three loading recovery plus two existing cancellation synchronization checks):
driver-route-loading-tests.log. Screenshot: ui-previews/driver-route-loading-error-fixed.png.
Production build: driver-route-loading-build.log. Remaining design proposals below
are unchanged; next proposal is D02 Home, not a completed driver redesign.

User explicitly moved to the driver app after skipping customer Private/Shuttle
live tests. Customer work remains incomplete; this is a sequencing decision,
not customer acceptance. Reviewed both preserved driver-reference JPEGs, the
driver tracker/design memory and current source. Browser inspected signed-in
Offline dashboard, earnings, profile/vehicle, trip history and fixed-route guard.
No app source edits, online toggle, route/departure creation, passenger action,
OTP, payment, wallet transfer, profile save or configuration change was submitted.

## Findings and proposed order

1. **Choose Route gets stuck loading after an API error.** Browser Offline fixed
   screen shows the expected Go online restriction alongside Loading available
   routes and disabled Reload. In fixed-driver.page.ts refresh(), two requests
   decrement pending only through their complete callbacks; RxJS error does not
   call complete. An error sets error text but leaves loading true. Fix request
   settlement on success/error while preserving online/service restrictions.
   Evidence: ui-previews/driver-audit-route-offline-loading.png. This is a source-
   confirmed functional defect; the offline restriction itself is correct.

2. **Home needs a clearer driver work summary.** Current Home is a full map,
   online/offline action sheet, promotional banner and drawer. Reference Home
   emphasizes identity/vehicle, availability, route/active ride and daily earnings.
   Put real summary information and the appropriate current action together;
   preserve approval/wallet/registered-service gating and banners. Do not present
   assumed daily earnings or a selected route as an active departure.
   Source: pages/dashboard/dashboard.page.*. Screenshot: driver-audit-home.png.

3. **Navigation and active-route composition need an agreed design.** Current
   tabs.page.html intentionally hides the tab bar in favor of the dashboard drawer.
   References show Home/Trips/Earnings/Profile tabs. Proposal: retain drawer
   capabilities and provide clear access to those common destinations; do not
   remove wallet/refunds/documents/support to mimic four reference icons.
   Use reference 2's large map/next-stop emphasis, with reference 1's seat view as
   a separately accessible panel on phones. This remains a recommendation, not
   an approved navigation replacement. Existing active route already has
   passengers/stops/seats panels, pending requests, manifest counts and navigation.
   Source-only for active states this pass: driver stayed Offline, no ride opened.

4. **Route selection can be more compact and informative.** Existing cards show
   route, endpoints, fare and luggage; they retain city/scope/search and vehicle
   layout handling. Match reference's concise route/fare/stops presentation using
   available real data. Keep Open bookings, Start boarding, departure and completion
   distinct. Never substitute the reference's single Start Route for all stages.
   Source: pages/fixed-driver/fixed-driver.page.html. Populated route selection not
   freshly verified in browser because online status was not changed.

5. **Boarding and completion need focused presentation.** Four-digit OTP sheet,
   resend/lockout, passenger/stop details and boarding/drop-off safeguards already
   exist. Preserve them. Completion currently confirms, calls the server, shows a
   toast and refreshes rather than displaying the reference's persistent journey/
   money summary. Add a summary only from actual confirmed completion data;
   preserve active-passenger checks and separate cancellation/refunds. Source:
   fixed-driver.page.html OTP section; fixed-driver.page.ts completeRide(). No
   boarding/drop-off/completion actions tested during this review.

6. **Earnings/history/profile need presentation consolidation, not feature loss.**
   Earnings has cash/total/pending/transferred values and Transfers/Received/
   Analytics views. History shows real status/payment/date/fare and filters.
   Profile has editable details plus registered Vehicle & Service and Documents.
   References offer a simpler summary and account landing view. Keep current
   money breakdowns, filters, verification and editors behind clear summary/access
   points. Browser checked actual earnings and history, profile and registered
   vehicle; no edits/uploads/transfers. Evidence: driver-audit-earnings.png,
   driver-audit-history.png, driver-audit-profile.png under docs/ui-previews/.

## Existing boundaries

QR/voice verification, break/resume, unrestricted stop skipping and Nearby/Popular
filters remain separate deferred functionality. Real icons and current project
colors apply throughout. Do not invent passenger counts, cash settlements, ETA,
verification or route-distance data to reproduce the mockups.

## Verification and continuation

The original tab had a stale geolocation chunk error and the old preview server
was unavailable. Restarted the Angular development preview on 127.0.0.1:8200;
compiled successfully (driver-review-preview-2026-10-22.log). Used a new ordinary
HTTP tab because the failed tab became an inaccessible internal browser error
page. Did not bypass the internal-page policy or alter browser permissions.
The refreshed app obtained GPS and remained Offline. Continued through the
manual/Self UI option; did not invoke Voice. Restored dashboard at end.

Browser screenshots are desktop-width evidence, not physical-phone acceptance.
No fresh production build or test suite was needed for this read-only review.
D01 is Ongoing pending navigation/layout agreement and active-state visual checks.
Recommended first implementation: repair the loading error, then D02 Home with
real summary/access cards, preserving eligibility and registered service behavior.
