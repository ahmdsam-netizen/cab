# C01 — Customer screen audit and Home implementation

Date: 2026-10-17 (Asia/Calcutta).
Reference: [customer design memory](UI-Design-Memory.md).

## Audit result

The active customer entry is `/customer-tabs/go`, which loads
`pages/booking/home/booking-home.page.*` through `pages/booking/booking.module.ts`.
The older `pages/customer-book/` is not the active Home. Earlier location/code
notes about that older page must not be used as evidence for the current screen.
The separate `/tabs` shell is also not the current customer entry.

This audit maps existing source and records targeted browser checks. It does not
certify end-to-end payments, live boarding, or every backend capability.

## Existing journey and source mapping

All source paths below are relative to `customer-mobile/src/app/`.

| Journey / reference | Existing route and source | Rules to preserve / gaps |
| --- | --- | --- |
| Entry and session | `app-routing.module.ts`, `pages/splash/`, `core/auth.guard.ts` | Splash sends authenticated users to `/customer-tabs/go`. Preserve authentication and session behavior. |
| Home | `/customer-tabs/go`; `pages/booking/home/` | GPS/map, city catalogue, Local/Outstation, mode preference, administrator banners, active fixed booking, live tracking. Catalogue determines enabled services. |
| Shared booking draft | `pages/booking/booking.service.ts`, `booking.models.ts` | City, scope, mode/ride type, pickup and destination shared across steps. Preserve draft and scope semantics. |
| Pickup/drop search | `pages/booking/place-search.component.ts`, `core/places.service.ts` | Existing search and place coordinates power private/shuttle journeys; fixed rides require route stops. |
| Private booking | `/customer-tabs/go/private`; `pages/booking/private/` | Pickup → drop → car → offered price → driver negotiation. Do not replace with fixed per-seat pricing. Current create payload uses `scheduled_at: null`; a scheduled-rides list does not establish new-flow pre-booking support. |
| Fixed routes | `/customer-tabs/go/fixed`; `pages/booking/fixed/` | City/location route search, Local/Outstation filtering, departure selection, pickup/drop stops, luggage, configured seat map. |
| Fixed seats and checkout | Same fixed module; `fixed/seat-grid.component.ts` | Seat hold → pending driver approval → accepted/held → review/payment → ticket. Retain timeout/rejection, coupon, deposit/full online payment, idempotency, expiry and release handling. The PDF's one-screen layout cannot bypass this lifecycle. |
| Shuttle booking | `/customer-tabs/go/shuttle`; `pages/booking/shuttle/` | Pickup/drop, estimate, payment choice, booking, seat selection, payment confirmation and pool formation. Uses its own endpoints and must remain distinct. |
| Fixed ticket / live ride | `/customer-tabs/fixed-rides/:bookingId`; `pages/fixed-ride-active/`; `/map` uses `pages/fixed-route-map/` | Four-digit boarding code, status, location/stop map, cancellation and completion/rating rules. Preserve active Home tracking and navigation. |
| Private / shuttle active ride | `/customer-tabs/trip/:tripId`; `pages/trip-active/` | Existing start/boarding codes, realtime location, payment/rating, cancellation gates, SOS and sharing. Verify per-service availability before moving actions. |
| My trips | Private: `/customer-tabs/my-trips` (`pages/customer-trips/`); fixed: `/fixed-rides` (`pages/fixed-bookings/`); shuttle: `/shuttle-rides` (`pages/shuttle-bookings/`) | Lists are currently separate. A unified reference Trips screen is later C10 work. Initial Home shortcut provides a chooser to retain all lists. |
| Scheduled bookings | `/customer-tabs/scheduled-rides`; `pages/scheduled-rides/` | Reads `/customer/trips/scheduled`; preserve existing status and cancellation behavior. No new recurring/scheduling workflow authorized. |
| Profile / Account | `/customer-tabs/profile`; `pages/profile/` | Profile exists; full reference Account aggregation remains C11. Do not infer a customer wallet from driver wallet functionality. |
| Supporting pages | `/customer-tabs/saved-locations`, `/coupons`, `/refunds`, `/notifications`, `/support` | Existing screens available through customer routing and side menu. Home saved chips open the existing saved-location manager; they do not auto-select fixed pickup/drop stops. |
| Safety | `/customer-tabs/emergency-contacts`; `pages/emergency-contacts/`; trip SOS/share in `pages/trip-active/` | Contacts/support tools exist. New Safety Centre and automatic sharing/protection remain separate work. Initial Home Safety shortcut opens contacts, not a fabricated protection dashboard. |
| Voice | Legacy `shared/mode-select-modal/` is static | User later requested a Voice tab. It now displays a coming-soon message; no listening/booking or microphone access occurs. Multilingual assistant remains unimplemented. |

