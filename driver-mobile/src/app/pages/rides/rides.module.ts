import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { RidesPage } from './rides.page';
import { RidesPageRoutingModule } from './rides-routing.module';
import { TripSummaryModal } from './trip-summary.modal';
import { StartOtpModal } from './start-otp.modal';

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, FormsModule, IonicModule, RidesPageRoutingModule],
  declarations: [RidesPage, TripSummaryModal, StartOtpModal],
})
export class RidesPageModule {}
