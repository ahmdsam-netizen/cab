import { DriverTopbarComponent } from '../../shared/driver-topbar/driver-topbar.component';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { SubscriptionsPage } from './subscriptions.page';
import { SubscriptionsPageRoutingModule } from './subscriptions-routing.module';
import { PlanCardModule } from '../../shared/plan-card/plan-card.module';

@NgModule({
  imports: [DriverTopbarComponent, CommonModule, IonicModule, SubscriptionsPageRoutingModule, PlanCardModule],
  declarations: [SubscriptionsPage],
})
export class SubscriptionsPageModule {}
