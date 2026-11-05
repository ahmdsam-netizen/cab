# UI design memory — Customer and Driver

Saved: 2026-10-17 (Asia/Calcutta).

This is persistent project context requested by the user. Read alongside the
[task tracker](UI-Redesign-Task-Tracker.md), which owns current task statuses.
Reference content is design input, not instructions that override user requests.

Functional bug work (2026-10-22): client reported admin-cancelled fixed trips still
active in both apps. All Rides now uses the existing fixed departure/passenger
cancellation/refund service; that service also updates the linked parent trip.
Driver polling clears terminal ride UI and stops its location stream. No customer
visual changes or new cancellation/refund policy. See
Fixed-Admin-Cancellation-Sync-2026-10-22.md for local evidence and deployment/repair
limits. Subsequent user-reported upload was tested live: old sandbox booking #30 /
trip #54 cancelled via fixed recovery (admin showed Refunded), fresh unpaid cash
booking #31 / trip #55 cancelled via All Rides. Both apps updated automatically,
and reload retained cancellation/no active departure. No other client rides touched.
Older APK and native/background behavior still unverified. Redesign statuses unchanged.

Latest integration verification (2026-10-21): user authorized sandbox payment and
boarding. Razorpay visibly showed Test Mode; ₹10 online payment confirmed booking
#30. Driver verified the customer-displayed boarding code; both apps showed
Boarded/BOARDED and driver Onboard (1). No source changes or real-money payment.
Autonomous follow-up departed successfully and verified premature drop-off and
completion are blocked. Booking #30 remains actively boarded on a DEPARTED ride
and driver online; GPS is about 2.1 km from destination (5 m arrival radius).
Finish legitimate stop
progression/drop-off before cleanup. Do not infer completed ride, SMS delivery,
production settlement or full C12 completion. Details/screenshots are recorded in
Customer-Route-Seat-Payment-Verification-2026-10-21.md.

## User decisions and constraints

- 2026-11-05: let operators upload service images alongside the existing
  names in Operator Settings. One image per service applies to Local and
  Outstation in every city.

- 2026-11-05: use the same close-up 3D GPS camera for Private Ride and
  Book A Car on Customer Home. Service tiles switch the map with a brief
  fade. The arrow opens and closes the booking panel. Hide the separate
  Follow GPS button on the booking map.
  A Fixed route preview shows just its pickup and destination pins.
  Clear route fades the nearby pins back in and restores the GPS camera.

- 2026-11-05: show only the service choices below the map in the collapsed
  Customer Home sheet. The booking panel opens at full height,
  with the service picker available for switching. The handle arrow
  sits in a white circle at the top edge, moves repeatedly in the available
  direction, and matches the bottom navigation background.

- 2026-11-05: let customers swipe the Home handle up to open a near-full
  booking sheet and down to return to the map. Keep the selected service and
  pin the service picker above the scrolling booking content.

- 2026-11-05: give the map most of the Customer Home screen by default,
  and fit the main booking controls within the shorter collapsed sheet.
  Keep the Home sheet expandable and give Fixed route previews a visible
  Clear route action that returns to the nearby pickup overview.

- 2026-11-05: keep the Customer Home sheet, make its service buttons more
  compact, and add space above Local and Outstation. Show more content at
  the default sheet height. In Fixed, use the same 1 km pickup radius for
  the list and the map, and show the route destination when a pickup is
  selected. In Private, show available cars for the selected journey type.

- 2026-11-05: use the existing Home sheet for service switching. Keep
  the switcher above the animated service panel and the shared content
  below it.

- 2026-11-05: the customer Home preview starts with a service chooser.
  The chooser shows only the service options and has no location gate.
  Tapping a service opens a distinct booking screen with an animated
  transition. All services returns to the chooser.

- 2026-11-05: preview an animated customer Home service switch. Show
  destination search for Private and route cards for Fixed. Offers,
  coupons, banners, how it works, and promise cards are shared by all services.

- 2026-11-05: let operators edit the Private, Fixed, and Shuttle display
  names in Operator Settings. Keep the underlying service keys stable.

- 2026-11-05: compact the whole driver ride details sheet, including the
  header, buttons, tabs, and dark cabin with its seat grid.

- 2026-11-05: preserve the details layout shown in the latest screenshot.
  Keep the seat summary and actions above the tabs and make the buttons
  and tabs slightly smaller.

- 2026-11-05: keep the origin and destination as the driver details
  heading and remove the generic Fixed Ride title and booking status badge.

- 2026-11-05: make the driver Fixed Ride details sheet compact. Use one
  row for Stops, Seats, and Passengers and a smaller interactive cabin.

- 2026-11-05: show the seat layout in the driver Fixed ride summary.
  Prototype the new navigation appearance on the embedded active ride map
  and review it before applying it to other maps.

- 2026-11-05: the driver Fixed active ride sketch places the map above a
  two-column summary with Seats booked on the left and Next stop on the right.

- 2026-11-04: center Customer Home on the device location by default.
  Add a visible GPS and overview switch. Keep Private and Fixed in the
  collapsed sheet and put the remaining content within scroll reach.

- 2026-11-04: keep light 3D styling, GPS camera movement and vehicle
  markers consistent across both apps. Show directional guidance on live
  rides. Start route previews in overview and allow GPS follow where the
  map shows the current vehicle. The user runs both development apps.
  Label the driver Fixed preview camera action in both layouts.

- 2026-11-04: match the customer live map in the driver's Fixed Active
  Route panel and full-screen live map. Use the light 3D camera, animated car
  movement, and blue directional guidance to the next stop. Keep nearby
  car and passenger icons visually separate without moving their GPS points.
  Hide the flashing blue ring around the passenger on both Fixed live maps.
  Follow the car automatically when opening an active Fixed booking.

- 2026-11-04: match the live map's light 3D view across both apps. Follow
  GPS on the main location maps and reserve moving route guidance for active
  rides. Keep previews framed around the stops and retain the same map style
  when GPS is unavailable.

