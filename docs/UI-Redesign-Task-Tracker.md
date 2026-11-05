# Customer and Driver UI Redesign — Task Tracker

Last updated: 2026-11-05 (Asia/Calcutta)

## Start here

- Operator service images (2026-11-05). Services now supports uploading,
  replacing, and clearing the image for Private, Fixed, and Shuttle alongside
  their display names. The admin uses clickable image tiles with hidden file
  inputs. Verified all three tiles in the local browser after the restyle.
  Customer Home and the driver profile service picker
  read the image from the shared catalogue. Verified all three pickers in the
  local admin browser, compiled all three Angular apps, and passed seven
  backend settings tests. The migration ran on the local development database.
  Next, verify the client's chosen images in both apps after deployment.

- Customer Home map and route preview (2026-11-05). Private and Fixed tiles
  switch map layers with a short fade and keep the booking sheet closed.
  Both use the shared close-up 3D GPS camera. The booking map hides the
  separate Follow GPS control. A Fixed route preview fades out other pins,
  frames the selected pickup and destination, and restores the nearby pins
  and GPS camera on Clear route. Verified the service switch, two-pin
  preview, label framing, and clear action in the browser at 479 × 681.
  All 24 targeted Home tests passed. Next, check heading changes on a
  moving phone.

- Customer Home map framing (2026-11-05). Private Ride and Book A Car
  share a GPS-centered neighborhood overview. Marker refreshes leave the
  camera alone, so a car beside the passenger cannot cause extreme zoom.
  Verified Private → Book A Car → Private in the browser at 479 × 681.
  Each map showed zoom 14.75. All 24 Home tests passed. Next, check the
  overview while moving with device GPS.

- Customer Home sheet handle (2026-11-05). The circular arrow overlaps the
  collapsed sheet edge. It moves repeatedly up to open and down to close.
  The sheet and bottom navigation use the same background. Verified both
  animation directions and tap controls in the running browser at 479 × 681.
  Angular template and Sass checks passed. Next, confirm on a physical phone.

- Customer Home service picker (2026-11-05). The mobile sheet shows just
  service choices over the map when collapsed. Tapping a service opens a
  full-height booking panel above the tab bar. The map keeps its viewport
  behind the panel. Verified at 479 × 681 in the running browser app:
  both service tiles open, the picker stays visible while scrolling,
  dragging down returns to the Fixed map, and tapping the handle closes
  Private. All 23 targeted Home tests and compilation checks passed.
  Next, confirm the touch gesture on a physical phone.

- Customer Home swipe sheet (2026-11-05). Swipe up on the handle for
  the expanded booking panel or swipe down to return to the map. Tap also
  works. The service picker stays above scrolling content, and collapsing
  returns to the current service's booking controls. All 23 targeted Home
  tests passed, along with Angular template and Sass compilation checks.
  Next, check the swipe and scroll feel on a phone.

- Customer Home map and sheet (2026-11-05). Restored the collapsed sheet
  to 32% of the phone viewport within a 196–270 px range. The compact
  phone layout places service icons beside the labels and goes straight
  to the Private and Shuttle booking buttons. Sass compilation passed.
  Clear route removes the
  selected destination pin and returns to the nearby pickup overview, which
  passed the earlier 22-test Home suite. Next, check the booking controls and
  map framing at the reported phone viewport.

- Customer Home nearby services (2026-11-05). The default sheet shows more
  content with smaller service buttons and more space above the journey
  switch. Fixed cards and map pins share a 1 km straight-line pickup filter.
  Tap a pin to preview its pickup and route destination. Private shows
  available cars for the selected journey type. All 21 targeted Home tests,
  Angular template checks, Sass compilation, and PHP syntax checks passed.
  The backend feature test requires local Composer dependencies. Next, review
  the map with device GPS and an online Private driver.

- Customer Home service switcher (2026-11-05): service choices sit at
  the top of the existing Home sheet. Switching animates the service
  panel below. Private shows search and saved places, Fixed shows routes,
  and Shuttle shows its booking entry when available. The map and shared
  content stay on Home. All 20 targeted Home tests passed. Next, review
  the transition on the local Home screen.

- Superseded Customer Home service preview (2026-11-05): the earlier
  prototype used
  `/customer-tabs/go?servicePreview=1` to review the service chooser.
  The first screen shows only service choices and defers its location
  request until a service opens. It uses Private and Fixed examples
  until the catalog arrives.
  Selecting a service opens an expanded screen with a distinct header and
  an animated transition. All services returns to the chooser.
  Private shows destination search, Fixed shows routes,
  and Shuttle shows its booking entry when enabled. Offers, coupons, banners,
  how it works, and promise cards are shared. All nine targeted Home tests
  passed at that stage.

- Operator Settings service names (2026-11-05): the Services tab contains
  the name fields above the Local and Outstation switches. Admins can set global
  display names for Private, Fixed, and Shuttle. The customer booking
  selectors and driver profile picker read the display names from the
  catalog. The local migration ran, all three Angular compilations passed,
  and a rolled-back database check verified saving and resetting the names.
  Next, verify the labels in a catalog with active services.

- Driver Fixed Ride details buttons (2026-11-05): gave boarding and
  departure the primary green treatment and used a lighter red outline
  for cancellation in the summary card.

- Driver Fixed Ride sheet sizing (2026-11-05): reduced the route header,
  summary spacing, ride buttons, tabs, and cabin footprint within the
  existing layout. Next, check the fit at the user's mobile viewport.

- Driver Fixed Ride details refinement (2026-11-05): kept the summary,
  tabs, and cabin layout from the user's screenshot. The header shows the
  route only. Reduced the height of ride buttons and tabs slightly.

- Driver Fixed Ride details redesign (2026-11-05): the route name is
  the sole heading. Tabs sit directly under it, seat counts sit with the
  cabin, and ride actions stay in a footer. Seat buttons use a top-down
  seat shape. All nine Fixed Ride UI tests passed. Next, review the revised
  sheet in the local driver preview.

- Driver Fixed Ride details (2026-11-05): redesigned the sheet with
  compact ride actions, a single row for Stops, Seats, and Passengers,
  and a smaller cabin. Next, review the details sheet on the driver's
  mobile preview with occupied and held seats.

- Driver Fixed active ride prototype (2026-11-05): shows the vehicle's
  seat layout in the summary card, using live seat states. The embedded
  map uses a steeper 3D camera that looks ahead of the car, a more visible
  route line, and a next-stop panel with routed distance when available.
  Next, review the prototype at mobile width before any wider rollout.

- Driver Fixed active ride layout (2026-11-05): used the supplied sketch
  to place the live map first, with Seats booked on the left and Next stop
  on the right below it. Ride actions sit below the summary. Next, review
  the layout in the driver preview with a long stop name.

- **Done — Customer and Driver navigation lifecycle implementation**
  (2026-11-05). Both apps passed Angular compilation. The live device
  walkthrough remains a separate verification item covering GPS follow,
  boarding, drop-off, and ride completion.

- Cross-app map recheck (2026-11-04): reviewed all 16 map constructors.
  Driver Dashboard has a ride card and opens its map from the ride screen.
  Matched customer pickup and drop guidance to the driver's blue route
  style. Driver Private and Shuttle now retain the first GPS fix while
  the map loads and can recover after a GPS timeout. Angular compilation
  passed in both apps. Next, verify movement, boarding and overview
  switching in the user's local walkthrough.

- Customer Home map and sheet (2026-11-04): Home and the location button
  request a fresh device fix. Ride catalog responses no longer move the map
  back to earlier coordinates. Added GPS and overview switching and reduced
  the collapsed mobile sheet to show the ride choices first. Next, verify
  device location and scrolling in the user's local walkthrough.

- Driver Fixed booking GPS (2026-11-04): both Active Route maps now
  draw the car and begin following from the initial GPS fix or an existing
  fix. A watch timeout no longer disables follow. Before the first fix,
  the map opens close to the next stop. Driver Angular compilation passed.
  Next, verify booking entry and recovery from a delayed fix locally.

- Driver Fixed preview controls (2026-11-04): labeled the camera action
  Follow GPS or Route overview in both inline and full-screen previews.
  Waiting for GPS explains when follow is unavailable. Next, check both
  states in the user's local walkthrough.

- Map consistency across both apps (2026-11-04): checked all 16 map
  constructors against the shared light 3D settings. Customer booking
  follows GPS until manual map interaction or route selection. Customer
  live maps face the routed road after boarding. Driver Private and Shuttle
  use the same animated car, camera, and road guidance as Fixed. The Fixed
  stop map follows GPS, and the Fixed route preview can switch between
  GPS follow and the stop overview. Angular compilation passed in both
  apps. Next, check movement, heading, and preview switching during the
  user's local walkthrough.

- Driver Fixed passenger marker (2026-11-04): disabled the flashing blue
  ring in Active Route and its full-screen map. Verified both marker calls
  in source. The user will check the live preview.

- Driver Fixed live navigation (2026-11-04): matched the customer map's
  animated camera and blue arrows in Active Route and its full-screen map.
  The camera faces the road ahead, and the line starts on the routed road.
  Both maps cancel animations and pending route results on exit. Nearby
  passenger badges shift above the car and retain a dotted line to their
  actual map position. Next, verify turns, stop changes, and marker
  separation on a device.

- Customer and driver map follow (2026-11-04): all 16 Google Maps views
  use the shared light vector settings with a closer starting camera. Customer
  Home and Driver Dashboard follow GPS outside rides. Driver Fixed now shows
  next-stop guidance in the embedded live map and keeps the GPS camera during
  marker refreshes. Preview and selection maps frame their content. Driver
  History has no map. Source audit and TypeScript passed for both apps. Next,
  verify walking and driving turns and GPS recovery on a device.

- Customer and driver map style (2026-11-04): applied the light vector map
  and tilt to all seven driver map views and verified the shared style in
  all nine customer map views. Both apps restore tilt after fitting a
  route. Cancelled Fixed rides open close to pickup. Both TypeScript checks
  passed. Next, recheck the cancelled ride and driver route in the browser.

- Task 1 customer map audit (2026-11-04): checked all nine customer map
  constructors for the shared light vector style and tilt. Home's active
  Fixed ride and the shared Private/Shuttle live screen now stay close to
  the relevant stop while GPS is unavailable. Private/Shuttle keeps watching
  through GPS errors. Old Fixed map links for active bookings redirect to
  the live ride screen. Browser verified the redirect and blue walking route
  on booking #44. Development build and TypeScript passed. Next, verify
  Private/Shuttle navigation, movement and boarding on a device.

