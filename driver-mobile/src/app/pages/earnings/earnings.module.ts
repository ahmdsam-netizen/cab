import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { EarningsPage } from './earnings.page';
import { EarningsPageRoutingModule } from './earnings-routing.module';

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, IonicModule, EarningsPageRoutingModule],
  declarations: [EarningsPage],
})
export class EarningsPageModule {}