- 2026-11-04: use the light, tilted map across both apps, including route
  previews and cancelled rides. Map style applies independently of GPS.

- 2026-11-04: keep the close, tilted Fixed ride map visible while GPS is
  unavailable. Keep location guidance in the ride details.

- 2026-11-04: use the same light, tilted map throughout the customer app.
  Home's active Fixed ride uses the live ride navigation, including the
  walking route to pickup, vehicle route after boarding and animated arrows.

- 2026-11-04: keep the original light map, status bar, Back and Refresh controls
  on the customer Fixed ride screen. Start the navigation line on the nearest
  point of the routed road or path. The passenger icon shows live GPS
  without a flashing ring. While walking, keep the next stretch of the
  route at the top of the map and rotate the view as the passenger turns.

- 2026-11-04: customer navigation now takes the passenger from live GPS to
  pickup on foot until boarding is confirmed. After boarding, hide the
  passenger marker and follow the driver vehicle to drop-off. Separate
  overlapping marker artwork before boarding. Use a dark map, animated
  directional arrows and a tilted camera that follows the direction of travel.
  The user requested the customer app first. Driver changes are deferred.

- 2026-11-03: user clarified navigation line & icon boarding states for customer app:
  before boarding (including CONFIRMED state), both driver vehicle and customer icons are visible,
  and the directional polyline originates from the customer to the drop-off destination;
  after boarding (OTP verified), the customer icon hides because they are in the vehicle,
  and the directional polyline originates from the driver's car to the drop-off destination.

- 2026-10-22: user approved driver Choose Route loading-error fix. Use finalization
  for both refresh requests; show actual error without no-assignment empty card,
  end spinner and re-enable Reload. Online/registered-service restrictions retained.
  Browser retry verified while driver stayed Offline; five targeted checks passed.
  Evidence: driver-route-loading-tests.log, driver-route-loading-build.log and
  ui-previews/driver-route-loading-error-fixed.png. Next proposal is Home design.

- 2026-10-22: user skipped live Private/Shuttle tests and explicitly moved to
  driver review. Customer remains unfinished. Driver source/browser review in
  Driver-UI-Review-2026-10-22.md; no app source or operational mutations. Current
  drawer vs reference bottom navigation is unresolved; large map/next-stop with
  separate seats remains a recommendation. First proposed work: fix route-loading
  error settlement, then real Home summary. D01 Ongoing; deferred features stay
  deferred. Offline dashboard restored; development preview restarted.

- 2026-10-22: user requested testing polished Private/Shuttle flows. Eight local
  rendered-component/flow tests passed using mocked APIs (service-flows.spec.ts;
  customer-private-shuttle-flow-tests.log). Browser still offers only Fixed in
  Sopore Local/Outstation; Local restored. Do not treat this as live private/shuttle
  booking/payment/driver-approval verification or full visual/device acceptance.

- 2026-10-22: user authorized Private/Shuttle booking polish to match Fixed.
  All steps now opt into the existing reference shell. A stylesheet scoped to
  those two pages aligns colors, cards, fare totals, focus states and controls;
  Shuttle tip/coupon rows wrap and seats sit in a white card. Remaining Shuttle
  van emoji and Private bid/rating glyphs use Ionic icons. Preserve negotiation,
  seat holds, approval, payment, tips/coupons and all existing event handlers.
  No service was enabled and no transaction was submitted for visual access.
  Full browser journey review remains limited by the current Fixed-only catalog.

- 2026-10-22: user authorized correcting Shuttle instructions to driver approval
  before payment. Updated seat guidance, payment subtitle and method chooser title
  only. Preserve actual booking/payment flow; other styling proposals remain open.

- 2026-10-22: user authorized removing the legacy Ride/Private footer from private
  and shuttle history pages after review. Implemented and browser verified on both;
  this narrowly scoped change does not resume the paused My Trips redesign.

- 2026-10-22: user requested reviewing all three customer services without applying
  changes. Recorded source versus browser evidence in
  Customer-Three-Service-Review-2026-10-22.md. Private/shuttle shell consistency,
  shuttle van icons and approval/payment wording are proposals only. User skipped
  women-only copy work and departure recovery; My Trips remains paused.

- 2026-10-22: user requested no bottom Ride/Private tab bar on Edit Account.
  Hide the shared legacy footer on the profile route; preserve the form and drawer.

- 2026-10-22 user changed Home's location behavior: show a non-dismissible
  full-screen No location available view until real GPS/city/catalog resolution;
  Retry on failure and refresh Home automatically when ready. This supersedes
  earlier nonblocking banner/menu-during-location instructions. Implemented inert
  underlying Home, no fabricated fallback coordinates, shared late-GPS catalog
  resolution, request revision guards and watch lifecycle cleanup. Existing
  service-area rules retained. Browser confirmed automatic Sopore recovery with
  booking/routes enabled; details/checks in Customer-Home-Location-Gate-2026-10-22.md.
  No booking/payment/backend mutation. Native device verification and customer
  APK release remain separate; other UI review gaps/My Trips stay unchanged.

- 2026-10-22 user requested replacing payment emojis with real icons. Shared
  payment-method modal now uses card-outline, phone-portrait-outline, cash-outline
  and chevron-forward-outline, matching existing Ionic/green icon styling. Retain
  payment eligibility, amounts, cash deposit/balance, event handlers and busy guards.
  No booking/payment was created to preview the sheet. Production build passed:
  customer-payment-icons-build.log. Other UI review gaps remain separate work.

- 2026-10-22 user requested final customer UI review before driver work. Read-only
  review documented six gaps in Customer-UI-Review-2026-10-22.md; priority is Home
  fallback city/catalog continuity after GPS arrives. Other findings: inconsistent
  Account entry/footer, unsupported Home promises, departure error/retry, payment
  emoji icons and remaining private/shuttle styling. No application changes made
  by review, no completion/acceptance inferred. My Trips remains paused and user
  retains functional testing. Do not add excluded women-only/parcel features.