- Task 1 Fixed map without GPS (2026-11-04): replaced the wide overview
  during an active ride with the close, tilted camera centered on the
  relevant stop while waiting for a location. Location guidance is in the
  ride details. Live routing still starts when a location is available.
  TypeScript passed. The browser preview could not be rechecked this turn.

- Task 1 Fixed booking entry (2026-11-04): renamed the details action to
  Open ride. The live map now starts with a recent GPS fix when available,
  watches for updates while requesting a fresh fix, and retries GPS on
  Refresh. The map explains when location is needed. Browser checked booking
  #44 from the Fixed list and saw the tilted walking route after GPS returned.
  TypeScript passed. Next, verify movement and boarding on a device.

- Task 1 customer map rollout (2026-11-04): applied the light vector style
  and tilt to all nine customer map views. Home's active Fixed ride uses the
  same navigation renderer and pins as the live ride screen. Home keeps the
  map clear of floating promotions during an active ride. Browser verified
  booking #44 on Home with the tilted map, road-aligned blue route and
  separate passenger and driver markers. Development build
  `4246608105a6f204` passed. Next, verify Home during movement and boarding.

- Task 1 walking camera (2026-11-04): the customer map points along the next
  segment of the walking route and smoothly rotates as GPS progress moves
  around a corner. A simulated east-to-north turn and TypeScript passed.
  Next, verify rotation during a real walk and check the boarding transition.

- Task 1 Fixed passenger marker (2026-11-04): removed the flashing blue ring
  around the passenger icon. The icon still uses live GPS. TypeScript passed.
  Live movement and boarding remain to be checked on a device.

- Task 1 Fixed map palette (2026-11-04): restored the light map at the user's
  request. Booking #44 showed the light map, tilted view and blue route from
  the road to pickup. TypeScript passed. Next, verify live movement and
  boarding on a device.

- Task 1 customer map follow-up (2026-11-04): restored the original light
  Fixed ride status bar, Back and Refresh controls. The customer navigation
  line now starts on the nearest segment of the routed path as GPS updates.
  Booking #44 showed the gap between the route start and passenger icon in
  the browser. TypeScript and two off-road GPS projection checks passed.
  Live movement and boarding still need device verification.

- Task 1 customer navigation update (2026-11-04): Fixed and the shared
  Private/Shuttle live screen now request walking directions to pickup before
  boarding and driving directions from the vehicle to drop-off afterward.
  Added dark vector maps, a tilted camera with smooth heading changes,
  animated chevrons, and visual separation for overlapping live markers.
  Browser verified Fixed booking #44 before boarding with the blue route
  ending at Sopore-Kupwara Rd, moving arrows, a rotated map and distinct
  passenger and vehicle markers. Development build and TypeScript check
  passed. Next: verify live movement and boarding on a device, then review
  driver navigation separately.

- Task 1 customer visual review (2026-11-04): Fixed booking #44 was confirmed
  before boarding. Browser showed the green directional route, the blue
  Sopore-Kupwara Rd pickup pin and an approximately three-minute walk. Both
  live markers were present but visually overlapped. The default map view cut
  off the route at the details sheet; panning revealed the red PWD RND Stop
  drop-off pin. The details sheet expanded and collapsed. Next: verify the
  map during vehicle movement and after boarding. Review only.

- Task 1 live ride attempt (2026-11-04): opened the ₹10 Model To Adda Sopore
  Fixed departure from the driver app. The live driver map showed seven stops,
  Sopore-Kupwara Rd as the next stop, a Navigate action, and 0 of 9 seats booked.
  Customer route selection stalled, then showed no active fixed routes on reload.
  The alternate Fixed booking page also showed no matching routes. No seat was
  booked. The departure was left open for review. Next: diagnose the customer
  catalog response, then book on the matching departure and compare both maps.

- Task 1 browser check (2026-11-04): Customer My Trips loaded with only past
  rides, and Upcoming showed no rides. The live map review needs an active
  test ride. No new booking was created during this check.

- Task 1 review setup (2026-11-04): started both local development previews and
  opened Customer Home (`127.0.0.1:8100/customer-tabs/go`) and Driver Choose Route
  (`127.0.0.1:8200/tabs/fixed`) in the browser. Customer Home rendered after the
  location gate. The driver route list was still loading when checked. Next:
  open an active test ride and verify the passenger icon, pickup marker, and
  navigation before and after boarding. Task 1 remains pending visual review.

- Driver vehicle icon consistency (2026-11-04): checked the shared
  `car-marker.helper.ts` use in Dashboard, Fixed Driver, Fixed Driver Map, and
  Rides. These live map views update the same car marker, bearing, and configured
  image/fallback. Marked done based on source audit; no separate browser pass was
  performed.

- Live navigation route with directional chevrons (2026-11-03): user requested
  in-app navigation route showing directional arrows/chevrons on the map as the
  driver or vehicle moves towards pickup or drop. Implemented customer-first,
  then driver:
  - Created `NavigationRouteRenderer` in `customer-mobile/src/app/core/navigation-route.helper.ts`
    and `driver-mobile/src/app/core/navigation-route.helper.ts` supporting dual-layer
    polylines (white casing underlay + vibrant green/blue route), repeated directional
    chevrons (`FORWARD_CLOSED_ARROW` every 65px), DirectionsService road pathing with
    geometric fallback, and dynamic real-time path trimming (`updateDriverProgress`).
  - Customer app: updated route origin & marker visibility per user direction.
    Before boarding (CONFIRMED / ASSIGNED / EN_ROUTE_PICKUP / ARRIVED_PICKUP):
    both driver car and customer icons are visible; directional navigation line
    originates from the Customer to the Drop-off Destination (showing the full ride path).
    After boarding (OTP verified / EN_ROUTE_DROP / ARRIVED_DROP): customer icon is
    hidden (passenger is inside the car); driver car icon is visible; navigation line
    originates from the Driver's car to the drop-off destination and dynamically trims as
    the car advances.
  - Driver app: wired into `rides.page.ts` (private rides) and `fixed-driver-map.page.ts`
    (fixed-route driver map) with live GPS watch progress trimming.
  - Both development builds succeeded with code 0 (`customer-mobile` hash ad2c214af3c19caf,
    `driver-mobile` hash 99b5b8b5f6ecdb32). Next step: user visual check of navigation
    corridors on active rides.

- Driver route-loading fix (2026-10-22): user approved correcting error recovery.
  Both refresh requests now use finalize to settle loading on success/error;
  hide unassigned-route empty state on error. Browser confirmed Offline restriction
  retained, spinner gone and Reload enabled/retry working. Five targeted checks
  passed (3 loading, 2 cancellation sync); logs: driver-route-loading-tests.log and
  driver-route-loading-build.log (production build passed, hash 99c81c68d74b4da0).
  Screenshot: ui-previews/driver-route-loading-error-fixed.png.
  No online toggle, ride or payment mutations. Next proposal: D02 Home redesign;
  D01 remains Ongoing and customer deferred work unchanged.

- Driver review started (2026-10-22) at user's explicit request after skipping
  customer Private/Shuttle live tests. Compared both driver references with source
  and browser dashboard/earnings/profile/vehicle/history/offline route guard.
  Found fixed route loading remains true on request error; redesign proposals
  cover clearer Home summary, compact routes, focused active/boarding/completion
  and preserved earnings/account capabilities. See Driver-UI-Review-2026-10-22.md.
  No driver app source/operational changes; restarted dev preview successfully.
  D01 Ongoing; next proposal: loading error repair, then D02 Home. Customer
  unfinished/skipped tests and My Trips pause remain unchanged.

- Private/Shuttle test pass (2026-10-22): user requested testing. Eight rendered
  component/flow checks passed in ChromeHeadless with mocked APIs: Private fare
  guide and minimum-offer guard, Shuttle chooser/no premature create, unavailable
  fare guard, booking busy guard, seat availability/hold success/failure, navigation
  to approval/payment list and cash deposit/discount/tip display. Evidence:
  customer-private-shuttle-flow-tests.log; service-flows.spec.ts. Browser rechecked
  Sopore Local and Outstation: only Fixed offered; restored Local. No live private/
  shuttle booking, payment or driver approval tested, no service configuration
  changed. Next: full live journey/visual checks with enabled services and test
  data. Existing production build remains valid; only test/docs added this turn.

- Private/Shuttle booking polish (2026-10-22): user approved applying the review
  proposals for presentation. Both flows now use Fixed's reference StepShell on
  all steps, matching cards/fare styling and responsive tip/coupon controls;
  Shuttle van visuals and Private offer/rating glyphs use Ionic icons. Existing
  handlers/TypeScript flows unchanged. Production build passed, hash
  c9b80242036a7b3e: customer-private-shuttle-polish-build.log. No live booking,
  catalog changes or payment; full browser journey verification still needs
  enabled Private/Shuttle services and test data. C02-C07 remain Ongoing.
  Next: visual verification when services are available; My Trips paused and
  departure recovery skipped as instructed.

- Shuttle instructions (2026-10-22): user authorized text correction. Seat guidance
  now explains continuing to bookings and paying after driver acceptance; payment
  subtitle and method chooser title use the same approval-first wording. No flow,
  amounts, status or payment handler changes. Source verified and TypeScript
  check passed (tsc -p tsconfig.app.json --noEmit); live later steps
  remain unavailable without an enabled service/test booking. Next: remaining
  private/shuttle presentation review proposals; My Trips stays paused.

- Private/shuttle history footer (2026-10-22): user authorized removing the
  legacy Ride/Private tabs from both pages. Hidden in both tab-navigation handlers.
  Browser verified neither page exposes the tab group; screenshots:
  ui-previews/customer-private-no-footer.png and customer-shuttle-no-footer.png.
  No booking/data changes. Other My Trips redesign remains paused; next proposal
  remains Shuttle flow wording and private/shuttle presentation review findings.

- Three-service review (2026-10-22): user requested review only. Fixed is closest
  to reference; private/shuttle need shell consistency. Shuttle retains van emojis
  and conflicting old payment-step content versus the current approval/list path.
  Browser inspected Fixed routes/empty departures and empty private/shuttle lists;
  Home offers only Fixed in Sopore, limiting live booking coverage for other modes.
  No app changes or transactions. See Customer-Three-Service-Review-2026-10-22.md.
  Next proposal: reconcile Shuttle flow wording, then presentation; await user
  direction. Departure recovery skipped; My Trips paused; statuses unchanged.

