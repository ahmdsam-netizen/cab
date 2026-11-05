<?php

namespace App\Http\Controllers\Admin;

use App\Models\OperatorSetting;
use Illuminate\Http\Request;

class AdminOperatorSettingsController
{
    public function show()
    {
        return response()->json([
            'settings' => OperatorSetting::instance()->toArray(),
        ]);
    }

    public function update(Request $request)
    {
        $data = $request->validate([
            'private_service_name' => ['nullable', 'string', 'max:40'],
            'fixed_service_name' => ['nullable', 'string', 'max:40'],
            'shuttle_service_name' => ['nullable', 'string', 'max:40'],

            // Tipping
            'customer_tip_value_1' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'customer_tip_value_2' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'customer_tip_value_3' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'corporate_tip_value_1' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'corporate_tip_value_2' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'corporate_tip_value_3' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'tip_in_percentage' => ['nullable', 'boolean'],
            'tips_enabled' => ['nullable', 'boolean'],

            // Geofence / driver
            'check_destination_outside_geofence' => ['nullable', 'boolean'],
            'check_driver_debt' => ['nullable', 'boolean'],
            'update_driver_payment_modes_enabled' => ['nullable', 'boolean'],

            // Payment methods (global switches + cash upfront-deposit percentage)
            'payment_online_enabled' => ['nullable', 'boolean'],
            'payment_gpay_enabled' => ['nullable', 'boolean'],
            'payment_cash_enabled' => ['nullable', 'boolean'],
            'cash_deposit_percent' => ['nullable', 'numeric', 'min:0', 'max:100'],

            // Notifications
            'notifications_sms_enabled' => ['nullable', 'boolean'],
            'notifications_email_enabled' => ['nullable', 'boolean'],
            'fixed_customer_sms_enabled' => ['nullable', 'boolean'],
            'fixed_customer_email_enabled' => ['nullable', 'boolean'],
            'fixed_driver_sms_enabled' => ['nullable', 'boolean'],
            'fixed_driver_email_enabled' => ['nullable', 'boolean'],
            'fixed_admin_sms_enabled' => ['nullable', 'boolean'],
            'fixed_admin_email_enabled' => ['nullable', 'boolean'],

            // Wallet — min is signed (may be negative to allow debt); max 0 = no limit.
            'wallet_cash_min_capping' => ['nullable', 'integer', 'min:-1000000', 'max:1000000'],
            'wallet_cash_max_capping' => ['nullable', 'integer', 'min:0', 'max:1000000'],

            // Subscriptions
            'subscription_popup_enabled' => ['nullable', 'boolean'],
            'subscription_popup_title' => ['nullable', 'string', 'max:191'],
            'subscription_popup_desc' => ['nullable', 'string', 'max:1000'],
            'subscription_popup_button1' => ['nullable', 'string', 'max:120'],
            'subscription_popup_button2' => ['nullable', 'string', 'max:120'],

            // Templates
            'customer_ride_accept_msg' => ['nullable', 'string', 'max:2000'],
            'ride_cancellation_msg' => ['nullable', 'string', 'max:2000'],
        ]);

        $settings = OperatorSetting::instance();

        // Min must not exceed a real max (max 0 = no limit). Resolve each side
        // against the STORED value when the request omits it, so a partial update
        // (only one of the two fields sent) is still validated against its
        // persisted counterpart — otherwise an inconsistent min > max could be
        // saved and freeze the wallet for every manual move.
        $min = array_key_exists('wallet_cash_min_capping', $data)
            ? (int) $data['wallet_cash_min_capping']
            : (int) $settings->wallet_cash_min_capping;
        $max = array_key_exists('wallet_cash_max_capping', $data)
            ? (int) $data['wallet_cash_max_capping']
            : (int) $settings->wallet_cash_max_capping;
        if ($max > 0 && $min > $max) {
            return response()->json([
                'message' => 'Wallet minimum capping cannot be greater than the maximum.',
            ], 422);
        }

        // At least one payment method must stay enabled or the apps have nothing
        // to offer. Resolve each switch against the STORED value when the request
        // omits it, so a partial update can't turn the last one off unseen.
        $paymentSwitches = [
            'payment_online_enabled',
            'payment_gpay_enabled',
            'payment_cash_enabled',
        ];
        $anyPaymentOn = false;
        foreach ($paymentSwitches as $switch) {
            $on = array_key_exists($switch, $data)
                ? (bool) $data[$switch]
                : (bool) $settings->{$switch};
            $anyPaymentOn = $anyPaymentOn || $on;
        }
        if (!$anyPaymentOn) {
            return response()->json([
                'message' => 'At least one payment method (Online, GPay or Cash) must stay enabled.',
            ], 422);
        }

        $settings->fill($data);
        $settings->save();

        return response()->json([
            'settings' => $settings->fresh()->toArray(),
            'message' => 'Operator settings updated.',
        ]);
    }
}
