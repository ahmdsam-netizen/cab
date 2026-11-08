<?php

namespace App\Http\Controllers;

use App\Services\AgenticAiService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AgenticAiController extends Controller
{
    public function __construct(
        private readonly AgenticAiService $aiService,
    ) {}

    /**
     * Check Agentic AI service status and connectivity.
     */
    public function health(): JsonResponse
    {
        $health = $this->aiService->health();
        $status = $health['online'] ? 200 : 503;

        return response()->json($health, $status);
    }

    /**
     * Conversational ride booking chat endpoint.
     */
    public function chat(Request $request): JsonResponse
    {
        $data = $request->validate([
            'message' => ['required', 'string', 'max:1000'],
            'thread_id' => ['nullable', 'string', 'max:100'],
            'user_current_lat' => ['nullable', 'numeric', 'between:-90,90'],
            'user_current_lng' => ['nullable', 'numeric', 'between:-180,180'],
            'action' => ['nullable', 'string', 'max:50'],
            'selected_departure_id' => ['nullable', 'integer'],
            'seats_requested' => ['nullable', 'integer', 'min:1', 'max:20'],
            'has_extra_luggage' => ['nullable', 'boolean'],
            'extra_luggage_count' => ['nullable', 'integer', 'min:0', 'max:20'],
            'selected_seat_labels' => ['nullable', 'array'],
            'selected_seat_labels.*' => ['string', 'max:10'],
            'voice_mode' => ['nullable', 'boolean'],
            'preferred_language' => ['nullable', 'string', 'in:en,hi,ur'],
        ]);

        $bearerToken = $request->bearerToken();
        $response = $this->aiService->chat($request->user(), $data, $bearerToken);

        $httpCode = 200;
        if (isset($response['stage']) && in_array($response['stage'], ['ERROR', 'SERVICE_UNAVAILABLE'], true)) {
            $httpCode = $response['stage'] === 'SERVICE_UNAVAILABLE' ? 503 : 500;
        }

        return response()->json($response, $httpCode);
    }

    /**
     * Get rate limit settings from agent microservice.
     */
    public function getRateLimitConfig(): JsonResponse
    {
        $config = $this->aiService->getRateLimitConfig();
        $status = isset($config['error']) ? 502 : 200;

        return response()->json($config, $status);
    }

    /**
     * Update rate limit settings on agent microservice.
     */
    public function updateRateLimitConfig(Request $request): JsonResponse
    {
        $data = $request->validate([
            'max_conversations_per_day' => ['nullable', 'integer', 'min:1', 'max:1000'],
            'max_requests_per_day' => ['nullable', 'integer', 'min:1', 'max:10000'],
            'max_requests_per_minute' => ['nullable', 'integer', 'min:1', 'max:500'],
            'enabled' => ['nullable', 'boolean'],
        ]);

        $res = $this->aiService->updateRateLimitConfig($data);
        $status = isset($res['error']) ? 502 : 200;

        return response()->json($res, $status);
    }

    /**
     * Inspect usage for a specific user ID.
     */
    public function getUserRateLimitUsage(string $userId): JsonResponse
    {
        $res = $this->aiService->getUserRateLimitUsage($userId);
        $status = isset($res['error']) ? 502 : 200;

        return response()->json($res, $status);
    }

    /**
     * Reset rate limit usage counters for a user.
     */
    public function resetUserRateLimit(string $userId): JsonResponse
    {
        $res = $this->aiService->resetUserRateLimit($userId);
        $status = isset($res['error']) ? 502 : 200;

        return response()->json($res, $status);
    }

    /**
     * Get API key configuration from agent microservice.
     */
    public function getApiKeyConfig(): JsonResponse
    {
        $res = $this->aiService->getApiKeyConfig();
        $status = isset($res['error']) ? 502 : 200;

        return response()->json($res, $status);
    }

    /**
     * Update API key configuration on agent microservice.
     */
    public function updateApiKeyConfig(Request $request): JsonResponse
    {
        $data = $request->validate([
            'openai_api_key' => ['nullable', 'string', 'max:255'],
            'gemini_api_key' => ['nullable', 'string', 'max:255'],
            'llm_provider' => ['nullable', 'string', 'in:openai,google,gemini,mock'],
        ]);

        $res = $this->aiService->updateApiKeyConfig($data);
        $status = isset($res['error']) ? 502 : 200;

        return response()->json($res, $status);
    }
}
