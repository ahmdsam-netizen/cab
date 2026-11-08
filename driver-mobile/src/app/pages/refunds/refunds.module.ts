import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { RefundsPage } from './refunds.page';

const routes: Routes = [{ path: '', component: RefundsPage }];

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, FormsModule, IonicModule, RouterModule.forChild(routes)],
  declarations: [RefundsPage],
})
export class RefundsPageModule {}
