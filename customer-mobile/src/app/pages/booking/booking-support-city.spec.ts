import { BookingService } from './booking.service';

describe('Support city continuity', () => {
  beforeEach(() => sessionStorage.removeItem('dc.support.city-id'));
  afterEach(() => sessionStorage.removeItem('dc.support.city-id'));
  it('restores only the selected support city after reload or draft reset', () => {
    const first = new BookingService({} as any); first.setCity(7);
    const reloaded = new BookingService({} as any);
    expect(reloaded.supportCityId).toBe(7);
    expect(reloaded.trip.cityId).toBeNull();
    first.reset(); expect(first.supportCityId).toBe(7);
    first.setCity(9); expect(reloaded.supportCityId).toBe(9);
  });
  it('does not select any city when unset, cleared or storage is invalid', () => {
    const service = new BookingService({} as any);
    expect(service.supportCityId).toBeNull();
    sessionStorage.setItem('dc.support.city-id', 'invalid'); expect(service.supportCityId).toBeNull();
    service.setCity(7); service.setCity(null); expect(service.supportCityId).toBeNull();
  });
});
