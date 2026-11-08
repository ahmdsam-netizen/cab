import { of } from 'rxjs';
import { FixedDriverPage } from './fixed-driver.page';

describe('Fixed driver terminal manifest synchronization', () => {
  for (const status of ['CANCELLED', 'COMPLETED']) {
    it(`clears the active ride and stops its location stream when polling returns ${status}`, () => {
      const page: any = Object.create(FixedDriverPage.prototype);
      page.api = { get: jasmine.createSpy().and.returnValue(of({ departure: { id: 12, status }, passengers: [] })) };
      page.activeVehicle = { id: 12, status: 'DEPARTED' };
      page.passengers = [{ id: 9, status: 'BOARDED' }];
      page.stops = [];
      page.incomingSeatRequests = [{ id: 5 }];
      page.seatMapData = { cells: [] };
      page.citySettings = {};
      page.otpPassenger = { id: 9 };
      page.detailsModalOpen = true;
      for (const method of ['closeStopDetail', 'stopManifestPolling', 'resetEmbeddedMap', 'refresh']) {
        page[method] = jasmine.createSpy(method);
      }
      page.stopFixedTripLocationStreaming = jasmine.createSpy().and.resolveTo();
      page.loadManifest(12, false);
      expect(page.activeVehicle).toBeNull();
      expect(page.passengers).toEqual([]);
      expect(page.incomingSeatRequests).toEqual([]);
      expect(page.seatMapData).toBeNull();
      expect(page.detailsModalOpen).toBeFalse();
      expect(page.otpPassenger).toBeNull();
      expect(page.stopManifestPolling).toHaveBeenCalled();
      expect(page.stopFixedTripLocationStreaming).toHaveBeenCalled();
      expect(page.refresh).toHaveBeenCalled();
    });
  }
});
