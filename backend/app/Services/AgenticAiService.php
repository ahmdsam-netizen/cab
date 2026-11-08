<?php

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

class AgenticAiService
{
    /**
     * Get the base URL for the FastAPI LangGraph microservice.
     */
    public function baseUrl(): string
    {
        return rtrim((string) config('services.agent_service.base_url', 'http://127.0.0.1:8108'), '/');
    }

    /**
     * Get request timeout in seconds.
     */
    public function timeout(): float
    {
        return (float) config('services.agent_service.timeout', 15.0);
    }

    /**
     * Check if the Agentic AI microservice is healthy.
     */
    public function health(): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->get("{$this->baseUrl()}/health");

            if ($response->successful()) {
                return [
                    'online' => true,
                    'status' => 'healthy',
                    'service_response' => $response->json(),
                ];
            }

            return [
                'online' => false,
                'status' => 'unhealthy',
                'status_code' => $response->status(),
                'error' => $response->body(),
            ];
        } catch (Throwable $e) {
            Log::warning('Agentic AI microservice health check failed', ['error' => $e->getMessage()]);
            return [
                'online' => false,
                'status' => 'unreachable',
                'error' => $e->getMessage(),
            ];
        }
    }

    /**
     * Send a conversational message / action to the LangGraph booking agent.
     */
    public function chat(?User $user, array $data, ?string $bearerToken = null): array
    {
        $userId = $user ? $user->id : 'guest';
        $threadId = !empty($data['thread_id']) ? (string) $data['thread_id'] : "customer_{$userId}";

        $payload = [
            'message' => (string) ($data['message'] ?? ''),
            'thread_id' => $threadId,
            'auth_token' => $bearerToken,
            'user_current_lat' => isset($data['user_current_lat']) ? (float) $data['user_current_lat'] : null,
            'user_current_lng' => isset($data['user_current_lng']) ? (float) $data['user_current_lng'] : null,
            'action' => $data['action'] ?? null,
            'selected_departure_id' => isset($data['selected_departure_id']) ? (int) $data['selected_departure_id'] : null,
            'seats_requested' => isset($data['seats_requested']) ? (int) $data['seats_requested'] : null,
            'has_extra_luggage' => isset($data['has_extra_luggage']) ? (bool) $data['has_extra_luggage'] : null,
            'extra_luggage_count' => isset($data['extra_luggage_count']) ? (int) $data['extra_luggage_count'] : 0,
            'selected_seat_labels' => !empty($data['selected_seat_labels']) && is_array($data['selected_seat_labels'])
                ? array_values($data['selected_seat_labels'])
                : null,
            'voice_mode' => isset($data['voice_mode']) ? (bool) $data['voice_mode'] : false,
            'preferred_language' => $data['preferred_language'] ?? 'en',
        ];

        try {
            $response = Http::timeout($this->timeout())
                ->acceptJson()
                ->post("{$this->baseUrl()}/chat", $payload);

            if ($response->successful()) {
                return $response->json();
            }

            Log::error('Agentic AI /chat error response', [
                'status' => $response->status(),
                'body' => $response->body(),
                'user_id' => $userId,
            ]);

            return [
                'reply' => "I'm having a little trouble connecting with our booking system right now. Please try again in a moment.",
                'stage' => 'ERROR',
                'thread_id' => $threadId,
                'error' => $response->json('detail') ?: 'Agent service error (' . $response->status() . ')',
            ];
        } catch (Throwable $e) {
            Log::error('Agentic AI /chat connection failed', [
                'error' => $e->getMessage(),
                'user_id' => $userId,
            ]);

            return [
                'reply' => "Our AI ride assistant is temporarily offline or undergoing maintenance. Please choose your ride manually or try again shortly.",
                'stage' => 'SERVICE_UNAVAILABLE',
                'thread_id' => $threadId,
                'error' => 'Could not connect to Agent microservice: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Notify the LangGraph agent when a driver accepts or rejects a seat hold.
     * Wakes up paused LangGraph state so the agent can progress without LLM waiting.
     */
    public function notifyDriverEvent(
        int $seatHoldId,
        string $event,
        ?int $driverId = null,
        ?string $reason = null
    ): ?array {
        $payload = [
            'seat_hold_id' => $seatHoldId,
            'event' => $event, // 'DRIVER_ACCEPTED' or 'DRIVER_REJECTED'
            'driver_id' => $driverId,
            'reason' => $reason,
        ];

        try {
            $response = Http::timeout(5.0)
                ->acceptJson()
                ->post("{$this->baseUrl()}/webhook/driver-event", $payload);

            if ($response->successful()) {
                Log::info("Agentic AI driver-event webhook notified: {$event}", [
                    'seat_hold_id' => $seatHoldId,
                ]);
                return $response->json();
            }

            Log::warning("Agentic AI driver-event webhook returned status {$response->status()}", [
                'seat_hold_id' => $seatHoldId,
                'body' => $response->body(),
            ]);
            return null;
        } catch (Throwable $e) {
            Log::warning('Failed to notify Agentic AI driver-event webhook', [
                'seat_hold_id' => $seatHoldId,
                'event' => $event,
                'error' => $e->getMessage(),
            ]);
            return null;
        }
    }

    /**
     * Get active rate limiting configuration from the agent microservice.
     */
    public function getRateLimitConfig(): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->get("{$this->baseUrl()}/admin/rate-limits/config");

            if ($response->successful()) {
                return $response->json();
            }

            return [
                'error' => 'Failed to fetch rate limit config: ' . $response->body(),
                'status_code' => $response->status(),
            ];
        } catch (Throwable $e) {
            return [
                'error' => 'Agent service unreachable: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Dynamically update rate limiting configuration on the agent microservice.
     */
    public function updateRateLimitConfig(array $data): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->post("{$this->baseUrl()}/admin/rate-limits/config", $data);

            if ($response->successful()) {
                return $response->json();
            }

            return [
                'error' => 'Failed to update rate limit config: ' . $response->body(),
                'status_code' => $response->status(),
            ];
        } catch (Throwable $e) {
            return [
                'error' => 'Agent service unreachable: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Get current day usage metrics for a specific user ID.
     */
    public function getUserRateLimitUsage(string $userId): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->get("{$this->baseUrl()}/admin/rate-limits/usage/{$userId}");

            if ($response->successful()) {
                return $response->json();
            }

            return [
                'error' => 'Failed to fetch user usage: ' . $response->body(),
                'status_code' => $response->status(),
            ];
        } catch (Throwable $e) {
            return [
                'error' => 'Agent service unreachable: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Reset rate limit usage counters for a specific user ID.
     */
    public function resetUserRateLimit(string $userId): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->post("{$this->baseUrl()}/admin/rate-limits/reset/{$userId}");

            if ($response->successful()) {
                return $response->json();
            }

            return [
                'error' => 'Failed to reset user rate limit: ' . $response->body(),
                'status_code' => $response->status(),
            ];
        } catch (Throwable $e) {
            return [
                'error' => 'Agent service unreachable: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Get API key configuration and status from agent microservice.
     */
    public function getApiKeyConfig(): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->get("{$this->baseUrl()}/admin/api-keys");

            if ($response->successful()) {
                return $response->json();
            }

            return [
                'error' => 'Failed to fetch API key config: ' . $response->body(),
                'status_code' => $response->status(),
            ];
        } catch (Throwable $e) {
            return [
                'error' => 'Agent service unreachable: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Update API key configuration on agent microservice.
     */
    public function updateApiKeyConfig(array $data): array
    {
        try {
            $response = Http::timeout(4.0)
                ->acceptJson()
                ->post("{$this->baseUrl()}/admin/api-keys", $data);

            if ($response->successful()) {
                return $response->json();
            }

            return [
                'error' => 'Failed to update API key config: ' . $response->body(),
                'status_code' => $response->status(),
            ];
        } catch (Throwable $e) {
            return [
                'error' => 'Agent service unreachable: ' . $e->getMessage(),
            ];
        }
    }
}
