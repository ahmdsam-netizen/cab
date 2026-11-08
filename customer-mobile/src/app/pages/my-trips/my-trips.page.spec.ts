import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { MyTripsPage, tripCard } from './my-trips.page';

describe('My trips booking feeds', () => {
  const now = new Date('2026-10-18T12:00:00');
  let api: jasmine.SpyObj<ApiService>;
  let page: MyTripsPage;
  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get']);
    api.get.and.returnValue(of({ data: [] }));
    page = new MyTripsPage(api);
  });
  afterEach(() => page.ngOnDestroy());

  it('keeps today’s fixed seats upcoming and future services pre-booked', () => {
    expect(tripCard('fixed', { id: 1, status: 'BOOKED', service_date: '2026-10-18' }, now).scheduled).toBeFalse();
    expect(tripCard('fixed', { id: 2, status: 'BOOKED', service_date: '2026-10-19' }, now).scheduled).toBeTrue();
    expect(tripCard('scheduled', { id: 3, status: 'EN_ROUTE_DROP', scheduled_at: '2026-10-19T12:00:00' }, now).scheduled).toBeFalse();
  });

  it('groups terminal bookings into Past and retains zero fares', () => {
    for (const status of ['DROPPED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED', 'REJECTED']) {
      const card = tripCard('fixed', { id: 1, status, fare_amount: 0 }, now);
      expect(card.past).toBeTrue();
      expect(card.scheduled).toBeFalse();
      expect(card.fare).toBe(0);
      expect(card.action).toBe('View details');
    }
    expect(tripCard('fixed', { id: 2, status: 'BOOKED' }, now).fare).toBeUndefined();
  });

  it('deduplicates private/scheduled trips and suppresses shared parent trips', () => {
    page.tab = 'upcoming';
    page.feeds.fixed.rows = [tripCard('fixed', { id: 1, status: 'BOOKED', trip_id: 10 }, now)];
    page.feeds.private.rows = [tripCard('private', { id: 10, status: 'CONFIRMED' }, now), tripCard('private', { id: 20, status: 'CONFIRMED' }, now)];
    page.feeds.scheduled.rows = [tripCard('scheduled', { id: 20, status: 'CONFIRMED', scheduled_at: '2099-01-01' }, now)];
    expect(page.cards.map(card => card.key)).toEqual(['fixed-1']);
    page.tab = 'prebooked';
    expect(page.cards.map(card => card.key)).toEqual(['private-20']);
  });

  it('defaults to Journeys with current and pre-booked rides above past rides', () => {
    page.feeds.fixed.rows = [
      tripCard('fixed', { id: 1, status: 'COMPLETED', created_at: '2026-10-17' }, now),
      tripCard('fixed', { id: 2, status: 'BOOKED', service_date: '2026-10-18' }, now),
      tripCard('fixed', { id: 3, status: 'BOOKED', service_date: '2026-10-19' }, now),
    ];
    expect(page.tab).toBe('journeys');
    expect(page.tabs.map(tab => tab.title)).toEqual(['Journeys', 'Upcoming', 'Pre-booked', 'Past']);
    expect(page.cards.map(card => card.id)).toEqual([2, 3, 1]);
    page.tab = 'upcoming';
    expect(page.cards.map(card => card.id)).toEqual([2]);
    page.tab = 'prebooked';
    expect(page.cards.map(card => card.id)).toEqual([3]);
    page.tab = 'past';
    expect(page.cards.map(card => card.id)).toEqual([1]);
  });

  it('loads the existing authenticated APIs and appends further history pages', () => {
    api.get.and.callFake((url: string) => of(url.startsWith('/customer/trips/history')
      ? { data: { data: [{ id: url.includes('page=2') ? 2 : 1, status: 'COMPLETED' }], current_page: url.includes('page=2') ? 2 : 1, last_page: 2 } }
      : { data: [], meta: { has_more: false } }) as any);
    page.refresh();
    expect(api.get.calls.count()).toBe(4);
    expect(page.hasMore).toBeTrue();
    page.loadMore(); page.tab = 'past';
    expect(page.cards.map(card => card.id).sort()).toEqual([1, 2]);
    expect(page.hasMore).toBeFalse();
  });

  it('retains other feeds on errors and retries the failed page without skipping it', () => {
    page.feeds.fixed.rows = [tripCard('fixed', { id: 1, status: 'BOOKED' })];
    page.feeds.private.page = 3;
    api.get.and.returnValue(throwError(() => new Error('offline')));
    page.load('private', 1);
    expect(page.loading).toBeFalse();
    expect(page.hasErrors).toBeTrue();
    expect(page.cards.length).toBe(1);
    page.retry('private');
    expect(api.get.calls.mostRecent().args[0]).toContain('page=1');
  });

  it('unsubscribes in-flight responses on page leave', () => {
    const response = new Subject<any>();
    api.get.and.returnValue(response);
    page.load('fixed', 1); page.ionViewWillLeave();
    response.next({ data: [{ id: 1, status: 'BOOKED' }] });
    expect(page.feeds.fixed.rows).toEqual([]);
  });

  it('routes each service to its functioning booking or tracking page', () => {
    expect(tripCard('fixed', { id: 12, status: 'BOOKED' }).link).toBe('/customer-tabs/fixed-rides/12');
    expect(tripCard('private', { id: 13, status: 'COMPLETED' }).link).toBe('/customer-tabs/trip-details/13');
    expect(tripCard('scheduled', { id: 14, status: 'ASSIGNED' }).link).toBe('/customer-tabs/trip/14');
    expect(tripCard('shuttle', { id: 15, status: 'PAYMENT_PENDING' }).link).toBe('/customer-tabs/shuttle-rides');
  });

  it('renders actual booking data, supported actions and five navigation tabs', async () => {
    await TestBed.configureTestingModule({ imports: [MyTripsPage], providers: [provideRouter([]), { provide: ApiService, useValue: api }] }).compileComponents();
    const fixture = TestBed.createComponent(MyTripsPage);
    fixture.componentInstance.tab = 'past';
    fixture.componentInstance.feeds.fixed.rows = [tripCard('fixed', { id: 71, status: 'COMPLETED', route_name: 'Database route', board: 'Pickup', drop: 'Destination', fare_amount: 17 })];
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Database route');
    expect(root.querySelector('.details-action')?.getAttribute('href')).toBe('/customer-tabs/fixed-rides/71');
    expect(root.querySelectorAll('.trips-footer a').length).toBe(5);
    expect(root.querySelector('ion-popover')).toBeNull();
    fixture.destroy();
  });
});
