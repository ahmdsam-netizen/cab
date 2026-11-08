import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { GeolocationService } from '../../../core/geolocation.service';
import { PlacesService } from '../../../core/places.service';
import { RealtimeService } from '../../../core/realtime.service';
import { BookingService } from '../booking.service';
import { BookingHomePage } from './booking-home.page';

describe('Home with an active ride', () => {
  beforeEach(async () => {
    spyOn(BookingHomePage.prototype, 'ngOnInit').and.stub();
    spyOn(BookingHomePage.prototype, 'ngOnDestroy').and.stub();
    await TestBed.configureTestingModule({
      declarations: [BookingHomePage], imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [ApiService, AuthService, GeolocationService, PlacesService, RealtimeService,
        BookingService, Router, AlertController].map(provide => ({ provide, useValue: provide === AuthService
          ? { getUser: () => null, resolveAvatarUrl: () => null } : {} })),
    }).compileComponents();
  });
  function setup() {
    const view = TestBed.createComponent(BookingHomePage);
    view.componentInstance.locationFetching = false;
    view.componentInstance.activeFixedRide = {
      id: 13, status: 'BOOKED', route_name: 'Actual route', driver_name: 'Assigned driver',
      board: 'Pickup stop', drop: 'Destination', boarding_code: '1234', seats: 1,
    };
    view.detectChanges();
    return { view, root: view.nativeElement as HTMLElement, page: view.componentInstance };
  }
  it('retains the shared Home sheet, real ride information and all five navigation items', () => {
    const { root } = setup();
    expect(root.querySelector('.bh-active-sheet')?.classList.contains('bh-home-sheet')).toBeTrue();
    expect(root.querySelectorAll('.bh-home-nav a, .bh-home-nav button').length).toBe(5);
    expect(root.querySelector('#home-trips-tab')?.getAttribute('routerLink')).toBe('/customer-tabs/trips');
    expect(root.querySelector('.bh-search')).toBeNull();
    expect(root.querySelector('.bh-active-scroll')?.textContent).toContain('Actual route');
    expect(root.querySelector('.bh-otp-code')?.textContent).toBe('1234');
    expect(root.querySelector('.bh-itinerary-stop')?.textContent).toBe('Pickup stop');
  });
  it('opens the existing live ride screen without changing the booking', () => {
    const { root } = setup();
    const router = TestBed.inject(Router);
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    router.navigateByUrl = jasmine.createSpy().and.resolveTo(true);
    root.querySelector<HTMLButtonElement>('.bh-active-cta')!.click();
    expect(router.navigate).toHaveBeenCalledWith(['/customer-tabs/fixed-rides', 13]);
  });
  it('allows expanding the sheet while keeping unavailable driver contact hidden', () => {
    const { root, page } = setup();
    expect(root.querySelector('.bh-driver-call-btn')).toBeNull();
    root.querySelector<HTMLButtonElement>('.bh-sheet-toggle')!.click();
    expect(page.homeExpanded).toBeTrue();
  });
});
