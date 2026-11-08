import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { SupportPage } from './support.page';

const routes: Routes = [{ path: '', component: SupportPage }];

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, FormsModule, IonicModule, RouterModule.forChild(routes)],
  declarations: [SupportPage],
})
export class SupportPageModule {}