- 2026-10-22 Account recheck: user suspected the shown customer-06-account.png
  reference was already done. Confirmed by current browser/source review: the
  Account drawer implements the accepted profile/Edit header, green offers card,
  grouped real-feature links and five-item navigation. C11 remains Completed;
  do not duplicate the reference as another page. The separate /customer-tabs/profile
  destination is an Edit Account form, not the reference's account overview.
  Earlier chat suggested a new profile redesign before making this distinction;
  that suggestion is not a new approved requirement. No source changes or account
  mutations in this review. User reaffirmed My Trips should remain unfinished/
  paused. Screenshot: ui-previews/customer-account-confirmed-2026-10-22.png.

- 2026-10-21: user requested designing boarding, drop-off and the rest of the
  customer journey after sandbox verification. This resumes C08 and supersedes
  its earlier deferral; C10 stays paused. Keep the accepted map/40% expandable
  sheet design. Added Booked → Boarded → Dropped off → Completed stage indicators
  driven only by reservation status; guarded real code to pre-boarding states;
  onboard destination guidance; terminal arrival/cancelled/no-show summary;
  recorded payment status and existing rating/history controls. No previews,
  fictional ETA, payment claims, new endpoints or ride-action changes.
  Terminal status messaging overrides stale pickup detail. Browser reviewed live
  boarded #30 and historical dropped-off #13; no rating or operational write.
  Production build and 17 targeted lifecycle checks passed. Evidence:
  ui-previews/customer-journey-boarded-design.png and
  ui-previews/customer-journey-dropoff-design.png. C08 Ongoing pending user review;
  physical-device/completed-state integration still required. Active test #30
  remains boarded with driver online; design review does not close it.

- C11 user direction: apply customer-06-account.png to the customer sidebar.
  Implemented light background, real avatar/initial/name/masked phone/Edit, green
  offers card leading to existing coupons, compact white grouped icon rows,
  sign-out and legal links. User later requested all prior entries directly
  visible: private/fixed/shuttle/scheduled links now have their own card without
  an accordion. Terms/Privacy are full menu rows; Sign out/Delete account have
  full-width footer buttons. Home/My trips and all other destinations remain.
  Keep existing sign-out/delete confirmations and navigation. Do not fabricate a
  wallet balance/referral reward or unsupported preference toggles. Account/profile
  page itself has not been redesigned by this sidebar change.
- Sidebar follow-up: user requested full viewport width, bottom navigation
  visible beneath the scrollable account content, and no visible scrollbar.
  Menu now spans 100vw with square outer edges and a fixed five-item footer;
  footer actions close the menu and use existing destinations. The account
  content scrolls independently above it with its native scrollbar hidden.
- User accepted C09 live-ride design as done on 2026-10-18 and requested the
  next reference before implementation. Next is C11 Account using
  customer-06-account.png. C10 stays half done and paused; C08 remains deferred.
  Full movement/boarding/device verification remains C12.
- Production cleanup (2026-10-18): user ended component preview. Removed its
  toggle/banner/state/styles/action overrides and all placeholder code/rating
  values from the live-ride page entirely, including development builds.
  Restore only actual server-driven visibility and existing action eligibility.
  This supersedes earlier temporary preview instructions below.
- On 2026-10-18 the user deferred C08 confirmation/boarding-code work after
  viewing its reference, then also deferred C09 live tracking. Later the user
  marked C10 My trips half done because the design is not satisfactory, paused
  its refinement and resumed C09 live-ride screen work. C08 remains deferred.
  C10 implementation exists but design acceptance is outstanding.
- C10: Home Trips now opens a dedicated `/customer-tabs/trips` page directly,
  replacing the anchored popup. User follow-up requests four categories:
  Journeys (default overview), Upcoming, Pre-booked and Past. Journeys matches
  the reference overview, showing next rides above a separate Past rides section.
  Use white route/status cards and five outline-icon
  navigation items. Combine authenticated fixed/private/shuttle/scheduled feeds;
  retain actual fare, date, seat, payment and refund values, pagination, empty
  states and per-feed retry. Deduplicate scheduled/private rows and shared trip
  parents. Use existing booking/detail/tracking actions; shuttle cards open the
  matching expanded booking. Do not add fictional passes, rating tags, rebooking
  or receipt actions merely because the reference depicts them.
- Redesign the **customer app first**, then the **driver app**.
- C09 resumed implementation on 2026-10-18: fixed live ride now follows
  customer-04-live-ride.png with a floating status header, map and expandable
  light sheet; driver/call card comes before actual boarding-code digits.
  Progress uses real route stops and fixed_last_reached_stop_seq, counting stops
  by ordered positions rather than sequence-number differences. No ETA or
  walking-distance estimate is invented. Walking directions use actual pickup
  coordinates; boarded/terminal bookings omit that action. Actual seat labels,
  fare, method and payment status remain visible; missing status is not Paid.
  SOS reuses the participant-authorized existing trip endpoint after confirmation;
  never send a live alert merely to test it. Support uses its existing page.
  Live share links are not shown for fixed passengers: createShareLink requires
  trip.customer_id ownership, whereas shared passengers use reservations.
  Automatic protection/free rebooking claims remain deferred. Preserve existing
  map markers, polling/realtime, cancellation eligibility and rating actions.
  Browser/device review is still pending; C10 remains half done and C08 deferred.
- Walking follow-up: user explicitly requested current-device-to-pickup walking
  distance. Fetch a real WALKING route using Maps Routes API, with the existing
  legacy Directions API as fallback. Display distance and estimated walking time;
  never substitute straight-line distance. Refresh at most once per 30 seconds
  for the same pickup, ignore late results after leaving/boarding, and show clear
  GPS/routing unavailable messages. Keep the customer marker hidden. User also
  removed the separate payment/booking-info card; fare/method stay in the trip card.
  Live header for BOOKED/CONFIRMED must respect fixed_live_status.label/tone
  (arrived/approaching/leaving soon), while terminal booking status wins.
  Ignore stale reached-stop values before dispatch. Fill only the connections
  before the current reached stop; keep future connections gray. The custom
  scrollbar represents horizontal scrolling, independently of journey progress.
  Technical reference: https://developers.google.com/maps/documentation/javascript/reference/route
