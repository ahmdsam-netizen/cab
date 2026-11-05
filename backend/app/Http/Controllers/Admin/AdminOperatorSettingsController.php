<?php

namespace App\Http\Controllers\Admin;

use App\Models\OperatorSetting;
use App\Models\RideType;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

class AdminOperatorSettingsController
{
    public function show()
    {
        return response()->json([
            'settings' => $this->settingsPayload(OperatorSetting::instance()),
        ]);
    }

    public function update(Request $request)
    {
        $imageRules = [];
        foreach (RideType::MODES as $mode) {
            $imageRules[$mode . '_service_image'] = ['sometimes', 'required', 'image', 'mimes:jpg,jpeg,png,webp', 'max:4096'];
            $imageRules[$mode . '_remove_service_image'] = ['sometimes', 'boolean'];
        }

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
            ...$imageRules,
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

        $images = [];
        foreach (RideType::MODES as $mode) {
            $upload = $mode . '_service_image';
            $remove = $mode . '_remove_service_image';
            if (isset($data[$upload]) || !empty($data[$remove])) {
                $images[$mode . '_service_image_path'] = $data[$upload] ?? null;
            }
            unset($data[$upload], $data[$remove]);
        }

        if ($images) {
            $this->saveWithImages($settings, $data, $images);
        } else {
            $settings->update($data);
        }

        return response()->json([
            'settings' => $this->settingsPayload($settings->fresh()),
            'message' => 'Operator settings updated.',
        ]);
    }

    private function settingsPayload(OperatorSetting $settings): array
    {
        $payload = $settings->toArray();
        foreach (RideType::MODES as $mode) {
            $payload[$mode . '_service_image_url'] = $settings->serviceImageUrl($mode);
        }

        return $payload;
    }

    private function saveWithImages(OperatorSetting $settings, array $data, array $images): void
    {
        $disk = Storage::disk('public');
        $newPaths = [];
        $oldPaths = [];

        try {
            foreach ($images as $field => $image) {
                $data[$field] = null;
                if ($image) {
                    $path = $image->store('service_images', 'public');
                    abort_unless($path, 500, 'Could not store the service image.');
                    $newPaths[] = $path;
                    $data[$field] = $path;
                }
            }

            DB::transaction(function () use ($settings, $data, $images, &$oldPaths) {
                $locked = OperatorSetting::query()->lockForUpdate()->findOrFail($settings->id);
                foreach ($images as $field => $_) {
                    if ($locked->{$field}) {
                        $oldPaths[] = $locked->{$field};
                    }
                }
                $locked->update($data);
            });
        } catch (\Throwable $error) {
            $disk->delete($newPaths);
            throw $error;
        }

        $disk->delete($oldPaths);
    }
}
