import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ScheduledRidesPage } from './scheduled-rides.page';
import { ScheduledRidesPageRoutingModule } from './scheduled-rides-routing.module';

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, IonicModule, ScheduledRidesPageRoutingModule],
  declarations: [ScheduledRidesPage],
})
export class ScheduledRidesPageModule {}