- Edit Account footer (2026-10-22): user requested removing the bottom Ride/Private
  tabs on this form. Hidden for the profile route in both navigation handlers;
  profile editing and the existing Account drawer remain unchanged. Browser verified
  no tab group on Edit Account; screenshot: ui-previews/customer-edit-account-no-footer.png.
  Next: remaining customer review gaps; departure recovery remains skipped.

- Home location gate (2026-10-22): user requested a non-dismissible full-screen
  No location available view, Retry and automatic Home refresh. Implemented real
  GPS-only unlocking, city/catalog synchronization, stale-response guards and
  watch cleanup. Browser confirmed location view → Sopore with booking/routes
  enabled. See [location gate record](Customer-Home-Location-Gate-2026-10-22.md)
  for checks/device/release limits. Nineteen targeted checks and production build
  passed. C04 remains Ongoing; other review gaps unchanged.

- Payment icons (2026-10-22): user requested real icons. Replaced the shared
  payment chooser's online/UPI/cash emojis and text chevrons with Ionic outline
  icons. Applies to fixed/private/shuttle flows; no payment logic changes. Build
  passed: customer-payment-icons-build.log. Other UI review findings stay open.

- Final customer UI review (2026-10-22): read-only source/browser review found
  Home's fallback service city can stay stale after GPS arrives, Account entry
  opens Edit Account with legacy two-tab footer, unsupported Home promise copy,
  departure empty/error recovery gap and payment emojis. Fixed results and
  accepted Account remain aligned. No app mutations/source edits; My Trips stays
  paused. Details/next order: [UI review](Customer-UI-Review-2026-10-22.md).

- Account reference recheck (2026-10-22): current browser confirms C11's reference
  is already implemented in Account drawer. No duplicate redesign needed; C11
  stays Completed. Separate Edit Account form is distinct. My Trips remains
  unfinished/paused per renewed user direction. Read-only review; no app changes.

- Client bug fix (2026-10-22): All Rides fixed cancellation updated only Trip,
  leaving mobile departure/reservation data active. Connected the fixed refund/
  cancellation path and linked Trip synchronization; driver terminal-manifest
  polling clears the active screen and location streaming. Four backend tests /
  69 assertions, two driver checks and production driver build passed. Verification and
  delivery limits: [cancellation fix](Fixed-Admin-Cancellation-Sync-2026-10-22.md).
  User subsequently reported upload; live browser verification passed (see below). Redesign
  acceptance/task statuses are unchanged by this functional fix.

- Post-upload cancellation verification (2026-10-22): reconciled our old sandbox
  booking #30 / trip #54 through fixed vehicle cancellation; customer automatically
  showed Cancelled, driver cleared active ride, admin showed Refunded/seat released.
  Then created unpaid cash booking #31 / trip #55 and cancelled via All Rides:
  both apps updated automatically. Reload retained cancellation and no active driver
  departure; driver restored Offline. No cash collected. Older APK/native background tests remain unverified;
  unrelated client trip #53 was not changed. Customer 18 / driver 2 / backend 4
  regression checks remain recorded. See fix record for evidence/cleanup.

- User scope clarification (2026-10-21): **women-only seats and parcel booking are excluded**. Do not add them or count their absence against completion.

- Latest integration evidence (2026-10-21): Razorpay **Test Mode** ₹10 online
  payment confirmed booking #30; customer-displayed OTP verified in driver app,
  showing BOARDED / Onboard (1) and customer Boarded. It then departed and verified
  premature drop-off/completion guards. **Superseded test state:** booking #30 was
  cancelled/refunded in the authorized post-upload cancellation test on 22 Oct;
  fresh unpaid test #31 was also cancelled. Physical drop-off/completion remain
  untested; cancellation cleanup does not certify those steps. See
  [verification record](Customer-Route-Seat-Payment-Verification-2026-10-21.md).

- Delivery order: **customer app first, then driver app**.
- Current completion audit: [2026-10-21 customer audit](Customer-Completion-Audit-2026-10-21.md).
- **Customer redesign is not finished:** 5 customer task rows Completed, 8 Ongoing,
  2 Pending. These counts are not an effort-based completion percentage.
- C01 source audit, C07a payment expiry, accepted C09 live-ride design, C11 Account
  sidebar and C11a Safety centre retain their Completed statuses and limits.
- C02-C07 remain Ongoing. Home/fixed booking/reference screens are implemented in
  part; shared shell consistency, other-service coverage and verification remain.
- C08 resumed on user request for boarding/drop-off design (2026-10-21). C10 My trips data/navigation exists, but its visual
  design was called half done and paused; no later acceptance recorded.
- C12 integration/device checks and C13 redesigned release/handoff remain Pending.
- Fresh production build passed. Full existing suite: 86 passed / 1 failed out
  of 87; AppComponent test lacks HttpClient provider. See audit/logs for evidence.
- Browser smoke check confirmed Home, Trips, Voice coming-soon, Safety/FAQ,
  completed ride detail, profile and sidebar. Profile still uses legacy Ride/Private
  tabs. GPS stayed pending during this run; no location setting was changed.
- Coupon and city-support backend deployment status was not verified. Dated
  implementation notes say local changes; do not infer current production state.
- [UI design memory](UI-Design-Memory.md) records user decisions and preserved
  references. Deferred functional requests are separate from approved UI work.
- Preserve booking rules, payments, permissions and server validation. No live
  booking/payment/SOS or deployment was submitted during the audit.

## How to maintain this tracker

Use **Pending**, **Ongoing**, **Completed**, or **Blocked** in task tables.
Keep the task ID stable when updating descriptions or splitting work.

- Mark a task Ongoing when work starts; record the exact next step at handoff.
- Mark Completed only when its deliverable and relevant verification are recorded.
- For Blocked tasks, record the reason and what resolves it.
- Update this file after each completed module or meaningful change in direction.
- Separate proposed designs, implemented changes, local checks, device checks,
  and client feedback. A successful build alone does not establish runtime quality.
- Keep release-signing details in [Android release handoff](Android-Release-Handoff.md).
  Do not put passwords or private keys in this tracker.

## Completed groundwork and baseline releases

| ID | Work | Status | Evidence / limitation |
| --- | --- | --- | --- |
| P01 | Analyze both supplied driver UI reference images | Completed | Images show 11 driver journey sections; analysis recorded in this chat. |
| P02 | Compare references with current driver code | Completed | Reviewed dashboard, route selection, manifest, seat map, OTP, earnings, history, and profile flows. Code review only. |
| P03 | Identify changes that exceed a visual redesign | Completed | QR/voice verification, unrestricted stop skipping, and break/resume require separate functional assessment. |
| P04 | Outline a matching customer UI direction | Completed | Initial proposal recorded below; detailed customer audit and designs remain pending. |
| P05 | Build current driver release for client sharing | Completed | CABBIES 5.1.4 (514); signed APK verified. No phone test or client delivery performed. |
| P06 | Build current customer release for client sharing | Completed | DREAMCABS 5.7.1 (571); signed APK and packaged production bundle verified. No phone test or client delivery performed. |
| P07 | Establish modular app-specific tracker | Completed | This file. Implementation sequence starts at C01. |
| P08 | Review customer UI PDF | Completed | All 8 pages reviewed; seven customer sections, scope gaps, code checks, and navigation differences recorded in Customer-UI-PDF-Review.md. C01 remains pending. |
| P09 | Preserve both apps' design context | Completed | UI-Design-Memory.md records constraints, screen designs, proposals, and functional boundaries. Ten original reference files copied into docs/design-references/ and verified by hash. AGENTS.md points future work to these records. |

Baseline APKs, built **before the redesign**:

- Customer: `release-apks/DreamCabs-Customer-5.7.1-release-2026-10-17.apk`
- Driver: `release-apks/Cabbies-Driver-5.1.4-release-2026-10-17.apk`

## Design direction and open decisions

Confirmed constraints:

- The supplied images concern the **driver app**, primarily fixed-route operations.
- The seven customer screenshots subsequently supplied by the user confirm the
  customer design reference: **Home, AI voice booking, Booking, Live ride,
  My trips, Account, and Safety centre**. They match the customer PDF sections.
  Earlier driver images remain the driver reference.
- Customer work comes first; driver work follows customer validation and handoff.
- Preserve existing core functionality in both apps.

### Confirmed customer reference sections

| Section | Visual work to plan | Existing task / scope boundary |
| --- | --- | --- |
| Home | Map-first layout, search sheet, service selector, banners, saved places, departure cards | C02–C05; retain supported services and real data. |
| AI voice booking | Listening/transcript, interpreted trip summary, Confirm/Edit states | C02 design coverage; F06 functional work remains deferred. A visual prototype must be labelled as a preview; do not imply production voice booking works. |
| Booking | Stop timeline, configured seat map, payment/coupon summary, hold timer, persistent confirm action | C05–C08; add-ons remain F07, subject to separate assessment. |
| Live ride | Map, driver/vehicle details, boarding code, stop progress, pickup guidance, safety actions | C08–C09; automated protection/free rebook remain F08–F09. |
| My trips | Upcoming/pre-booked/past cards, supported trip actions and rating presentation | C10; new actions/passes remain F10/F12 pending capability checks. |
| Account | Profile, financial summary where supported, grouped settings/support links | C11; unsupported wallet/referral/pass/preferences functions remain F10–F11. |
| Safety centre | Dedicated layout for SOS, contacts, verified protection status, and reporting entry points | C02/C09/C11; expose only functioning actions/statuses. Automatic alerts/sharing remain F09. |

The reference includes five tabs: Home / Trips / Voice / Safety / Account.
Preserve this in the design specification; decide production visibility of Voice
in C02 based on the agreed functional scope. User confirmation of these sections
does not establish that every pictured feature already exists or authorize changes
to the app's core operating rules.

Proposed direction, still subject to the screen audit and design review:

- Shared visual language: existing green/navy branding, white cards, consistent
  typography and spacing, rounded controls, and clear primary actions.
- Customer journey: find route → choose seats → book/pay → track → show boarding
  code → complete trip.
- Driver layout: use Image 2's map/next-stop emphasis with an accessible seat view
  inspired by Image 1. Avoid squeezing a map and vehicle side by side on phones.
