import { Subject } from 'rxjs';
import { EarningsPage } from './earnings.page';

describe('Earnings date scopes', () => {
  let api: any;
  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(2026, 9, 26, 15)); // Monday in the local calendar.
    api = { get: jasmine.createSpy() };
  });
  afterEach(() => jasmine.clock().uninstall());
  function response() {
    return { ride_earnings: 900, cash_collected: 400, online_collected: 500,
      pending_transfers: 80, completed_transfers: 20,
      buckets: [{ date: '2026-10-25', amount: 700 }, { date: '2026-10-26', amount: 200 }],
      rides: [{ id: 1, date: new Date(2026, 9, 25, 12).toISOString(), fare: 700 },
        { id: 2, date: new Date(2026, 9, 26, 12).toISOString(), fare: 200 }] };
  }
  it('derives Today from dated buckets and preserves all-time payout balances', () => {
    const pending = new Subject<any>(); api.get.and.returnValue(pending);
    const page = new EarningsPage(api); page.load(); pending.next(response());
    expect(api.get).toHaveBeenCalledWith('/drivers/me/earnings?period=week');
    expect(page.activeTab).toBe('overview'); expect(page.rideEarnings).toBe(200);
    expect(page.rides.map(r => r.id)).toEqual([2]); expect(page.pendingTransfers).toBe(80);
  });
  it('uses the current Monday-based week and ignores a late response for an old filter', () => {
    const first = new Subject<any>(); const second = new Subject<any>();
    api.get.and.returnValues(first, second);
    const page = new EarningsPage(api); page.load(); page.setPeriod('week');
    second.next(response()); first.next({ ...response(), ride_earnings: 9999, buckets: [] });
    expect(page.rideEarnings).toBe(200); expect(page.rides.map(r => r.id)).toEqual([2]);
    expect(page.loading).toBeFalse();
  });
  it('does not let a late error replace the latest successful period', () => {
    const first = new Subject<any>(); const second = new Subject<any>();
    api.get.and.returnValues(first, second);
    const page = new EarningsPage(api); page.load(); page.setPeriod('all');
    second.next(response()); first.error({ error: { message: 'Old error' } });
    expect(page.error).toBeNull(); expect(page.rideEarnings).toBe(900);
  });
});