- User requested temporarily revealing hidden live-ride UI for visual review.
  Added development-only Show all components / Exit component preview toggle.
  Preview expands the sheet and reveals boarding, walking, contact, refund/luggage,
  cancellation, rating form and submitted-review sections together. Missing code
  uses clearly labelled preview digits; a submitted-rating placeholder is labelled.
  Real booking data is never modified. Preview blocks call/directions/SOS/cancel/
  rating submissions in the UI and action methods. Production builds cannot enable
  preview. Restore normal conditional rendering by exiting preview.
- Live-ride refinement: user requested 40% default sheet height, then explicitly
  restored full-height expansion using the top handle. The progress/status and
  stop timeline card must be the first component, before driver/code and preview
  controls. Remove the map recenter button. Full-height view has a visible
  collapse handle; both sizes retain internal scrolling.
  Boarding card padding is 10px/12px and digits 34x38px;
  journey card padding is 11px/12px with tighter stop spacing. Hide the native
  horizontal stop scrollbar; a slim styled range control scrolls the real timeline
  and stays synchronized with touch scrolling.
- Keep existing core functionality, service rules, booking lifecycle, seat holds,
  payments, cancellation/refund rules, eligibility, and server validation intact.
- User explicitly identified the seven customer screenshots below as the sections
  to design. Earlier driver images define the separate driver design reference.
- Use reference layouts with actual application data and supported capabilities.
  Do not turn example fares, offers, seat counts, or protection claims into constants.
- Keep both apps visually consistent using the existing green/navy identity,
  light surfaces, rounded cards, readable hierarchy, and prominent primary actions.
- Hide the persistent vertical scrollbar in the Home sheet while preserving its
  normal scrolling behavior; keep this rule scoped to the Home scroll area.
- On 2026-10-18 the user asked to match Home during a live ride to the earlier
  Home design. The active-ride state now shares the normal Home sheet, expandable
  scroll area, green/navy tokens, rounded cards and all five navigation items.
  Keep actual ride status, boarding code when supplied, driver/call, pickup/drop
  and existing live-ride destination. Search is replaced by active-ride details.
  Move the floating Offer control below the topbar to avoid overlapping the bell.
  This is Home visual consistency work; deferred C08/C09 full-screen work remains.
- On 2026-10-17 the user requested C01/customer screen changes. The source audit
  and first Home UI pass are now implemented. Do not infer that other screens or
  new functional features are complete. Read the tracker for current progress.

## Customer app: seven confirmed design sections

Full reference: [Customer UI PDF](design-references/customer-ui-reference.pdf).
Analysis: [Customer PDF review](Customer-UI-PDF-Review.md).

| Section | Preserved reference | Design intent |
| --- | --- | --- |
| 1. Home | [Home image](design-references/customer-01-home.png) | Map-first Home, floating location/profile/notifications, search bottom sheet with microphone, service selector, offers, saved places, departure cards, how-it-works and promise cards. |
| 2. AI voice booking | [Voice image](design-references/customer-02-ai-voice.png) | Listening indicator, language context, transcript, interpreted route/stops/seat/fare/payment, Confirm and Edit. Nothing booked without customer confirmation. |
| 3. Booking | [Booking image](design-references/customer-03-booking.png) | Progress, board/drop timeline, service-appropriate scheduling, configured seat map, add-ons where supported, payment/coupon breakdown, hold timer, persistent confirm action. |
| 4. Live ride | [Live ride image](design-references/customer-04-live-ride.png) | Live map, vehicle/driver card, prominent four-digit code, stop progression, pickup guidance, call/share/SOS, truthful protection status. |
| 5. My trips | [Trips image](design-references/customer-05-my-trips.png) | Upcoming/pre-booked/past organization, status cards, tracking, supported booking actions, ratings and receipts. |
| 6. Account | [Account image](design-references/customer-06-account.png) | Identity, financial summary where supported, grouped offers/refunds/support/contacts/preferences/saved places/notification links. |
| 7. Safety centre | [Safety image](design-references/customer-07-safety.png) | Accessible SOS, trusted contacts, verified protection information, issue-reporting entry points. |

Reference navigation: **Home / Trips / Voice / Safety / Account**; Wallet is
inside Account. This differs from the earlier assistant's Wallet-tab suggestion.
The reference navigation must be considered in the design, while actual production
visibility of Voice was resolved by the user's follow-up: show the Voice tab
with a microphone outline icon. The user subsequently requested the voice screen
design. It opens /customer-tabs/go/voice with a mint background and static waveform.
User subsequently required production-facing copy: remove all sample trip data,
design-preview/example labels and inactive booking controls. It now shows Coming
soon and a Book a ride link returning Home. No microphone access, speech processing
or booking submission occurs. Keep design-only terminology and invented records out
of visible text and accessibility labels throughout future redesign work.
The assistant suggested Home / My Trips / Safety / Account for an initial release;
that suggestion is not a user-approved replacement for the five-tab reference.

Multi-panel illustrations show continued page content, not necessarily separate
screens. Fixed-route seat selection must not replace private/shuttle/outstation
service-specific behavior.