- Customer navigation proposal: Home / My Trips / Wallet / Account. Validate
  actual routes and available wallet functions before adopting this structure.
- New customer PDF proposes Home / Trips / Voice / Safety / Account, with Wallet
  inside Account. Revised recommendation: Home / My Trips / Safety / Account
  using verified working safety tools; defer Voice navigation until functional.
  Resolve this in C02; no navigation choice has been implemented or approved.
- Preserve access to other supported customer services while improving fixed-route
  booking. Do not infer that every existing page needs a redesign.
- Example names, fares, distances, counts, and vehicles in the images are sample
  content. Display actual data; hide unavailable information or explain its state.

## Phase 1 — Customer app

Implementation root: `customer-mobile/`.
C01 source audit is complete. The user requested the first screen changes, so the
Home portion of C02/C03/C04 was delivered incrementally. Finish the remaining
layout/shared-foundation work before expanding to other screens. Use existing
services and server actions; record data gaps rather than inventing behavior.

| ID | Module / task | Status | Deliverable and completion criteria |
| --- | --- | --- | --- |
| C01 | Current journey and screen audit | Completed | Customer-Screen-Audit.md maps active Home, all three booking flows, seat/approval/payment lifecycle, tracking, codes, trip lists and supporting pages. Source audit plus targeted browser checks; full trip/device validation remains C12. |
| C02 | Screen structure and design review | Ongoing | User requested all five reference Home/Trips/Voice/Safety/Account tabs with outline icons. Home navigation now matches; Trips opens the unified /customer-tabs/trips page, Safety opens /customer-tabs/support. Voice shows a production-facing Coming soon view with a Book a ride link to Home; sample data and design labels removed. Functional voice assistant remains F06. Remaining page layouts and shared navigation pending. |
| C03 | Customer visual foundations | Ongoing | Home has page-local green/navy tokens, cards, controls, notices, responsive sheet and focus/reduced-motion support. Shared extraction and other-page adoption pending. |
| C04 | Home and customer navigation | Ongoing | First pass implemented: location/notifications header, search sheet, scope/modes, real banner, saved links, real fixed-route previews and information cards. Existing active-ride sheet preserved. Build/regression/browser checks recorded below; review, supporting-page navigation consistency and device/active-ride checks remain. |
| C05 | Route results and details | Ongoing | Fixed route/departure screens adopt reference shell, live fare badge, icons and progress. Stops summary added. Existing search, city, scope, radius and selection rules retained. Other services and live departure/device review remain. |
| C06 | Seat selection | Ongoing | Compact configured seat grid, selected/available/held/taken legend, driver icon and live stops/fare summary implemented in fixed booking. Hold/approval rules unchanged. Render tests verify held-seat blocking, pricing and request action. Device/conflict/expiry checks remain C12. |
| C07 | Booking summary and payment | Ongoing | Fixed review now shows stops/seats, payment guidance, applied coupon and actual fare/luggage/discount/total breakdown, timer and docked checkout action. Existing payment chooser and processing retained. Isolated render check passed; live success/failure and other-service UI remain. |
| C07a | Payment hold expiry returns Home | Completed | User confirmed completion. Expiry clears local booking/payment state and replaces the expired page with Home. Production build and 25 checks passed, including real timer expiry and delayed checkout response. |
| C08 | Booking confirmation and boarding code | Ongoing | User resumed boarding/drop-off/completion design on 2026-10-21. Added real-status journey stages, boarding code treatment, onboard destination and terminal summary; preserved API/action rules. Browser checked onboard #30 and dropped-off #13. See latest handoff for checks and remaining review. |
| C09 | Live tracking and active journey | Completed | User accepted live-ride design as done on 2026-10-18. Final implementation includes status-only header, driver/pickup/drop map pins, progress-first 40%/full-height sheet, real code and walking-route distance, static pickup card, and existing ride actions. Preview controls/placeholders removed. Production build and 14 page checks passed; browser verified actual live data and layout. No deployment/APK performed; real movement/boarding/device integration remains C12. |
| C10 | Completion and trip history | Ongoing | Half done; user is not satisfied with the design and requested pausing visual refinement. Dedicated /customer-tabs/trips replaces Home popup with Journeys/Upcoming/Pre-booked/Past, real service feeds, pagination, retry and existing detail/tracking links. Production build and 9 checks passed; browser verified actual active/past bookings. Design acceptance, further refinement and service/device checks remain. |
| C11 | Account sidebar and navigation | Completed | User accepted completion on 2026-10-19. Full-width compact sidebar, real profile, offers, grouped service/account/legal links, retained bottom bar, exact route highlighting, Contacts and Support routing implemented. Production build and five sidebar/navigation checks passed during implementation; browser evidence recorded below. Separate profile/supporting-page redesigns and C12 device checks are not closed by this acceptance. |
| C11a | Safety centre | Completed | User accepted completion on 2026-10-19. Reference layout, configured emergency call confirmation, real trusted contacts, ride-tool links, six email report categories, support/FAQs and five-tab footer implemented. Strict city scope and Emergency no. mapping corrected; red message row removed. Production build, six frontend checks and two backend tests (31 assertions) passed; browser evidence recorded below. Backend correction is local, not deployed; C12 device/integration checks remain pending. |
| C12 | Customer integration and verification | Pending | Verify booking through completion, seat conflicts/expiry, payment success/failure, cancellations, back navigation, session continuity, loading/empty/offline states, and small-screen/keyboard layout. Record actual checks and unresolved issues. |
| C13 | Customer release and handoff | Pending | Build and verify signed release APK; record version, artifact, screenshots, and device-check results. Capture client feedback when received. Record completion and remaining issues before starting driver implementation. |

Customer audit starting points (not yet a verified screen mapping):

- `customer-mobile/src/app/app-routing.module.ts`
- `customer-mobile/src/app/customer-tabs/` and `customer-mobile/src/app/tabs/`
- `customer-mobile/src/app/pages/customer-book/` and `pages/booking/`
- `customer-mobile/src/app/pages/fixed-book/`, `pages/fixed-bookings/`,
  `pages/fixed-route-map/`, and `pages/fixed-ride-active/`
- `customer-mobile/src/app/pages/customer-trips/`, `pages/trip-active/`,
  `pages/trip-details/`, and `pages/trip-history/`

## Phase 2 — Driver app

Implementation root: `driver-mobile/`.
Original order was customer integration/release handoff before driver work. On
2026-10-22 the user explicitly moved to driver review while customer live/device
verification remains incomplete. Reuse customer visual conventions while
preserving driver-specific controls; do not infer customer acceptance.

| ID | Module / task | Status | Deliverable and completion criteria |
| --- | --- | --- | --- |
| D01 | Driver audit refresh and layout plan | Ongoing | Source/browser refresh recorded in Driver-UI-Review-2026-10-22.md. Layout/navigation proposals need agreement; active-state/device checks remain. |
| D02 | Driver visual foundations and Home | Pending | Clear identity, online status, route/active-trip access, and earnings summary. Preserve approval, wallet eligibility, registered service, and online/offline restrictions. |
| D03 | Route selection and booking setup | Pending | Compact assigned-route cards with real data and existing city/scope filters. Preserve layout selection and separate opening bookings from boarding/departure. |
| D04 | On-route map, next stop, and seat view | Pending | Clear navigation and next-stop summary with passenger/stops/seats access. Preserve configured layouts, seat blocking, pending seat requests, live location, and manifest updates. |
| D05 | Stop arrival, boarding, and drop-off | Pending | Focused stop passenger view and redesigned four-digit verification flow. Preserve arrival requirements, resend/lockout rules, drop-off, cancellation, and no-show safeguards. |
| D06 | After-boarding and stop progression | Pending | Refresh passenger/seat counts and upcoming stops from real state. Distinguish reserved seats from onboard passengers; preserve existing stop progression. |
| D07 | Completion summary and ride controls | Pending | Clear summary after confirmed completion. Preserve active-passenger checks and distinguish completion from cancellation/refund actions. |
| D08 | Earnings and ride history | Pending | Simpler overview and compact lists while retaining cash/online splits, operator collections, transfers, pending payouts, and existing filters. |
| D09 | Profile and account | Pending | Clear driver, vehicle, document, wallet, performance, and support access using actual verification status. |
| D10 | Driver integration and verification | Pending | Verify opening bookings, seat requests, boarding, departure, pickup/drop-off, no-show, cancellation/refunds, completion, eligibility, and location updates. Record visual/device checks and unresolved issues. |
| D11 | Driver release and handoff | Pending | Build and verify signed release APK; record version, artifact, screenshots, device checks, and client feedback when received. |

Driver audit starting points:

- `driver-mobile/src/app/pages/dashboard/` and `src/app/tabs/`
- `driver-mobile/src/app/pages/fixed-driver/`
- `driver-mobile/src/app/pages/earnings/`, `pages/trip-history/`,
  `pages/profile/`, and `pages/wallet/`

## Deferred functional requests — outside the UI implementation scope

These are **not committed tasks** in the phases above. Keep them separate unless
the user explicitly expands scope and their behavior/data requirements are resolved.

| ID | Reference feature | Reason deferred |
| --- | --- | --- |
| F01 | QR passenger verification | Requires a real token and scanning/verification flow; the inspected fixed-route driver flow uses a four-digit code. |
| F02 | Voice verification | Requires defined behavior, supported services, and verification rules. |
| F03 | Skip Stop action | Must account for pickup/drop-off obligations, arrival, grace periods, and no-show rules; cannot be a visual bypass. |
| F04 | Break / resume during a route | Requires defined availability, booking, tracking, and passenger-notification behavior; no matching operation found in the inspected fixed-route flow. |
| F05 | Nearby / Popular route filters | Add only if backed by defined criteria and available data. Preserve current supported filters meanwhile. |
| F06 | Customer multilingual AI voice booking | PDF page 3: English/Hindi/Urdu/Kashmiri. Existing mode chooser is static; requires a functioning assistant and confirmation flow. Distinct from driver voice verification F02. |
| F07 | Recurring bookings | Requires separately agreed recurring booking/payment rules. Women-only seats and parcels are explicitly excluded by the user on 2026-10-21; they are not missing work or redesign requirements. |
| F08 | Free rebooking / cancel cover | PDF pages 2 and 5: requires defined eligibility, inventory, payment/refund rules, and operational support. |
| F09 | Automated safety monitoring and sharing | PDF pages 5 and 8: route deviation, overspeed, automatic trusted-contact links, and delivery need verified services and consent behavior. Existing SOS/share are partial foundations. |
| F10 | Customer wallet/top-up, referrals, passes | PDF pages 6–7: verify customer capabilities separately from driver wallet/subscriptions before committing. |
| F11 | Language/voice, Easy mode, Low-data mode | PDF page 7: real preferences must change supported app behavior; requires separate capability assessment. |
| F12 | Modify/rebook, rating tags, lost-item reporting | PDF page 6: check existing per-service support before adding these actions; existing star/comment ratings do not establish tag support. |

