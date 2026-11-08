import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { MorePage } from './more.page';
import { MorePageRoutingModule } from './more-routing.module';

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, FormsModule, IonicModule, MorePageRoutingModule],
  declarations: [MorePage],
})
export class MorePageModule {}