## Home changes in this implementation pass

- Use the confirmed Home reference: location/menu/notification header, prominent
  search action, compact service selection, inline promotional content, saved
  places, actual fixed-route preview, explanation cards, and bottom shortcuts.
- Keep catalogue-driven scope/mode choices and the existing `whereTo()` route
  behavior. Unsupported services are not invented to fill the reference's five slots.
- Move the existing half-banner into the standard Home scroll area, retaining its
  dismissal/reopen and link confirmation. Full-screen banners and active-ride
  presentation keep their existing behavior.
- Read saved places from the existing endpoint; use existing manager links.
- Read up to three fixed routes from the existing city/location endpoint and filter
  them to the selected scope. Display returned fare/stops; do not label routes as
  live departures or invent remaining seats/ETAs. See all opens the fixed flow.
- Add expandable/scrollable Home content and responsive desktop placement.
- Home-only navigation: Home, My trips chooser, Safety contacts, Account/profile.
  This is an incremental working navigation, not completion of the five-tab
  reference shell or the future Trips/Account/Safety screens.
- Preserve the active fixed-ride sheet and driver/location tracking. Keep the user
  pin above the standard mobile sheet when centering the map.

## Known gaps for later modules

- Five Home tab labels/icons now match the reference at the user's request;
  Voice has an explanatory coming-soon action. Unified Trips, actual Voice, full Safety Centre and
  Account aggregation remain unfinished. Detailed layouts for these are still C02.
- Real-time departure/seat/ETA previews require defined data and refresh behavior;
  initial Home cards intentionally show routes and published fares only.
- Pre-book creation, women-only seats, passes/referrals, parcel service, automatic
  safety monitoring/free rebook and preference modes remain deferred scope checks.
- Reference offer examples conflict (first ride for 10 vs 10 discount); use real
  administrator offers and coupon rules, never those example values.
- Existing city fallback may display the detected locality while loading a nearby
  administered city's catalogue. This pre-existing service-resolution behavior was
  not changed during visual work; validate separately if it causes a mismatch.
- PC location issue was user-reported as resolved by enabling the OS location service.
- GPS denial, offline recovery, expired holds, payment failure and full trip state
  transitions require C12 integration/device checks beyond this Home pass.

## Validation

- Production build passed, followed by a final build for the responsive CSS adjustment.
- Existing Home-location and fixed-route-scope suites: 13 checks passed in Chrome Headless.
- Browser checked scope-dependent preview data, entry into the existing fixed
  route list, return navigation, My trips chooser, expansion/scrolling and layouts
  at 390×844 and 1024×768. Viewport returned to its normal size afterward.
- [Home screenshot](ui-previews/customer-home-first-pass.png) captures the first pass.
- Browser console also reported Firebase Messaging `app/no-app` during reloads.
  Messaging setup was not changed here; browser push initialization needs separate
  follow-up. This does not establish that Android push is broken or verified.
- Browser walkthroughs use live API data; no booking, hold, payment, SOS,
  message, or cancellation was submitted during Home verification.
- Active-booking layout is preserved in code but was not exercised with a real
  active booking or a phone. Full journey verification remains C12.