## Session handoff

- Latest work: 2026-10-21 customer boarding/drop-off/completion design requested by
  user, resuming C08. Added status-driven stages, guarded real boarding code,
  onboard destination, arrival/interrupted summary, recorded payment status and
  existing rating/history controls. No new API or ride/payment rules.
- Browser verified real boarded booking #30 and existing dropped-off #13 without
  submitting any operational changes or reviews. Screenshots:
  ui-previews/customer-journey-boarded-design.png and customer-journey-dropoff-design.png.
- Production build passed (customer-journey-design-build.log). All 17 targeted lifecycle
  checks passed (customer-journey-design-tests.log). Historical full suite
  AppComponent HttpClient harness issue is separate and remains unresolved.
- Next: user visual review of C08; verify confirmation/completion on devices and
  finish active test ride #30 legitimately. C10 visual work remains paused;
  C12 integration and C13 release remain Pending. Driver redesign follows customer.
- Preview restarted at http://127.0.0.1:8100/customer-tabs/go for local review;
  environment uses the live API. No operational mutations were submitted.
- No customer application source was changed by this audit. Build/test outputs
  and documentation were updated. Driver redesign statuses remain Pending.

## Progress log

| Date | Task IDs | Update |
| --- | --- | --- |
| 2026-10-17 | P01–P04 | Driver references analyzed; initial customer UI direction proposed. No redesign code changed. |
| 2026-10-17 | P05–P06 | Signed driver 5.1.4 and customer 5.7.1 baseline APKs built and verified locally. |
| 2026-10-17 | P07 | Tracker created. Customer modules precede driver modules; all implementation tasks remain pending. |
| 2026-10-17 | P08 | Reviewed customer PDF; documented seven sections, added deferred feature assessments F06–F12, and recorded revised navigation recommendation. No app code changed; C01 remains pending. |
| 2026-10-17 | C02 reference | User supplied and confirmed the seven customer design sections. Recorded section-to-task mapping, including Voice and Safety design coverage. Implementation remains pending; core-functionality constraint retained. |
| 2026-10-17 | P09 | Saved both apps' design memory and reference originals within the project for future continuity. Implementation remains pending. |
| 2026-10-17 | C01 preparation | Started customer browser preview on port 8100 for user review before the audit. Compilation passed; Home map/banner visible, location pending. No redesign changes or bookings made. |
| 2026-10-17 | Location investigation | User reported location not fetched. Later Home showed Achabal/no rides; reviewed geolocation and pickup/city flow, awaiting confirmation of the displayed area. No code/permission changes made. |
| 2026-10-17 | Location resolved | User confirmed PC location service was off and location now works. Environment issue resolved; no app fix needed. |
| 2026-10-17 | C01 | Completed source audit. Active Home is pages/booking/home, not legacy customer-book. Recorded service flows, endpoints, rules and gaps in Customer-Screen-Audit.md. |
| 2026-10-17 | C02–C04 | User requested first screen change. Implemented Home reference layout with existing live data/actions. Production build and 13 existing regression checks passed; targeted browser walkthrough performed. Remaining modules are not marked complete. |
| 2026-10-17 | C04 refinement | Removed the DREAM. RIDE. GO. text beneath the four Home information cards and above navigation, as requested. |
| 2026-10-17 | C04 reference copy | User requested original reference wording for the four cards. Updated heading to The DreamCabs promise, with Fixed fare, Cancel cover, Women-safe, and Lost and found titles/descriptions and matching icons. Copy change only; associated deferred capabilities are not implemented or verified. |
| 2026-10-17 | C02/C04 icons and tabs | Matched five reference tab labels and outline Ionicons, including Voice. Voice opens a coming-soon message without microphone access. Replaced inline banner thumbnail with gift icon and seat emoji with people outline. Existing full-screen promotional content retained. Dev compilation passed. |
| 2026-10-17 | C02/C04 Trips popup | Replaced the generic Trips alert with a custom rounded popup anchored above the Trips tab, with a pointer, highlighted trigger, close button and left-aligned icon/title/description rows. Existing four trip-list destinations retained. Dev compilation passed; browser verified pointer/layout, Private list navigation and return. Screenshot: ui-previews/customer-trips-popup.png. |
| 2026-10-17 | C04 popup alignment | User requested the Trips panel centered horizontally with the same bottom position. Centered above the navigation area while preserving the Trips arrow and existing vertical offset. |
| 2026-10-17 | C03/C04 motion | Added subtle Home entrance fades/rises, short content/Trips-row stagger and control transitions. Trips retains Ionic's opening positioning with a 240ms inner reveal and a custom 180ms fade/slide close. Reduced-motion disables new CSS motion and popup animation. Dev compilation and repeated open/close/reopen browser checks passed; pointer/centering retained. |
| 2026-10-17 | C04 circles and offers | Made profile/menu and notification controls 44px circles. Added Offers for you heading, swipeable admin-promotion/available-coupon cards, and existing coupons-page links in the highlighted area. Coupon availability/discount copy comes from /me/coupons, with no new redemption logic or invented discounts. Dev compilation passed; browser verified circle dimensions and real assigned-coupon rendering. |
| 2026-10-17 | C04 promotion tabs | Separated Offers and Coupons into their own tabs/data. User requested Offers first (default), Coupons second. Offers show available banner images, with a shared green background and gift icon for missing/failed images. Multiple half-banner offers preserve API order and individual dismissal. |
| 2026-10-17 | C04 banner backgrounds | User requested images as full-card backgrounds. Offer images now cover the card behind a dark gradient, with foreground title/action and visible dismissal. Missing/failed images retain the shared green fallback. |
| 2026-10-17 | C04 promotion verification | Five Home regression checks passed, including separate coupon/banner content and failed-image fallback. Browser verified a real loaded banner as a full-card background with overlay/text layers. Preview: ui-previews/customer-offer-backgrounds.png. |
| 2026-10-17 | C04 uncropped banners | User requested the entire banner image remain visible. Changed background image fitting from cover to contain, centered within the card. Green fills any unused space; foreground content and dark overlay retained. |
| 2026-10-17 | C04 profile photo | Added the existing customer avatar to the circular menu control when available, retaining the person icon for missing or failed photos and the same menu action. Six targeted Home checks passed, including failed-photo fallback and a changed photo URL. Dev compilation passed. Next: user review of Home refinements; C02/C03/C04 remain ongoing. |
| 2026-10-17 | C04 route actions | Home route cards now open the matching loaded route's departure step through a routeId query parameter, then retain existing departure/stops/seat booking steps. Keyboard-accessible buttons, missing-route message and existing-hold priority included. Dev compilation and 20 targeted Home/fixed-route checks passed. Browser verified S House -> D opens Choose a departure for route 10; API returned no departures. Back to route list/Home verified; no seat hold or booking created. Screenshot: ui-previews/customer-home-route-next-step.png. Next: user review; complete remaining Home/device checks, then C05 results design. |
| 2026-10-17 | C01 confirmation | User requested C01 marked done; confirmed Completed. Next: finish C02/C03 structure and shared styling before C05 route results/details. This confirmation does not close outstanding Home/device checks or later modules. |
| 2026-10-17 | C02 voice screen | User requested creation of the second customer reference screen. Added /customer-tabs/go/voice and connected Home Voice tab. Reference-inspired mint background, static waveform, language labels, example transcript, route/stops/seat/fare summary, disabled Confirm and manual-booking Edit details link. Clearly labelled design preview/sample details; no microphone, AI interpretation or booking submission. Dev compilation passed; browser verified Voice entry, disabled confirmation and Edit details returning Home. Customer viewport reviewed; scroll supported. Screenshot: ui-previews/customer-voice-preview.png. Next: user visual review; actual multilingual voice capability remains deferred F06. |
| 2026-10-17 | C02 production copy audit | Reviewed redesigned Home, Voice and fixed-route entry changes and searched both app sources for design-only terms. Voice contained unconditional sample trip/fare data and preview/example/sample labels that would persist in production; removed them and inactive Confirm/Edit controls. Replaced with Coming soon and a working Home booking link. No matching design-only text found in redesigned Home or fixed-route entry; code/test identifiers, legitimate fare-estimate wording and server-provided content remain unchanged. Dev compilation passed; browser verified visible/accessibility text and layout. Screenshot: ui-previews/customer-voice-coming-soon.png. Next: user review and remaining C02/C03 work; F06 remains deferred. |
| 2026-10-17 | C04 Home scrollbar | Hid the persistent vertical scrollbar on bh-home-scroll with standard and WebKit CSS, retaining overflow-y:auto and existing scrolling behavior. Dev compilation and diff whitespace check passed. Browser verification was not executed: automatic approval review encountered a usage limit. Next: visually confirm scrollbar removal and scrolling in the customer browser. |
| 2026-10-17 | C04 scrollbar verification | Browser verification resumed successfully. Home scroll area reports scrollbar-width:none with overflow-y:auto; wheel scrolling moved scrollTop from 0 to 541 while content remained accessible. Screenshot confirms hidden scrollbar; returned Home to top. Evidence: ui-previews/customer-home-scrollbar-hidden.png. Previous browser verification blocker resolved. Next: remaining C02/C03 and Home/device checks. |
| 2026-10-18 | C03/C05–C07 booking reference | Implemented reference styling in active fixed booking: opt-in shared shell/fare badge/progress/docked action, real stop timeline, compact configured seats with held state, proper icons, and coupon/fare/payment summary. Existing booking state machine and API/payment methods unchanged; unsupported add-ons/date controls omitted. Production build passed; 20 existing regressions plus 2 isolated render/action checks passed. Browser verified route 5 header/empty departures state; route currently has no departures, preventing live progression to seats/review. No live hold, booking or payment submitted. Screenshot: ui-previews/customer-booking-route-header.png. Next: review with available departure and perform device/approval/payment-state verification; C05–C07 remain Ongoing. |
| 2026-10-18 | C06 seat map scrolling | Removed overflow scrolling and flex shrinking from fx-carwrap so the seat grid occupies its full natural height and scrolls with the booking body. Browser verified live route 5 departure/stops/seat view: wrapper height/content both 250px, overflow visible, flex-shrink 0; page body remains scrollable (649px content / 417px viewport). No hold or booking created. Dev compilation passed. Screenshot: ui-previews/customer-seats-page-scroll.png. Next: client visual review and remaining booking/device checks. |
| 2026-10-18 | C06/C07 reference refinement and restored fare | Compact seat/review progress caption replaces duplicate large title; tightened stop summary, Choose your seat heading and selected-seat fare breakdown match reference. During browser review, a restored active hold showed zero because route/seat data was absent after reload. Fixed display to use server hold amount/original amount/luggage/discount and saved route/stop names; hide coupon editing without route/departure context. Browser then showed saved route/stops and INR 10 checkout amount. Production build and 16 fixed-route/render regressions passed, including new reload case. No payment submitted. Evidence: ui-previews/customer-restored-request-amount.png. Next: user visual review; retain remaining C06/C07/C12 device and payment-state checks. |
| 2026-10-18 | C06/C07 coupon section | User flagged missing reference coupon area. Added code/Apply/Remove before Request seats, validated via existing coupon endpoint and persisted through existing hold creation. Show green applied row and discount breakdown. Review displays saved hold discount even without route data; no coupon produces a clear status instead of disappearing. Existing hold amount is authoritative; prevent preview-only discount changes after approval. Pending checks disable seat request and stale coupon responses are ignored. Production build and 17 regressions passed, including pre-request coupon payload and restored discount. Browser verified visible coupon entry/total on live seat page; no coupon redemption or booking submitted. Screenshot: ui-previews/customer-booking-coupon-section.png. Next: user review and remaining C07/C12 integration checks. |
| 2026-10-18 | C06/C07 coupon reference styling | User requested the original compact coupon UI. Replaced always-visible code input with a green tag-icon Apply coupon row that expands on tap. Successful validation closes the editor and shows the real code/discount in the green row; Remove remains available before the request. Browser verified expand/collapse with no redemption; four render/action checks and dev compilation passed. Evidence: ui-previews/customer-compact-coupon-row.png. Next: user review and remaining integration checks. |
| 2026-10-18 | C06/C07 coupon placement correction | User explicitly requested removal from seat selection and placement under Payment. Removed coupon projection from seats. Seat CTA now opens Payment & offers review before sending the seat request; coupons are applied there and persisted with the request, followed by existing driver approval and payment. No backend/rule changes. Browser verified zero coupon sections on seats and coupon row on payment review, without sending a request. Seventeen regression checks and dev compilation passed. Evidence: ui-previews/customer-coupon-payment-only.png. Next: user review and remaining integration/device checks. |
| 2026-10-18 | C07 cancel/release action | Added right-hand Cancel ride beside payment/review primary action through an optional shared-shell secondary button. Existing holds use /fixed/seat-holds/:id/release; clear state and return Home only after RELEASED/EXPIRED confirmation. Failures retain hold/selection and show retryable error; duplicate release/payment actions disabled. Draft cancellation is local. Production build and 20 fixed-booking regressions passed, including release success/failure/duplicate and draft cases. Browser verified button position without submitting any real cancellation/request/payment. Evidence: ui-previews/customer-cancel-ride-action.png. Next: user review and remaining integration/device checks. |
| 2026-10-18 | C06/C07 request-flow regression fix | User reported the extra pre-request payment page changed the original flow. Restored seat-screen Request seats -> awaiting driver -> Payment & offers. Payment action requires ACCEPTED/HELD state; delayed decline events after acceptance are ignored instead of returning to seats. Coupon remains only on payment as saved discount/status; editing an existing hold coupon needs a server-supported update endpoint and is not implemented by coupon-preview. Production build and 20 regression checks passed, including direct request, acceptance, no duplicate request, pre-approval payment block, stale decline and cancellation cases. Browser verified live seat-selection CTA without submitting a request/payment. Screenshot: ui-previews/customer-seat-request-order-restored.png. Next: user/driver walkthrough and remaining C12 checks. |
| 2026-10-18 | C07 approved-hold coupons and payment footer | Added Apply/Remove on payment using a new authenticated backend hold-coupon endpoint with ownership/approval/expiry/payment-start guards and existing coupon eligibility. Updated hold response includes real code/editability; frontend changes totals only after server success. Original request/approval order retained. Local backend tests: 23 passed / 132 assertions; customer tests: 22 passed; production build passed. Live API deployment is still required; browser coupon attempts currently return unavailable without changing fare. Handoff: Payment-Coupon-Update-Handoff.md. UI: renamed CTA Make payment, moved timer beneath buttons to the right, accepted message to the left; removed old body copies/footer hint. Footer slots verified by tests; latest browser observation was awaiting driver approval, so no new live acceptance/cancellation/payment was triggered. Next: user review and authorized backend deployment/live verification. |
| 2026-10-18 | C07 payment hold expiry | User requested returning Home when payment hold timer ends. Expiry now clears hold/selections/seat map/coupon/payment modal, stops approval listeners, returns Home with replaceUrl and an expiry notice. Stale expiry events are ignored; late payment-order responses cannot reopen checkout. Preserve original hold stop IDs for payment confirmation if local state was cleared. Production build and 25 regression checks passed, including the real timer component firing expiry, cleared state/Home navigation, stale expiry and delayed order response. No live request/payment submitted for this verification. Next: user walkthrough; coupon backend deployment and remaining integration checks stay pending. |
| 2026-10-18 | C07a complete / C08 reference review | User requested marking expiry work done and viewing the next reference before implementation. Added C07a Completed; C07 retains separate coupon deployment/integration work. C08 begins reference review using customer-04-live-ride.png; its map/tracking scope remains C09. No C08 implementation performed yet. Next: user review of confirmation/boarding-code reference. |
| 2026-10-18 | C10 dedicated My trips | User requested replacing the Home Trips modal with a real page matching customer-05-my-trips.png. Added /customer-tabs/trips with Upcoming/Pre-booked/Past, real fixed/private/shuttle/scheduled API feeds, fare/status/refund cards, deduplication, pagination, per-feed retry and five-item navigation. Existing service-specific detail/tracking/action pages retained; shuttle deep link expands the chosen booking. Removed obsolete Home popover and animations. Production build passed (release-apks/customer-my-trips-build.log); 8 regression checks passed (release-apks/customer-my-trips-tests.log). Browser verified Home navigates directly, actual completed fixed booking renders under Past and opens matching detail page; Upcoming empty state verified. No booking/payment/cancellation submitted. Next: user review; populated pre-booked/private/shuttle and device checks remain. |
| 2026-10-18 | C04 active-ride Home consistency | User observed the live-ride Home still used older styling and lacked navigation. Reused the normal Home expandable sheet/scroll surface, green/navy colors, rounded driver/stops cards and all five navigation items for active bookings. Preserved actual status/boarding code, call and existing live-ride destination; shortened action to View live ride. Moved Offer pill below header. Production build passed (release-apks/customer-active-home-build.log); 3 active-Home rendering/navigation checks passed (release-apks/customer-active-home-tests.log). Browser observed real active ride and all five tabs; screenshot ui-previews/customer-active-home.png. No live booking/payment/cancellation submitted. Next: user review; C08/C09 full-screen tasks remain deferred. |
| 2026-10-18 | C04 active Home button label | User requested renaming View live ride to Ride. Updated visible button text only; existing action retained. Verified template label. |
| 2026-10-18 | C10 Journeys overview | User requested four sections: a uniquely named overview, Upcoming, Pre-booked and Past. Named the first Journeys and made it the default; it combines actual next/pre-booked rides above a separate Past rides section, preserving focused category filters. Four pills fit small screens. Production build passed (release-apks/customer-trips-journeys-build.log); 9 targeted checks passed (release-apks/customer-trips-journeys-tests.log). Reloaded browser and verified real active and completed bookings together; evidence ui-previews/customer-trips-journeys.png. Next: user review and remaining service/device verification. |
| 2026-10-18 | C10 half done / C09 resumed | User stated My trips design is still unsatisfactory and requested marking it half done, then returning to deferred live-ride screen. C10 remains Ongoing with visual acceptance outstanding; refinement paused. C09 resumed Ongoing. Opened the actual active booking through Track ride at /customer-tabs/fixed-rides/28 for review. No C09 implementation or ride mutations performed in this step. Next: compare existing live screen with customer-04-live-ride.png and implement the agreed supported layout. |
| 2026-10-18 | C09 live-ride reference implementation | Replaced the dark header/hidden drawer with reference-style floating status header, full map and expandable light sheet. Actual driver/call, code digits, ordered stop progress, walking directions, board/drop/seat/fare/payment, support and existing cancel/rating actions retained. SOS uses existing participant-authorized endpoint after confirmation; mocked only in checks. No false Paid fallback, ETA, rating, distance or automatic protection claims. Fixed live sharing remains unavailable because the endpoint requires trip ownership. Map error notice and sheet-aware recenter padding added. Production build passed (release-apks/customer-live-ride-build.log); 6 checks passed (release-apks/customer-live-ride-tests.log). Browser observation rejected an unsupported tab URL protocol; no workaround attempted and no visual/browser verification claimed. Restarted local preview on port 8100. Next: user/browser/device review and real status/boarding/movement walkthrough; no live SOS/cancellation/payment/rating submitted. |
| 2026-10-18 | C09 all-components development preview | User requested unhiding components for visual review. Added development-only toggle to reveal sections together and expand sheet, with labelled preview code/review placeholders. Production guard prevents enabling preview; call/directions/SOS/cancel/rating submission disabled and method-guarded while previewing. Actual booking state unchanged. Production build passed (release-apks/customer-live-ride-preview-build.log); 8 checks passed (release-apks/customer-live-ride-preview-tests.log), including production guard and no mutation. Browser verified preview enabled on current live booking; screenshot ui-previews/customer-live-ride-components.png. Next: user design review; exit component preview restores ordinary conditions. |
| 2026-10-18 | C09 compact 40% sheet | User requested fixed 40%-screen sheet, smaller boarding padding/digits, less journey padding and custom stop scrollbar. Set 40dvh on mobile/desktop and removed expansion control; internal scrolling retained. Code boxes 34x38px; boarding and board/drop spacing reduced. Native stop scrollbar hidden, replaced with synchronized keyboard-accessible custom range. Production build passed (release-apks/customer-live-ride-compact-build.log); 9 checks passed (release-apks/customer-live-ride-compact-tests.log). Browser measured 237.95px sheet in 595px viewport (~40%) and confirmed native scrollbar hidden. Next: user visual review. |
| 2026-10-18 | C09 progress first / full-height expansion | User requested progress card first, full-height sheet opening and removal of recenter. Moved status/stop timeline ahead of driver/code/preview controls. Restored accessible top handle toggling 40dvh default to 100dvh full-screen with collapse; removed recenter button/style. Production build passed (release-apks/customer-live-ride-expand-build.log); 10 checks passed (release-apks/customer-live-ride-expand-tests.log). Browser verified expanded height 594.91px in 595px viewport, progress as first card and recenter absent. Evidence ui-previews/customer-live-ride-expanded.png. Next: user review. |
| 2026-10-18 | C09 header copy | Removed route name beneath the live header status at user request. Booking status remains. Verified template; no booking/data changes. |
| 2026-10-18 | C09 matched header control sizes | User requested smaller Back/Refresh circles matching center pill. Set both circles and status pill to 34px height, icons to 18px, centered alignment. CSS verified. |
| 2026-10-18 | C09 hide customer map marker | User requested removing own icon/location from the live-ride map. Removed passenger marker/name rendering and customer-position camera bounds/fallback; driver and pickup/drop pins retained. Existing location use for SOS and core driver tracking remains unchanged. Next: user visual review. |
| 2026-10-18 | C09 walking distance and functional audit | Added routed current-GPS-to-pickup walking distance/time using Maps Routes WALKING with legacy Directions fallback; no straight-line fallback. 30s per-pickup throttle, missing-GPS/error messages, late-response guards and explicit origin in walking directions. Removed payment/booking-info card. Fixed BOOKED/CONFIRMED header to use server live label/tone instead of always Booking confirmed. Stop fill now gates on dispatch and fills half-segments only through last reached stop; future connections remain gray. Location/route requests stop updating after page leave. Production build passed (release-apks/customer-live-ride-walking-build.log); 15 checks passed (release-apks/customer-live-ride-walking-tests.log), including poll-driven status/progress and walking success/failure/stale result. Browser observed 209m walking route/about 3min, Booking confirmed with zero reached/current stops and no booking-info card. Evidence ui-previews/customer-live-ride-walking.png. No live ride/SOS/cancellation/payment/rating mutations submitted. Next: user review and real driver movement/boarding/device walkthrough. |
| 2026-10-18 | C09 non-clickable pickup distance card | User requested removing walking card link and explicitly showing stop name. Converted button to static article, removed chevron and external directions handler, labelled Pickup stop above actual booked stop name. Retained computed walking route distance/time; unavailable states no longer suggest opening a removed link. Verified template/handler removal. Explained distance comes from reported GPS to booked pickup via routing, with GPS variability. |
| 2026-10-18 | C09 remove temporary preview | User requested production-facing code. Removed Show all components toggle, notice, preview state/styles/action overrides, dummy code digits and fallback submitted rating. Ordinary server-driven visibility/eligibility restored in all build configurations. Browser confirmed no preview controls or placeholder sections and real walking distance retained. 14 page checks passed (release-apks/customer-live-ride-production-tests.log), including absent preview/dummy UI and lifecycle/status/routing checks. Production build log: release-apks/customer-live-ride-production-build.log. No deployment/APK or live booking mutation performed. Next: user acceptance and real movement/boarding/device integration verification. |
| 2026-10-18 | C09 accepted / C11 reference review | User requested marking live ride done and fetching the next reference before work. C09 Completed based on user acceptance, final production build/14 checks and recorded browser evidence. Broader integration remains C12. C10 stays half done/paused and C08 deferred. C11 Account reference review started using customer-06-account.png; no Account implementation yet. Next: user reference review. |
| 2026-10-18 | C11 Account-style sidebar | User requested the Account reference design for the sidebar. Replaced dark hero/dense menu with compact profile and Edit, real photo/initial fallback, masked phone, green offers entry, white rounded groups/outline icons, direct My trips and collapsed service lists, sign-out and legal links. Existing routes and sign-out/delete confirmation retained; no unsupported wallet/referral/preferences introduced. Production build passed (release-apks/customer-sidebar-build.log); 4 checks passed (release-apks/customer-sidebar-tests.log). Browser opened customer menu and verified actual identity/groups; evidence ui-previews/customer-account-sidebar.png. No sign-out/delete/financial actions submitted. Next: user review; supporting-page redesign remains. |
| 2026-10-18 | C11 full-width sidebar and bottom tabs | User requested full screen width, content above bottom bar and hidden scrollbar. Set menu to 100vw, removed outer corner rounding, added fixed Home/Trips/Voice/Safety/Account footer using existing close-and-navigate handler, and hid native ion-content scrollbar while preserving scroll. Production build passed (release-apks/customer-sidebar-full-width-build.log); 4 sidebar checks passed (release-apks/customer-sidebar-full-width-tests.log). Temporary background browser tab visually verified full-width menu and visible bottom tabs; user tab was being actively navigated, so avoided further interference. Next: user review. |
| 2026-10-18 | C04 shorter active Home sheet | User requested removing the driver/vehicle/call card from Home to shorten the sheet. Removed that Home-only block and its styles; reduced default active Home sheet to 44dvh. Status, route/seats, code when available, pickup/drop and Ride link remain; expanded view retained. Full driver details remain on live-ride page. Source and diff checks passed. Next: user review. |
| 2026-10-18 | C04 remove Home status badge | User requested removing Booking confirmed badge from active Home sheet. Removed status pill and render its former top row only if a real boarding code exists, avoiding an empty gap. Other Home content and live-ride page unchanged. Verified template. |
| 2026-10-18 | C04 remove Home seat count | Removed seat-count line beneath active Home route title at user request. Route name and pickup/drop/Ride action retained. Verified template. |
| 2026-10-18 | C11 restore all previous menu entries | User requested all previous sidebar tabs with current design. Made Private/Fixed/Shuttle/Scheduled direct visible rows, removed accordion, restored full Terms/Privacy menu rows and full-width Sign out/Delete buttons. Kept all other links, current grouped styling, full width, fixed bottom tabs and hidden scrollbar. Production build/check logs: release-apks/customer-sidebar-restored-build.log and customer-sidebar-restored-tests.log. Browser verified every menu entry directly present; evidence ui-previews/customer-sidebar-restored-links.png. Next: user review. |
| 2026-10-18 | C11 remove sidebar bottom tabs | User requested removing the bottom tabs added to sidebar and retaining the rest. Removed sidebar-only footer tab markup/styles; all restored menu entries, full width and hidden scrollbar retained. Home/Trips page navigation untouched. Verified source. |
| 2026-10-18 | C11 bottom bar clarification | User clarified to keep bottom bar and remove duplicate sidebar destinations. Restored five-item footer; removed Home/My trips card from sidebar content. Service-specific rides and other account/support/legal entries retained. Updated card-count regression expectation. |
| 2026-10-18 | C11 deduplicate Safety destination | Also removed SOS contacts row because it opens the same destination as the retained bottom Safety tab. Help/support remains in its card; profile Edit retained. |
| 2026-10-18 | C11 route-aware bottom tab selection | User requested exact current-page highlighting and no selection for unrepresented pages. Replaced fixed Account selection with exact normalized Router URL matching for all five tabs; query/hash/trailing slash ignored, nested booking/other pages select none. Five sidebar checks passed (release-apks/customer-sidebar-active-tab-tests.log), including each destination and unmatched routes. |
| 2026-10-18 | Navigation Safety/support and Contacts | User requested bottom Safety opens Help and Support and sidebar Help/support becomes Contacts. Updated Home/My trips/sidebar bottom Safety destination to /customer-tabs/support, retaining label/icon. Sidebar Contacts now opens /customer-tabs/emergency-contacts with people icon. Exact-route active selection updated; 5 sidebar checks passed (release-apks/customer-safety-contacts-navigation-tests.log). |
| 2026-10-18 | C11 compact sidebar spacing | User requested reduced padding in all sidebar boxes. Rows reduced from 47px minimum/11px padding to 40px/8px; card gaps from 12px to 9px and side padding to 11px. Offers card and profile/footer gaps tightened. Source checked; layout-only change. |
| 2026-10-18 | C11 offers action spacing | User requested consistent View offers button margins/padding. Set explicit margin 4px 0 0, padding 8px 12px, centered inline-flex content, 8px icon gap and unit line-height; aligned left with banner copy. CSS verified. |
| 2026-10-18 | C04 compact destination search | User requested smaller Where to text and reduced padding. Placeholder 16px to 14px, search minimum height 58px to 50px, padding 5px 6px 5px 12px, gap 9px and arrow tile 38px. CSS-only change; action retained. |

