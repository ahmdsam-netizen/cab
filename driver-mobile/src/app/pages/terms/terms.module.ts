import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { TermsPage } from './terms.page';
import { TermsPageRoutingModule } from './terms-routing.module';

@NgModule({
  imports: [DriverTopbarComponent, 
    CommonModule,
    FormsModule,
    IonicModule,
    TermsPageRoutingModule,
  ],
  declarations: [TermsPage],
})
export class TermsPageModule {}