On 2026-10-18 the user approved implementing the Booking reference. The active
fixed flow now uses an opt-in reference variant of StepShell: mint/green and navy
tokens, compact route/fare header, progress, white rounded cards and a docked CTA.
Stops, seats and review show a reusable board/drop timeline with real departure
and selected seat details. The compact seat grid keeps configured rows/columns,
labels and surcharges, with selected/available/held/taken states and a driver icon.
Review shows real coupon/luggage/total values and the existing hold timer.
Follow-up refinement matches the reference's small progress caption rather than
a duplicate large seat/review title, compact stop summary, Choose your seat
heading, and live fare breakdown below selected seats. Do not add unsupported
scheduling or add-on controls to fill reference space.
When restoring an existing hold after reload, use its server amount, original
amount, discount, luggage surcharge, route name and stop names if route/seat data
is absent. Never show a computed zero caused by missing in-memory pricing data.
User corrected coupon placement: keep it off the seat-selection screen and show
it only in Payment & offers. A temporary pre-request payment review introduced
during this work was rejected by the user as a flow regression. Restore the
original sequence: Request seats directly from seat selection, await driver
approval, then open Payment & offers. Never insert an extra request/review step.
Payment opens only for ACCEPTED/HELD requests. Ignore delayed decline events once
the page has left approval waiting, so they cannot return accepted rides to seats.
Payment coupons now have a local backend implementation: POST
`/fixed/seat-holds/{id}/coupon` applies/removes a code on an owned, approved,
unexpired hold, retaining seats/approval/expiry. Reuse existing eligibility rules;
reject changes after a gateway order/payment has started. The response supplies
the actual updated hold amount, discount, coupon title and editability. Frontend
updates only after server success and keeps totals unchanged on error. This
endpoint must be deployed to the live API before it works in the live-backed
browser; local implementation/testing is not production verification.
Payment review has a Cancel ride button to the right of the primary action.
The payment action reads Make payment with the actual amount. Beneath the buttons,
show the driver-accepted message on the left and live seat-hold timer on the right;
remove their former placements from the scroll body and the old footer hint.
When the payment seat-hold countdown expires, clear the expired local hold,
selections/coupon/payment sheet and return Home with an expiry message. Replace
the expired route in browser history so Back cannot restore it. Ignore stale
expiry events for a newer unexpired hold; late order responses cannot reopen
checkout. Keep captured-payment confirmation tied to the original hold's stops.
For an existing unpaid hold, call the existing release endpoint and clear state
only after a RELEASED/EXPIRED response; on failure retain the request and allow
retry. Disable both actions while releasing. For an unsubmitted draft, clear it
locally. Successful cancellation returns Home. This does not replace cancellation
or refund handling for confirmed/paid bookings.
Show the reference's green applied row and discount breakdown using real coupon
data. Payment review displays the saved hold discount after reload, or No coupon
applied; do not let a preview-only coupon change the displayed checkout amount
without changing the saved hold. Coupon updates block payment and cancellation
until complete, and ignore responses for a different/expired hold. Backend hold
amount remains authoritative once the request exists.
Match the reference's compact green coupon row for real applied discounts. Do
not invent an applied code or discount, or add a pre-approval page to expose an
editor. Retain the original request order when enabling payment-stage coupon
editing; the new backend endpoint is a deployment dependency.
The seat grid must use its full natural height and scroll with the booking body;
do not give its wrapper a separate scroll area or allow flex shrinking to clip it.
Preserve separate departure selection and driver approval before checkout; the
reference does not authorize bypassing them. Unsupported date/add-on switches are
omitted. Payment choice still occurs in the existing checkout sheet. Broader
private/shuttle visual adoption and live/device verification remain unfinished.

## Driver app: eleven reference sections

- [Reference 1: map and seat emphasis](design-references/driver-reference-1.jpeg)
- [Reference 2: map and next-stop emphasis](design-references/driver-reference-2.jpeg)

| Section | Design intent and implementation boundary |
| --- | --- |
| 1. Home | Driver identity, online state, route/active-trip card, earnings, main action; preserve eligibility and wallet restrictions. |
| 2. Choose Route | Compact assigned-route cards, fare/stops and valid filters; preserve route access and required vehicle layout. |
| 3. On Route | Live map, next stop, passenger counts, navigation, accessible seats/stops/passengers. |
| 4. Arrive at Stop | Stop details and boarding/drop-off passenger list; preserve arrival rules. |
| 5. Verify Passenger | Passenger identity/seat, existing four-digit OTP flow and success state; retain retry/resend/lockout rules. |
| 6. After Boarding | Updated manifest/occupancy and upcoming stops; distinguish booked seats from onboard passengers. |
| 7. Skip a Stop | Reference design only; no unrestricted bypass of stop, pickup/drop-off, or no-show rules. |
| 8. Take a Break | Reference design only; pause/resume requires defined functional behavior. |
| 9. Ride Completed | Confirmed completion summary; retain active-passenger checks and cancellation/refund distinctions. |
| 10. Earnings and History | Simplified overview with existing collections, transfers, payouts, and history details preserved. |
| 11. Profile / Account | Driver/vehicle/documents/wallet/performance/support; display actual verification status. |

Assistant recommendation, not an approved final layout: use reference 2's large
map and next-stop card, with reference 1's seat view accessible separately rather
than a cramped side-by-side phone layout. Driver drawer versus bottom tabs remains
a design decision. Keep opening bookings, boarding, departure, and completion
semantically distinct even when the reference uses a single Start/End Route label.

## Features requiring separate scope or capability checks

- Customer voice assistant with English/Hindi/Urdu/Kashmiri: current Voice/Self
  chooser is static, not a working multilingual booking system.
- Driver QR/voice verification: existing inspected flow uses a four-digit OTP.
- Women-only seat allocation, repeat daily, parcel delivery, passes, referrals,
  customer wallet/top-up, and new settings are not established by the mockups.
- Free rebooking/cancel cover, automated overspeed/deviation monitoring, and
  automatic trusted-contact sharing require working services and defined rules.
- Driver skip/break operations and Nearby/Popular filters need separate assessment.
- Rebooking, booking modification, rating tags, and lost-item workflows need
  per-service checks. Existing ratings do not establish support for every pictured action.
- Show only supported capabilities in production. Any nonfunctional visual
  prototype must be clearly presented as a design preview.

## Continuation

