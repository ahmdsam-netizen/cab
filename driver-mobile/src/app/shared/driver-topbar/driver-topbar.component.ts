import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-driver-topbar',
  standalone: true,
  imports: [IonicModule, RouterModule],
  template: `
    <div class="driver-app-topbar">
      <div class="driver-app-topbar__start"><ng-content select="[driverHeaderStart]"></ng-content></div>
      <span class="driver-app-topbar__brand" aria-label="Cabbies">Cabbies</span>
      <div class="driver-app-topbar__actions">
        <ng-content select="[driverHeaderActions]"></ng-content>
        <button type="button" routerLink="/notifications" aria-label="Notifications"><ion-icon name="notifications-outline" aria-hidden="true"></ion-icon></button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; background: #0d1b2a; color: white; }
    .driver-app-topbar { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 4px 16px; padding-top: max(4px, env(safe-area-inset-top)); box-sizing: border-box; }
    .driver-app-topbar__start:empty { display: none; }
    .driver-app-topbar__start { flex-shrink: 0; }
    .driver-app-topbar__brand { font-size: 22px; font-weight: 800; letter-spacing: -.7px; white-space: nowrap; }
    .driver-app-topbar__brand > span { color: #25d07b; }
    .driver-app-topbar__actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; }
    .driver-app-topbar__actions > button { display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 12px; background: transparent; color: white; cursor: pointer; }
    .driver-app-topbar__actions ion-icon { display: block; width: 24px; height: 24px; font-size: 24px; }
    .driver-app-topbar__actions > button { padding: 0; box-sizing: border-box; line-height: 1; }
    button:focus-visible { outline: 2px solid #25d07b; outline-offset: 2px; }
    @media (max-width: 360px) { .driver-app-topbar { padding-inline: 10px; gap: 7px; }.driver-app-topbar__brand { font-size: 20px; }.driver-app-topbar__actions { gap: 3px; } }
  `],
})
export class DriverTopbarComponent {}
