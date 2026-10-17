import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { RouterModule, Routes } from '@angular/router';

import { BookingHomePage } from './home/booking-home.page';
import { AiBookingAssistantModule } from '../../shared/ai-booking-assistant/ai-booking-assistant.module';
import { ModeSelectModalModule } from '../../shared/mode-select-modal/mode-select-modal.module';

/**
 * The redesigned booking flow (rev 5). Home is the bottom-sheet screen; the
 * mode-specific flows lazy-load under it as they're built, each wearing the
 * shared StepShell so every step looks the same.
 */
const routes: Routes = [
  {
    // The mode flows are nested here rather than beside 'go' in the tabs
    // router: Angular doesn't backtrack out of a lazy module, so a sibling
    // 'go/private' would be swallowed by 'go' and never resolve.
    path: 'private',
    loadChildren: () => import('./private/private.module').then((m) => m.PrivateBookPageModule),
  },
  {
    path: 'fixed',
    loadChildren: () => import('./fixed/fixed.module').then((m) => m.FixedBookPageModule),
  },
  {
    path: 'shuttle',
    loadChildren: () => import('./shuttle/shuttle.module').then((m) => m.ShuttleBookPageModule),
  },
  { path: '', component: BookingHomePage },
];

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    RouterModule.forChild(routes),
    AiBookingAssistantModule,
    ModeSelectModalModule,
  ],
  declarations: [BookingHomePage],
})
export class BookingPageModule {}