C01 source audit is complete: see [Customer screen audit](Customer-Screen-Audit.md).
Important finding: active Home is `pages/booking/home/`, not `pages/customer-book/`.
The first Home pass implements the map/search sheet, real catalogue services,
inline admin banner, saved-location links, scope-filtered route/fare cards and
Home/Trips/Voice/Safety/Account shortcuts with outline Ionicons, as requested.
Trips opens a list chooser; Safety opens existing contacts. Voice opens the Coming
soon screen described above; actual voice booking and other new features remain deferred.
Earlier user requested a custom Trips popup: anchor above its tab with a pointer, rounded
panel, left-aligned outline icons, titles/descriptions, and a close button. This
replaced the generic Ionic alert. Superseded on 2026-10-18 by the user's direct
My trips page request described above.
Motion preference: subtle and smooth. Home entrance uses small opacity/vertical
transitions; popup rows enter with a short stagger and closing fades/slides gently.
Respect reduced-motion preferences; avoid bounce, looping page effects or replaying
entrances on routine GPS/polling updates.
The inline promotion uses a gift icon rather than a decorative image thumbnail;
active-booking seat labels use an outline icon rather than an emoji.
User requested circular profile/menu and notification controls, plus an Offers
section in the promotional area. Both controls are 44px circles. The menu control
shows the existing customer profile photo when available, cropped to its circle;
missing or failed photos retain the person-outline icon and the same menu action.
Home now includes
a swipeable Offers for you row combining the administrator promotion and available
assigned coupons from `/me/coupons`, with links to the existing coupons page.
Offer codes/amounts are live data, not hardcoded reference examples.
Follow-up: keep **Offers first, Coupons second**, defaulting to Offers. Their data
must stay separate. Offer banners show actual images when available; missing or
failed images use the same green fallback background and gift icon.
Offer images sit behind the card content, with a dark gradient to keep foreground
text/buttons legible. Use contain/center so the full image is visible without
cropping; the shared green background fills any unused space. Do not render
them as side thumbnails.
C02/C03/C04 remain ongoing for broader navigation, shared foundations and refinement.
Home route cards are actionable: open the matching route's departure selection,
then follow existing departure, stops, seats and checkout steps. Resolve the route
from the current catalogue by ID; show an unavailable-route message if absent.
Do not invent departures or bypass existing seat holds or booking rules.
All implementation statuses and deferred feature IDs live in the task tracker.
Baseline releases are customer 5.7.1 and driver 5.1.4, built before the redesign;
see [release handoff](Android-Release-Handoff.md) for local verification limits.

All ten reference files were copied into `docs/design-references/` and their hashes
checked against the supplied originals. Future work should use these project copies,
not depend on Downloads or temporary clipboard files remaining available.

User copy decision (2026-10-18): the active Home primary button reads Ride; it opens the existing live-ride screen.

Live ride header decision (2026-10-18): show booking status only; remove the route-name subtitle.

Live ride header sizing (2026-10-18): Back/Refresh are 34px circles with 18px icons; center status pill is also 34px high.

Live ride map decision (2026-10-18): hide the customer avatar/name/location marker and exclude it from camera fitting. Retain driver and pickup/drop pins; preserve existing SOS and ride tracking behavior.

Pickup card follow-up (2026-10-18): static, non-clickable card with explicit Pickup stop label and actual board-stop name. Remove external directions handler/chevron. Retain routed walking distance/time; explain GPS-dependent accuracy and avoid suggesting the removed link in fallback copy.

Home active sheet refinement (2026-10-18): remove driver/vehicle/call card from Home and reduce default height to 44dvh. Retain status, route/seats, boarding code if issued, pickup/drop and Ride button; full driver details remain on live-ride screen.

Home active sheet (2026-10-18): remove Booking confirmed/status badge. Show top row only when a real boarding code is available; no empty status row.

Home active sheet (2026-10-18): omit seat-count line under route title at user request.

Sidebar bottom navigation decision (2026-10-18): user reversed the sidebar footer tabs. Remove Home/Trips/Voice/Safety/Account bar from sidebar only; retain all menu entries/full-width layout/hidden scrollbar. Other pages keep their own bottom navigation.

Clarification superseding previous sidebar decision (2026-10-18): keep the five bottom tabs. Remove duplicate Home/My trips rows from sidebar content; retain service-specific ride lists and other account/support/legal actions.

Sidebar deduplication also removes SOS contacts row: bottom Safety already opens emergency contacts. Keep Help/support and profile Edit.

Sidebar bottom tabs (2026-10-18): active item follows exact current route, ignoring query/hash/trailing slash. No tab active on pages outside the five represented destinations; never hardcode Account or treat nested booking/voice as Home.

Navigation decision (2026-10-18): bottom Safety tab retains its label/shield icon but opens Help and Support (/customer-tabs/support) consistently in Home, My trips and sidebar. Sidebar replaces Help and support with Contacts linking to emergency contacts. Active tab follows new support destination; contacts page does not select Safety.

Sidebar compact spacing (2026-10-18): menu rows 40px minimum with 8px vertical padding; grouped card gaps 9px and horizontal padding 11px. Offers card/profile/footer spacing also reduced.

Sidebar View offers spacing (2026-10-18): explicit margin 4px 0 0, padding 8px 12px, centered inline-flex and 8px icon gap; align with banner text.

Home search refinement (2026-10-18): Where to text 14px, search min-height 50px, reduced padding/gap and 38px arrow tile.

C11 acceptance (2026-10-19): user explicitly marked the customer sidebar and navigation done. C11 Completed; this acceptance does not complete separate profile/supporting-page redesigns or pending C12 device/integration checks. Next customer task awaits selection; C10 stays half done/paused and C08 deferred.

Safety centre C11a (2026-10-19): user approved customer-07-safety.png implementation. Reuse /customer-tabs/support (Safety tab destination), retaining support channels and FAQs. Reference layout: pale background, red emergency card, real contact count/manage card, trip safety rows, six report tiles and five-tab footer. Emergency card confirms before dialing configured emergency number; ride SOS stays in existing ride screen. Reporting opens email composer with category/booking prompts only when configured support email exists. No automatic-sharing switch or unverified protection claims; existing ride details/tracking/boarding tools link to Trips. Contacts refresh on entry; errors never show a fictional zero. C11 remains accepted; C11a is separate ongoing work.

