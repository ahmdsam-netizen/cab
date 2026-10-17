<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    'razorpay' => [
        'key_id' => env('RAZORPAY_KEY_ID'),
        'key_secret' => env('RAZORPAY_KEY_SECRET'),
        'webhook_secret' => env('RAZORPAY_WEBHOOK_SECRET', ''),
        'currency' => env('RAZORPAY_CURRENCY', 'INR'),
    ],

    // Auto-split payment engine (Razorpay Route). While disabled the platform
    // keeps the legacy flow: the driver's commission is clawed back from their
    // wallet float at settlement. When enabled, commission is retained at the
    // source of a captured online payment and the driver's share is transferred
    // (or held, if their payout account isn't verified) — no wallet debit.
    //
    // Razorpay Route (the split-to-driver engine) has been REMOVED. Money always
    // goes to the operator now, and the driver wallet is the single settlement
    // ledger (Model B). This flag is permanently false and no longer reads the
    // environment — it stays only as a hard guard so any residual reader takes the
    // operator path. Do NOT re-enable; the Route code paths are dead.
    'payments' => [
        'split_enabled' => false,

        // The gateway fee the customer pays on top of the fare, so Razorpay's
        // cut doesn't come out of commission. Rates below are Razorpay's own
        // headline percentages; the service adds the Route split fee and GST on
        // top, so 'rate' here matches their pricing page line for line.
        //
        // Because the rate depends on the payment method and Razorpay fixes an
        // order's amount before checkout opens, the customer picks their method
        // in our app first and the order is created for that method.
        //
        // OFF by default: every quote and charge is then exactly the fare.
        'gateway_fee' => [
            'enabled' => (bool) env('PAYMENTS_GATEWAY_FEE_ENABLED', false),
            'default_rate' => (float) env('PAYMENTS_GATEWAY_FEE_DEFAULT_RATE', 2.0),
            'route_rate' => (float) env('PAYMENTS_GATEWAY_ROUTE_RATE', 0.1),
            'gst_rate' => (float) env('PAYMENTS_GATEWAY_GST_RATE', 18.0),

            // Who bears the fee, by ride mode. 'customer' adds it on top of the
            // fare (the rider sees + pays it); 'operator' keeps the rider's price
            // at the fare and books the fee against the operator at settlement.
            'borne_by' => [
                'fixed' => env('PAYMENTS_GATEWAY_FEE_FIXED_BEARER', 'customer'),
                'private' => env('PAYMENTS_GATEWAY_FEE_PRIVATE_BEARER', 'operator'),
                'shuttle' => env('PAYMENTS_GATEWAY_FEE_SHUTTLE_BEARER', 'operator'),
            ],

            // Keys are what the customer app sends back as `payment_method`.
            'methods' => [
                'upi' => ['label' => 'UPI', 'hint' => 'GPay, PhonePe, Paytm & more', 'rate' => 2.0],
                'card' => ['label' => 'Debit / Credit card', 'hint' => 'Visa, Mastercard, RuPay', 'rate' => 2.0],
                'netbanking' => ['label' => 'Net banking', 'hint' => '70+ banks', 'rate' => 2.0],
                'wallet' => ['label' => 'Wallet', 'hint' => 'Paytm, Mobikwik & more', 'rate' => 2.0],
                'premium_card' => ['label' => 'Amex / Diners / corporate card', 'hint' => 'Higher gateway charge', 'rate' => 3.0],
                'emi' => ['label' => 'EMI / Pay Later', 'hint' => 'Higher gateway charge', 'rate' => 3.0],
                'international' => ['label' => 'International card', 'hint' => 'Higher gateway charge', 'rate' => 3.0],
            ],
        ],
    ],

    // MSG91 SMS gateway (login OTP). Leave MSG91_AUTH_KEY blank to run in MOCK
    // mode: no SMS is sent — the code is logged + returned in the API response
    // so you can test the whole flow. Fill the keys to send real SMS.
    'msg91' => [
        'authkey' => env('MSG91_AUTH_KEY', ''),
        'template_id' => env('MSG91_TEMPLATE_ID', ''),   // DLT-approved flow template id (login OTP)
        'sender' => env('MSG91_SENDER_ID', ''),
        'otp_var' => env('MSG91_OTP_VAR', 'otp'),         // variable name in your template
        'flow_url' => env('MSG91_FLOW_URL', 'https://control.msg91.com/api/v5/flow'),
        'otp_ttl_min' => (int) env('MSG91_OTP_TTL_MIN', 5),
        'resend_cooldown_sec' => (int) env('MSG91_OTP_RESEND_SEC', 30),
        'max_attempts' => (int) env('MSG91_OTP_MAX_ATTEMPTS', 5),
        'default_message' => env('MSG91_DEFAULT_OTP_MESSAGE', '{otp} is your verification code. Valid for {ttl} minutes.'),
    ],

    // Agentic AI Microservice (FastAPI + LangGraph) for conversational ride booking.
    'agent_service' => [
        'base_url' => env('AGENT_SERVICE_URL', 'http://127.0.0.1:8105'),
        'webhook_secret' => env('AGENT_SERVICE_WEBHOOK_SECRET', 'dreamcabs-agent-secret-key'),
        'timeout' => (float) env('AGENT_SERVICE_TIMEOUT', 15.0),
    ],

];
