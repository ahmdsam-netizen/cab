import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { DriverTopbarComponent } from './driver-topbar.component';

@Component({ standalone: true, imports: [DriverTopbarComponent], template: `<app-driver-topbar><button driverHeaderStart>Profile</button><button driverHeaderActions>Offers</button></app-driver-topbar>` })
class HeaderHost {}

describe('Shared driver top bar', () => {
  beforeEach(async () => { await TestBed.configureTestingModule({ imports: [DriverTopbarComponent, HeaderHost], providers: [provideRouter([])] }).compileComponents(); });
  it('shows Cabbies branding and routes the bell to Notifications', async () => {
    const f = TestBed.createComponent(DriverTopbarComponent); f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Cabbies');
    const router = TestBed.inject(Router); const nav = spyOn(router, 'navigateByUrl').and.resolveTo(true);
    f.nativeElement.querySelector('[aria-label="Notifications"]').click(); await f.whenStable();
    expect(nav).toHaveBeenCalled();
    expect(router.serializeUrl(nav.calls.mostRecent().args[0] as any)).toBe('/notifications');
  });
  it('preserves Home profile and Offers actions without duplicating the bell', () => {
    const f = TestBed.createComponent(HeaderHost); f.detectChanges();
    expect(f.nativeElement.querySelector('.driver-app-topbar__start').textContent).toContain('Profile');
    expect(f.nativeElement.querySelector('.driver-app-topbar__actions').textContent).toContain('Offers');
    expect(f.nativeElement.querySelectorAll('[aria-label="Notifications"]').length).toBe(1);
  });
});
