import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { CustomerTabsPage } from './customer-tabs.page';

const routes: Routes = [
  {
    path: '',
    component: CustomerTabsPage,
    children: [
      {
        path: 'book',
        redirectTo: 'go',
        pathMatch: 'full',
      },
      {
        // The redesigned booking flow (rev 5). Home is the bottom sheet; the
        // mode flows lazy-load beneath it as they're built.
        path: 'go',
        loadChildren: () =>
          import('../pages/booking/booking.module').then((m) => m.BookingPageModule),
      },
      {
        path: 'trips',
        loadComponent: () => import('../pages/my-trips/my-trips.page').then(m => m.MyTripsPage),
      },
      {
        path: 'my-trips',
        loadChildren: () =>
          import('../pages/customer-trips/customer-trips.module').then((m) => m.CustomerTripsPageModule),
      },
      {
        path: 'fixed-rides/:bookingId/map',
        loadChildren: () =>
          import('../pages/fixed-route-map/fixed-route-map.module').then((m) => m.FixedRouteMapPageModule),
      },
      {
        path: 'fixed-rides/:bookingId',
        loadChildren: () =>
          import('../pages/fixed-ride-active/fixed-ride-active.module').then((m) => m.FixedRideActivePageModule),
      },
      {
        path: 'fixed-rides',
        loadChildren: () =>
          import('../pages/fixed-bookings/fixed-bookings.module').then((m) => m.FixedBookingsPageModule),
      },
      {
        path: 'shuttle-rides',
        loadChildren: () =>
          import('../pages/shuttle-bookings/shuttle-bookings.module').then((m) => m.ShuttleBookingsPageModule),
      },
      {
        path: 'profile',
        loadChildren: () =>
          import('../pages/profile/profile.module').then((m) => m.CustomerProfilePageModule),
      },
      {
        path: 'saved-locations',
        loadChildren: () =>
          import('../pages/saved-locations/saved-locations.module').then((m) => m.SavedLocationsPageModule),
      },
      {
        path: 'emergency-contacts',
        loadChildren: () =>
          import('../pages/emergency-contacts/emergency-contacts.module').then((m) => m.CustomerEmergencyContactsPageModule),
      },
      {
        path: 'coupons',
        loadChildren: () =>
          import('../pages/coupons/coupons.module').then((m) => m.CouponsPageModule),
      },
      {
        path: 'refunds',
        loadChildren: () =>
          import('../pages/refunds/refunds.module').then((m) => m.RefundsPageModule),
      },
      {
        path: 'scheduled-rides',
        loadChildren: () =>
          import('../pages/scheduled-rides/scheduled-rides.module').then((m) => m.ScheduledRidesPageModule),
      },
      {
        path: 'notifications',
        loadChildren: () =>
          import('../pages/notifications/notifications.module').then((m) => m.NotificationsPageModule),
      },
      {
        path: 'support',
        loadChildren: () =>
          import('../pages/support/support.module').then((m) => m.SupportPageModule),
      },
      {
        path: 'trip/:tripId',
        loadChildren: () =>
          import('../pages/trip-active/trip-active.module').then((m) => m.TripActivePageModule),
      },
      {
        path: 'trip-details/:tripId',
        loadChildren: () =>
          import('../pages/trip-details/trip-details.module').then((m) => m.TripDetailsPageModule),
      },
      {
        path: 'terms',
        loadChildren: () =>
          import('../pages/terms/terms.module').then((m) => m.TermsPageModule),
      },
      {
        path: 'privacy',
        loadChildren: () =>
          import('../pages/privacy/privacy.module').then((m) => m.PrivacyPageModule),
      },
      {
        path: '',
        redirectTo: 'go',
        pathMatch: 'full',
      },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class CustomerTabsPageRoutingModule {}