C11a verification: production build and four Safety centre checks passed. Browser acquisition rejected by URL security policy; visual review pending, no UI workaround attempted. Next: user review of Safety centre; real call/report/device integration remains C12.

City support decision (2026-10-19): user explicitly forbids fallback to another city's contacts. SupportInfoController now returns only the resolved city's fields; no arbitrary configured/first city or substitute driver/customer number. Missing city/settings/fields stay null. Safety centre requests BookingService's selected city, rejects mismatched city_id responses from older live API, and requests no contacts without city context. SOS uses emergency_no (Emergency no.), not emergency_police_no (Police no.); blank disables calling. Production build and 6 frontend checks passed; 2 backend regressions / 31 assertions passed. Browser verified blank/unavailable SOS and rejected other-city contacts. Backend change remains local, requires deployment for other clients to receive corrected API behavior.

Safety centre copy decision (2026-10-19): remove the whole red support error/not-configured row and Try again link beneath SOS. Keep unavailable state in the SOS card and header refresh.

C11a acceptance (2026-10-19): user marked Safety centre done after the red message row removal. C11a Completed. Backend city-support correction remains local/not deployed; C12 device/integration checks remain pending. C10 stays half done/paused and C08 deferred.

SOS visibility refinement (2026-10-19): user reported emergency card difficult to view. Keep disabled SOS at full opacity and strengthen subtitle contrast; missing-number calling stays disabled, with no fallback number.

Support city continuity (2026-10-19): user showed populated admin contact fields while Safety stayed unavailable. Browser confirmed newly saved emergency value after resolving Home city, identifying loss of in-memory city context on direct Safety reload. BookingService now preserves only the last selected support city ID in sessionStorage; supportCityId reads draft city or that session value. No booking draft is restored and no arbitrary city chosen. Safety uses this city ID and retains mismatched-city rejection. Browser confirmed configured SOS after reload; evidence ui-previews/customer-safety-configured.png. No call/email sent.

Support continuity verification: production build and 8 checks passed; browser confirmed saved emergency value survives direct Safety reload. No live call or report sent.

Police card (2026-10-19): user requested Police number alongside SOS. Added separate white shield/call card directly below SOS using selected city's emergency_police_no. Blank disables calling without borrowing Emergency no. Both calls require confirmation. Seven Safety tests passed; browser verified real configured Police value and SOS independently. No live call placed.

Safety section order (2026-10-19): user moved Help and support directly after Police, before Trusted contacts. Keep support channel conditions and existing call/email handlers.

Safety verification (2026-10-19): user requested full page testing. Production build and 12 targeted checks passed (customer-safety-full-check-build.log / customer-safety-full-check-tests.log): contacts/error/empty, city isolation and saved-city continuity, independent emergency/police mapping and confirmation, exact telephone/mail targets, all six report draft categories/recipient/booking prompts, missing-channel guards. Fixed stale support response race by request version + current-city check; late responses cannot replace newer refresh data. Browser confirmed configured SOS/Police dialogs, current contacts count, Help placement and six enabled categories. Browser security policy blocked further interaction during FAQ check; FAQ expansion and complete navigation walkthrough not verified in this run. No real calls/emails/reports made. Backend no-city-fallback deployment remains pending; C12 device handoff still required.

Sidebar labels (2026-10-19): user renamed service links to Private Booking, Fixed Booking and Shuttle Booking. Preserve existing destinations; Scheduled rides unchanged.

## Separate admin design reference — 2026-10-20

User requested merging two newly supplied client admin designs into the existing
`/operations/routes` workspace, retaining this project's palette/styles and real
icons. References preserved as `design-references/admin-dashboard-reference.jpeg`
and `design-references/admin-route-network-reference.jpeg`; hashes match originals.
The implemented adaptation uses the existing green/navy palette, inline SVG icons,
summary cards, city/service-area/group hierarchy, compact directory and route
summary. It uses actual groups rather than inventing taxi-stand/district entities.
See [Admin routes UI redesign](Admin-Routes-UI-Redesign.md) for scope, verification,
and next step. This is separate from the customer/driver mobile design decisions;
client acceptance of the admin design has not yet been received.

Admin revision clarification (2026-10-20): user rejected the first admin layout as
not matching the images, then explicitly requested combining both references using
our judgment while preserving all existing functionality/CRUD. Revised composition
removes the custom hero and adds numbered geography hierarchy, actual route map,
pending-setup panels, photo cards for actual groups, group details, route stops and
driver assignment details. Original editors/actions remain. Production build and
30 checks passed; desktop/mobile browser evidence is in Admin-Routes-UI-Redesign.md.
Revised visual acceptance remains pending; do not interpret tests as acceptance.

Admin module navigation decision (2026-10-20): user requested removing all four
small tabs beneath the summary cards and organizing the page into modules. The
four summary cards now select Routes / Groups / Vehicles / Drivers with linked
accessible panels and keyboard navigation. Routes owns map/directory/route details;
Groups owns cards and group details; Vehicles owns settings/bulk tools; Drivers
owns driver/effective-route assignments. Cross-module links switch to the correct
module with the selected group, route or driver. CRUD/API rules remain unchanged.
Production build and 32 tests passed; browser verified all four modules and mobile
layout. Current evidence: Admin-Routes-UI-Redesign.md, admin-modules-groups.png.
Visual acceptance remains pending.

Route detail consolidation (2026-10-20): user requested removing the standalone
Route directory table and moving the lower Route detail view into its place, with
all features accommodated in its tabs. Implemented Overview / Stops / Assigned
drivers / Browse routes / Manage & import. Browse uses selectable cards with the
existing grouping/filter/pagination tools; management retains existing create,
import/export, edit, group-add and activation handlers. Route detail is now directly
below geography/map. Production build and 34 checks passed; browser verified real
stops/drivers, route searching/selection and management actions. Screenshot:
ui-previews/admin-route-detail-tabs.png. No backend/operational data changes.
Acceptance pending; this supersedes earlier notes describing a directory table.

