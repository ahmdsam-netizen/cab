import { CommonModule } from '@angular/common';
import { Component, OnDestroy } from '@angular/core';
import { RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';

type Source = 'fixed' | 'private' | 'shuttle' | 'scheduled';
type TripTab = 'journeys' | 'upcoming' | 'prebooked' | 'past';
export interface TripCard {
  key: string; id: number; source: Source; tripId?: number; title: string; route: string;
  status: string; label: string; date?: string; created?: string; scheduled: boolean;
  past: boolean; fare?: number; currency: string; payment?: string; seats?: string;
  refund?: string; link: string; action: string;
}
interface Feed { rows: TripCard[]; loading: boolean; error: string; page: number; requestedPage: number; more: boolean; }
const terminal = new Set(['COMPLETED', 'CANCELLED', 'NO_SHOW', 'DROPPED', 'EXPIRED', 'REJECTED']);
const labels: Record<string, string> = {
  BOOKED: 'Confirmed', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', DROPPED: 'Completed',
  CANCELLED: 'Cancelled', NO_SHOW: 'Missed', BOARDED: 'On board', REQUESTED: 'Finding a driver',
  NEGOTIATION: 'Fare discussion', ASSIGNED: 'Driver assigned', EN_ROUTE_PICKUP: 'Driver on the way',
  ARRIVED_PICKUP: 'Driver arrived', EN_ROUTE_DROP: 'In progress', ARRIVED_DROP: 'At destination',
  PENDING_DRIVER_APPROVAL: 'Awaiting driver', PAYMENT_PENDING: 'Payment pending', EXPIRED: 'Expired', REJECTED: 'Declined',
};

/** Adapt existing authenticated booking responses; never manufacture reference records. */
export function tripCard(source: Source, row: any, now = new Date()): TripCard {
  const status = String(row.status || '').toUpperCase();
  const past = terminal.has(status);
  const date = row.scheduled_at || row.announced_depart_at || row.depart_at || row.service_date;
  // A future service date is pre-booked; today's fixed departures remain Upcoming.
  const serviceDay = date ? String(date).slice(0, 10) : '';
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const underway = ['BOARDED', 'EN_ROUTE_DROP', 'ARRIVED_DROP'].includes(status);
  const scheduled = !past && !underway && (row.scheduled_at
    ? new Date(row.scheduled_at).getTime() > now.getTime() : source === 'fixed' && serviceDay > today);
  const route = source === 'fixed' ? [row.board, row.drop] : source === 'shuttle'
    ? [row.pickup?.address, row.drop?.address] : [row.pickup_address, row.drop_address];
  const routeText = route.filter(Boolean).join(' → ');
  const fare = source === 'fixed' || source === 'shuttle' ? row.fare_amount : row.final_fare ?? row.estimated_fare;
  const tripId = row.trip_id;
  const link = source === 'fixed' ? `/customer-tabs/fixed-rides/${row.id}`
    : source === 'shuttle' ? '/customer-tabs/shuttle-rides'
    : `/customer-tabs/${past ? 'trip-details' : 'trip'}/${row.id}`;
  return {
    key: `${source === 'scheduled' ? 'private' : source}-${row.id}`, id: row.id, source, tripId,
    title: source === 'fixed' ? row.route_name || routeText || 'Fixed-route ride' : routeText || 'Your ride',
    route: source === 'fixed' ? routeText : '', status, label: labels[status] || status.toLowerCase().replace(/_/g, ' ') || 'Status unavailable',
    date: past ? row.completed_at || row.cancelled_at || date || row.created_at : date || row.created_at,
    created: row.created_at, scheduled, past, fare: fare == null ? undefined : Number(fare),
    currency: row.currency || 'INR', payment: row.payment_method || row.payment?.method,
    seats: row.seat_labels?.length ? row.seat_labels.join(', ') : row.seats ? `${row.seats} ${Number(row.seats) === 1 ? 'seat' : 'seats'}` : undefined,
    refund: row.refund_status && row.refund_status !== 'NONE' ? String(row.refund_status).toLowerCase().replace(/_/g, ' ') : undefined,
    link, action: past ? 'View details' : source === 'shuttle' ? 'View booking'
      : ['REQUESTED', 'NEGOTIATION', 'PENDING_DRIVER_APPROVAL', 'PAYMENT_PENDING'].includes(status) ? 'View booking' : 'Track ride',
  };
}

@Component({
  selector: 'app-my-trips', standalone: true, imports: [CommonModule, IonicModule, RouterModule],
  templateUrl: './my-trips.page.html', styleUrls: ['./my-trips.page.scss'],
})
export class MyTripsPage implements OnDestroy {
  tab: TripTab = 'journeys';
  readonly tabs: { id: TripTab; title: string }[] = [
    { id: 'journeys', title: 'Journeys' },
    { id: 'upcoming', title: 'Upcoming' }, { id: 'prebooked', title: 'Pre-booked' }, { id: 'past', title: 'Past' },
  ];
  readonly sources: Source[] = ['fixed', 'private', 'shuttle', 'scheduled'];
  readonly names: Record<Source, string> = { fixed: 'Fixed-route rides', private: 'Private rides', shuttle: 'Shuttle rides', scheduled: 'Pre-booked rides' };
  feeds = this.sources.reduce((feeds, source) => {
    feeds[source] = { rows: [], loading: false, error: '', page: 0, requestedPage: 1, more: false };
    return feeds;
  }, {} as Record<Source, Feed>);
  private requests = new Subscription();
  constructor(private api: ApiService) {}
  ionViewWillEnter(): void { this.refresh(); }
  ionViewWillLeave(): void { this.requests.unsubscribe(); this.requests = new Subscription(); }
  ngOnDestroy(): void { this.ionViewWillLeave(); }
  refresh(): void {
    this.requests.unsubscribe(); this.requests = new Subscription();
    for (const source of this.sources) this.load(source, 1);
  }
  load(source: Source, page: number): void {
    const feed = this.feeds[source];
    feed.loading = true; feed.error = ''; feed.requestedPage = page;
    const url = source === 'fixed' ? `/fixed/bookings?page=${page}&per_page=50`
      : source === 'private' ? `/customer/trips/history?status=all&page=${page}`
      : source === 'shuttle' ? '/shuttle/bookings' : '/customer/trips/scheduled';
    this.requests.add(this.api.get<any>(url).subscribe({
      next: res => {
        const rows = source === 'private' ? res?.data?.data : res?.data;
        const cards = (Array.isArray(rows) ? rows : [])
          .filter(row => !['private', 'scheduled'].includes(source) || !row.route_departure_id)
          .map(row => tripCard(source, row));
        feed.rows = page === 1 ? cards : [...feed.rows, ...cards];
        feed.page = page;
        feed.more = source === 'fixed' ? !!res?.meta?.has_more
          : source === 'private' ? Number(res?.data?.current_page) < Number(res?.data?.last_page) : false;
        feed.loading = false;
      },
      error: () => { feed.loading = false; feed.error = `Could not load ${this.names[source].toLowerCase()}. Please try again.`; },
    }));
  }
  loadMore(): void {
    for (const source of this.sources) {
      const feed = this.feeds[source];
      if (feed.more && !feed.loading) this.load(source, feed.page + 1);
    }
  }
  retry(source: Source): void { this.load(source, this.feeds[source].requestedPage); }
  get loading(): boolean { return this.sources.some(source => this.feeds[source].loading); }
  get hasMore(): boolean { return this.sources.some(source => this.feeds[source].more); }
  get hasErrors(): boolean { return this.sources.some(source => !!this.feeds[source].error); }
  get cards(): TripCard[] {
    const sharedTripIds = new Set([...this.feeds.fixed.rows, ...this.feeds.shuttle.rows].map(row => row.tripId).filter(Boolean));
    const cards = new Map<string, TripCard>();
    for (const source of this.sources) for (const card of this.feeds[source].rows) {
      if ((source === 'private' || source === 'scheduled') && sharedTripIds.has(card.id)) continue;
      // The scheduled endpoint supplies richer scheduling information for the same private trip.
      cards.set(card.key, card);
    }
    return [...cards.values()].filter(card => this.tab === 'journeys' || (this.tab === 'past' ? card.past : !card.past && (this.tab === 'prebooked' ? card.scheduled : !card.scheduled)))
      .sort((a, b) => {
        const time = (value?: string) => value ? new Date(value).getTime() || 0 : 0;
        if (this.tab === 'journeys' && a.past !== b.past) return a.past ? 1 : -1;
        return a.past && b.past ? time(b.date) - time(a.date) : time(a.date) - time(b.date);
      });
  }
  trackCard(_index: number, card: TripCard): string { return card.key; }
  dateLabel(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    return isNaN(date.getTime()) ? '' : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  methodLabel(value?: string): string { return value ? value.toLowerCase().replace(/_/g, ' ') : ''; }
}