| 2026-10-19 | C11 completion accepted | User explicitly requested C11 marked done. Sidebar design and navigation accepted; status Completed. Prior build, five checks and browser evidence retained. Next: select the next customer task; C10 remains half done/paused, C08 deferred and C12 integration/device verification pending. |

| 2026-10-19 | C11a Safety centre implemented | Reference layout implemented at /customer-tabs/support; legacy two-item tab bar hidden there in favor of five reference tabs. Real contacts with loading/error/empty states, confirmed configured emergency dial, existing ride-tool links, six prefilled email categories, preserved support/FAQs. No live alerts/calls/reports sent. Production build passed (customer-safety-centre-build.log); 4 checks passed (customer-safety-centre-tests.log), covering counts/failures, disabled missing channels, emergency cancellation and contacts refresh. Browser visual verification blocked by browser URL security policy; no alternate UI access attempted. Next: user visual review, then C12 device/integration checks. |

| 2026-10-19 | C11a browser review unblocked | At user request restarted customer preview with host access on port 8100 and opened Safety centre. Browser confirmed real configured emergency number, empty saved-contact state, trip tool links and five-tab footer with Safety selected. Screenshot: ui-previews/customer-safety-centre.png. Earlier browser access blocker resolved; user visual acceptance and C12 remain pending. |

