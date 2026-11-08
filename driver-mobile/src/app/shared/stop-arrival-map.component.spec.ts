import { TestBed } from '@angular/core/testing';
import { StopArrivalMapComponent } from './stop-arrival-map.component';
import { MapsLoaderService } from '../core/maps-loader.service';

describe('Stop arrival map', () => {
  let loader: { ensureLoaded: jasmine.Spy };
  beforeEach(async () => {
    loader = { ensureLoaded: jasmine.createSpy().and.returnValue(new Promise<void>(() => {})) };
    await TestBed.configureTestingModule({ imports: [StopArrivalMapComponent],
      providers: [{ provide: MapsLoaderService, useValue: loader }],
    }).compileComponents();
  });
  it('loads the actual stop map without an arrival status overlay', async () => {
    const f = TestBed.createComponent(StopArrivalMapComponent);
    f.componentInstance.reached = true;
    f.componentInstance.stop = { name: 'Sample stop', lat: 34, lng: 74 }; f.detectChanges();
    await Promise.resolve(); f.detectChanges();
    expect(loader.ensureLoaded).toHaveBeenCalled();
    expect(f.nativeElement.querySelector('.arrival-map-status')).toBeNull();
  });
  it('does not invent coordinates or show arrived for an unavailable location', async () => {
    const f = TestBed.createComponent(StopArrivalMapComponent);
    f.componentInstance.stop = { name: 'Missing location' }; f.detectChanges();
    await Promise.resolve(); f.detectChanges();
    expect(loader.ensureLoaded).not.toHaveBeenCalled();
    expect(f.nativeElement.textContent).toContain('Stop location unavailable');
    expect(f.nativeElement.textContent).not.toContain('You have arrived');
  });
});
