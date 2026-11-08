import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { PrivacyPage } from './privacy.page';
import { PrivacyPageRoutingModule } from './privacy-routing.module';

@NgModule({
  imports: [DriverTopbarComponent, 
    CommonModule,
    FormsModule,
    IonicModule,
    PrivacyPageRoutingModule,
  ],
  declarations: [PrivacyPage],
})
export class PrivacyPageModule {}