| 2026-10-19 | C11a strict city support | User requires no fallback contacts from another city. Removed configured/first-city fallback in SupportInfoController and role-number substitution; null for unavailable fields. Safety page sends selected city_id, clears stale contacts, rejects mismatched API city, and uses Emergency no. rather than Police no. Missing city has no support request. Production build and 6 page checks passed; backend 2 tests / 31 assertions passed (support-city-scope-tests.log). Browser verified unavailable SOS with no 100; evidence ui-previews/customer-safety-city-scoped.png. Backend not deployed; frontend guard protects this page against legacy API fallback. Next: user review; deploy backend only when authorized, then verify other clients. |

| 2026-10-19 | C11a remove support message row | User requested removing the entire red support-not-configured/Try again line. Removed its template row and unused styling. Unavailable emergency card and header refresh retained. Source checked; presentation-only change. Next: user review. |

| 2026-10-19 | C11a completion accepted | User explicitly requested Safety centre marked done after removing the red message row. Status Completed. Prior build/tests/browser evidence retained; final row removal source checked. Next: select the next customer task; C10 remains half done/paused, C08 deferred. Backend city-support deployment and C12 integration/device verification remain pending. |

| 2026-10-19 | C11a SOS visibility | Removed disabled opacity fading specifically from SOS card and strengthened subtitle contrast. Missing city emergency number still disables calling; no fallback added. CSS/source check; user visual review next. |