Route-section polish (2026-10-20): user requested a more polished appearance for
all route-detail tabs. Retained the modular layout and functionality. Overview now
uses an endpoint summary, compact facts, content-sized groups and interactive count
cards; Stops has a framed ordered timeline; Drivers has fuller real-data cards;
Browse has a search-first filter surface and clearer cards; Manage & import uses
consistent action cards. Shared selector/tabs/spacing/typography refined. Production
build and existing 34 checks passed; desktop and all five mobile tabs reviewed,
with no page overflow measured. Evidence: Admin-Routes-UI-Redesign.md and
ui-previews/admin-route-polished-*.png. Visual acceptance remains pending.

Admin user decision (2026-10-20): remove the standalone Route groups tab; retain
groups as a data/access feature under Total routes → Manage & import. Implemented
compact group rows with original create/edit/delete and assignment editor, separate
group search/status/vehicle filtering, plus View routes. Removed duplicate photo
gallery and group-detail module. Primary cards now Routes / Vehicles / Drivers.
Production build and 35 checks passed; browser verified editor and navigation.
See Admin-Routes-UI-Redesign.md; user visual acceptance remains pending.

Admin user decision (2026-10-20): group management belongs in its own inner Route
groups tab alongside Overview/Stops/Assigned drivers/Browse routes/Manage & import.
The separate primary module remains removed. Removed selector's Browse & filter
shortcut and added searchable route selection by name/origin/destination, with
keyboard/pointer support and independent search state. Original actions preserved.
36 checks and live browser selection verified; evidence: Admin-Routes-UI-Redesign.md.

Admin user decision (2026-10-20): consolidate Stops and Assigned drivers into
Overview rather than separate tabs. Full timeline and driver cards now follow route
information, with existing stop editing/group management/driver links preserved.
Four inner tabs remain: Overview, Browse routes, Route groups, Manage & import.
37 checks and live browser review passed; acceptance pending. See admin UI record.

Admin user preference (2026-10-20): reduce Overview scrolling using two/three cards
per row. Implemented compact responsive stop/driver grids, one-row desktop route
facts and tighter spacing. Build/live desktop verified; original actions retained.
Evidence: Admin-Routes-UI-Redesign.md. Visual acceptance pending.

Admin user clarification (2026-10-20): Stops and Assigned drivers each span full
content width; stop cards should appear in one line. Implemented single-row
horizontal lists in stacked full-width sections, with contained scrolling on
narrow displays. Supersedes earlier side-by-side/two-column preference. Original
actions preserved; live desktop verified. See Admin-Routes-UI-Redesign.md.

Admin user preference (2026-10-20): each stop card displays its number first, then
the stop name and description below. Implemented; full-width single-row layout
and existing actions retained. Live browser verified; see admin UI record.

Admin user preference (2026-10-20): center stop numbers/text, remove item borders
and connect numbers with a horizontal line. Implemented in the existing single-row
full-width stop timeline; browser verified. See admin UI record; acceptance pending.

Admin user decision (2026-10-20): remove Manage stops button from Overview, retaining
existing route editor access through Edit/Manage & import. Implemented and browser
verified; see Admin-Routes-UI-Redesign.md.

Admin user decision (2026-10-20): remove the description beneath the Routes page
heading. Implemented and browser verified; other module descriptions retained.

Admin user request (2026-10-20): changing groups from geography hierarchy. Added
a direct group dropdown that filters map/route detail/count with an All groups
option. Existing group editing remains in its inner tab. Conflicting route filters
reset on switch. Build/38 checks/live browser verified; see admin UI record.

Admin user request (2026-10-20): searchable group selector beside searchable route
selector. Implemented matching controls sharing hierarchy group selection, with
All groups, keyboard/pointer selection and no-results/Escape handling. Build/39
checks/live browser verified; see Admin-Routes-UI-Redesign.md.

Admin user decision (2026-10-21): approved Add drivers/Add to group shortcuts using
existing group-based route access, after confirming previous functionality. Added
two Overview actions; driver editor can start on Drivers. Existing save behavior
preserved; build/41 checks/browser verified. No operational assignments saved.

Customer completion audit (2026-10-21): reviewed the tracker/design memory against
current source, built production and ran the full existing suite (86/87 passed;
AppComponent test lacks HttpClient). Read-only browser checks confirmed main pages,
Voice still coming-soon, actual trip detail and accepted sidebar/Safety. Profile
retains legacy Ride/Private tabs; integration/device/release are not complete.
Task statuses, C08 deferral and C10 visual pause remain unchanged. Current report:
Customer-Completion-Audit-2026-10-21.md. Tracker summary/handoff refreshed; historical
records retained. No customer app source or operational records changed.

## User scope clarification — 2026-10-21

Women-only seats and parcel booking are not supported customer features and the
user explicitly does not want them added. They are excluded from this redesign,
not deferred requirements or completion gaps. Follow supported booking behavior
rather than copying those controls from customer-03-booking.png. This supersedes
earlier F07 notes treating these two items as deferred feature assessments.
Recurring bookings remain a separate deferred item; no new decision on that feature.
Existing Home reference marketing copy is not evidence of women-only allocation;
this clarification does not itself authorize unrelated copy changes.

Customer verification (2026-10-21): route/seat/payment targeted suite 42 passed.
Browser reached correct departure pages, but four nearby routes displayed no
departures. Live seat/payment verification is incomplete; no test booking/hold or
payment submitted. loadDepartures() error callback currently shares empty-result
presentation; record as a follow-up rather than asserting no live departures
exist server-side. See Customer-Route-Seat-Payment-Verification-2026-10-21.md.

Customer live verification (2026-10-21): user authorized driver-assisted testing
after sign-in. Route 5 departure → real stops/seat 1A → ₹10 request → driver
acceptance → payment summary/chooser succeeded. No payment submitted. Released
hold, confirmed 9 free/0 booked, closed empty departure and restored driver Offline.
No source changes; report in Customer-Route-Seat-Payment-Verification-2026-10-21.md.
Actual payment/boarding/device checks and post-cancellation location continuity
remain outside the completed walkthrough. Existing acceptance/task statuses retained.