| 2026-10-19 | C11a saved contact refresh | User showed configured admin fields. Browser confirmed real emergency value and support options after Home resolved Sopore. Fixed direct-refresh city context loss by retaining selected support city ID in session storage independently of booking draft. No cross-city fallback. Browser verified configured SOS survives reload; ui-previews/customer-safety-configured.png. Build/regression checks pending below; no call/report submitted. |

| 2026-10-19 | C11a city continuity verified | Production build passed (customer-support-city-continuity-build.log); 8 checks passed (customer-support-city-continuity-tests.log), including selected-city survival across service recreation/draft reset, city changes, invalid/missing storage and existing Safety guards. Browser configured SOS verified after reload. C11a remains accepted; C12 device tests and backend deployment remain separate. |

| 2026-10-19 | C11a Police number | Added separate Police card below SOS with the same city scope and explicit call confirmation. Missing Police field stays unavailable; Emergency/Police never substitute each other. Seven page checks passed (customer-safety-police-tests.log); browser verified configured number, screenshot ui-previews/customer-safety-police.png. No call placed. C11a remains accepted. |

| 2026-10-19 | C11a support placement | Moved Help and support directly below Police, before Trusted contacts at user request. Template order checked; conditions and actions retained. C11a remains accepted. |

| 2026-10-19 | C11a page verification | Production build and 12 checks passed (customer-safety-full-check-build.log / customer-safety-full-check-tests.log). Fixed late-response refresh/city race with regression test. Checked real configured SOS/Police values and separate confirmation dialogs in browser; contact count, support placement and report categories rendered. Browser security policy stopped further interaction during FAQ check, so FAQ/navigation walkthrough remains unverified this run. No calls/emails/reports submitted; native dialer/email and C12 device checks pending. C11a stays accepted. |

| 2026-10-19 | C11 booking link names | Renamed sidebar service labels to Private Booking, Fixed Booking and Shuttle Booking as requested. Updated existing label expectations; destinations unchanged. Source/diff checked; C11 remains completed. |

## Separate admin reference work — 2026-10-20

User explicitly authorized adapting two new client admin references to
`/operations/routes`, retaining project colors/styles and using real SVG icons.
Implementation and verification are recorded in
[Admin routes UI redesign](Admin-Routes-UI-Redesign.md): production build and
24 route-workspace checks passed, with live desktop/mobile browser review.
Client visual acceptance is pending. This separate admin request does not change
mobile task statuses, the customer-first sequence, or deferred mobile functionality.

Admin reference revision (2026-10-20): first visual pass rejected by user. User
clarified that both references should be combined, retaining all existing CRUD and
other functionality. Revised admin implementation completed and verified with a
production build, 30 targeted checks and desktop/mobile browser review. See
[Admin routes UI redesign](Admin-Routes-UI-Redesign.md) for current evidence and
screenshots. User acceptance of this revision remains pending. Mobile statuses
and order are unchanged.

Admin modular follow-up (2026-10-20): removed duplicate small tab row at user's
request. Summary cards now own module navigation; route, group, vehicle and driver
panels are separated while retaining existing CRUD/settings/assignment tools.
Production build and 32 checks passed; live browser verified isolation, cross-module
links and mobile layout. See Admin-Routes-UI-Redesign.md for evidence. Next: user
review of modular organization; customer/driver mobile task statuses unchanged.

Admin route-detail consolidation (2026-10-20): removed the Route directory table
at user's request; moved Route detail into its place and consolidated all route
features into five working tabs. Original browsing/grouping/filter/pagination and
CRUD/import/export handlers retained. Production build and 34 checks passed, with
live browser verification. Evidence/next step: Admin-Routes-UI-Redesign.md; await
user review. Mobile redesign statuses/order unchanged.

Admin route-section polish (2026-10-20): completed visual refinement of all five
route tabs at user's request, preserving actions and layout. Production build and
34 existing checks passed; desktop/mobile review recorded in
Admin-Routes-UI-Redesign.md with per-tab screenshots. Next: user visual review.
Customer/driver mobile statuses/order remain unchanged.

Admin group consolidation (2026-10-20): user approved removing Route groups as a
primary tab. Group creation/editing/deletion and route/vehicle/driver membership
management now live in Total routes → Manage & import, using existing editors.
Three primary modules remain. Independent group filters prevent route filters
from hiding groups. Production build and 35 checks passed; browser verified real
editor and group-to-route navigation. Evidence: Admin-Routes-UI-Redesign.md.
Next: user review; customer/driver mobile order and task statuses unchanged.

Admin follow-up (2026-10-20): user requested group management in its own inner
Route groups tab, removed the redundant Browse & filter shortcut, and requested a
searchable route selector. Implemented, retaining all existing group and route
actions. 36 checks passed; browser verified live search/Enter selection and tab
isolation. See Admin-Routes-UI-Redesign.md. Next: user review; mobile statuses unchanged.

Admin Overview consolidation (2026-10-20): user requested Stops and Assigned drivers
inside Overview. Implemented full lists with original editing and assignment links;
removed their separate tabs and duplicate count shortcuts. Four inner tabs remain.
37 checks passed; live Overview verified with actual stops/drivers. Evidence/next
step: Admin-Routes-UI-Redesign.md; await user review. Mobile app statuses unchanged.

Admin compact Overview (2026-10-20): user requested less scrolling and two/three
cards per row. Updated responsive stops/drivers grids and condensed route facts,
padding and cards. CSS-only; production build and live desktop layout verified.
Evidence/next: Admin-Routes-UI-Redesign.md; await review. Mobile app statuses unchanged.

Admin layout clarification (2026-10-20): user requested full-width Stops and
Assigned drivers sections with stop cards in one horizontal line. Implemented
full-width stacked sections and single-row contained lists. Live browser verified
all seven stops on one line and four drivers on one line. See admin UI record.
Next: user review. Customer/driver mobile app statuses unchanged.

Admin stop labels (2026-10-20): user requested names/descriptions below the stop
numbers. Implemented within the existing single-row cards; browser verified.
Evidence/next: Admin-Routes-UI-Redesign.md; user review pending. Mobile statuses unchanged.

Admin stop timeline (2026-10-20): centered stop content, removed individual borders
and added horizontal connectors between numbered markers at user's request.
CSS-only; browser verified. Evidence/next: Admin-Routes-UI-Redesign.md; user review
pending. Customer/driver mobile app statuses unchanged.

Admin user decision (2026-10-20): removed Overview's Manage stops shortcut. The
route editor remains accessible from Edit and Manage & import. Browser verified;
see Admin-Routes-UI-Redesign.md. Mobile app statuses unchanged; user review pending.

Admin header copy (2026-10-20): removed the Routes heading description at user's
request; browser confirmed absence. See Admin-Routes-UI-Redesign.md. Next: user
review; mobile app task statuses unchanged.

Admin group switching (2026-10-20): added a direct group dropdown in the geography
hierarchy at user's request. Updates map/detail/count to the chosen group and
supports All groups, clears conflicting filters and handles empty groups. Build
and 38 checks passed; browser verified. Next: user review; evidence in admin UI
record. Customer/driver mobile app task statuses unchanged.

Admin searchable group control (2026-10-20): added Select group beside Select route
in the same searchable style, synchronized with hierarchy selection. Build and 39
checks passed; live search/Enter selection verified. See admin UI record. Next:
user review; customer/driver mobile app task statuses unchanged.

Admin driver shortcuts (2026-10-21): after clarification, user approved Add drivers
and Add to group in route Overview. Implemented existing group-based flows; no direct
route-only assignment feature. Build/41 checks/browser verification passed without
saving operational changes. See admin UI record. User next requested customer app
Markdown completion audit; mobile status is not inferred from admin verification.

Customer route/seat/payment verification (2026-10-21): 42 existing targeted checks
passed; browser verified Home route navigation, nearest-start results and correct
route/fares. Four nearby routes all displayed no departures, preventing live
seats/approval/payment verification. Found loadDepartures() masks API errors as
empty results; separate error/retry state needs follow-up. No app source or live
operational records changed. Report: Customer-Route-Seat-Payment-Verification-2026-10-21.md.
C05-C07 remain Ongoing; C12 Pending. Next: controlled test departure and driver
approval/payment walkthrough, with separate error-state fix. Full-suite startup
test issue remains unresolved.

Driver-assisted customer test (2026-10-21): user requested opening driver app for
live verification. Preview compiled at 127.0.0.1:8200; /tabs/fixed redirects to login.
Waiting for user to sign in with the test driver account before opening departures.
No operational mutations. Customer C12 remains Pending; driver redesign not started.

Authorized live customer/driver test (2026-10-21): user signed into driver app and
requested proceeding. Verified route 5 test departure, actual stops, configured
seats, seat 1A/₹10 request, driver receipt/acceptance and customer Payment & offers
with correct total/countdown. Payment chooser exposed Online/UPI/Cash; no payment
method submitted. Customer Cancel ride released hold; driver confirmed 9 free/0
booked, closed empty departure and returned Offline. Transient live records were
created and cleaned up. Screenshot/report: Customer-Route-Seat-Payment-Verification-2026-10-21.md.
C12 remains Pending for actual payment/gateway, concurrency, expiry, boarding and
devices. Home location fallback after cancellation remains a follow-up; no source
changes. C05-C07 statuses unchanged, not promoted solely from this walkthrough.
