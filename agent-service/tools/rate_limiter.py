import time
from collections import deque
from datetime import datetime, timezone
from typing import Dict, Set, Optional, Any
from fastapi import HTTPException
from config import settings


class UserRateLimiter:
    """
    In-memory, user-id level rate limiter managing:
    1. Maximum new conversations per day (e.g. 5 conversations / day).
    2. Maximum total requests per day (e.g. 100 requests / day).
    3. Maximum requests per minute (anti-burst / anti-spam).
    Dynamically configurable at runtime via Admin API without restarting.
    """

    def __init__(self):
        self.enabled: bool = getattr(settings, "RATE_LIMIT_ENABLED", True)
        self.max_conversations_per_day: int = getattr(settings, "DEFAULT_MAX_CONVERSATIONS_PER_DAY", 5)
        self.max_requests_per_day: int = getattr(settings, "DEFAULT_MAX_REQUESTS_PER_DAY", 100)
        self.max_requests_per_minute: int = getattr(settings, "DEFAULT_MAX_REQUESTS_PER_MINUTE", 25)

        # In-memory storage: user_id -> user usage record
        self._user_records: Dict[str, Dict[str, Any]] = {}

    def _today_str(self) -> str:
        """Returns the current date in YYYY-MM-DD UTC."""
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _get_or_reset_user_record(self, user_id: str) -> Dict[str, Any]:
        today = self._today_str()
        rec = self._user_records.get(user_id)

        if not rec or rec.get("date") != today:
            rec = {
                "date": today,
                "daily_requests": 0,
                "threads_today": set(),
                "minute_timestamps": deque(),
            }
            self._user_records[user_id] = rec

        return rec

    def check_and_record(self, user_id: str, thread_id: str, is_new_conversation: bool = False) -> None:
        """
        Validates request against user's conversation quota and rate limits.
        Raises HTTPException(429) if any limit is exceeded.
        """
        if not self.enabled:
            return

        user_key = (user_id or "anonymous").strip()
        rec = self._get_or_reset_user_record(user_key)
        now = time.time()

        # 1. Daily Conversation Quota Check
        threads: Set[str] = rec["threads_today"]
        is_fresh_thread = (thread_id not in threads) or is_new_conversation

        if is_fresh_thread:
            if len(threads) >= self.max_conversations_per_day:
                raise HTTPException(
                    status_code=429,
                    detail=(
                        f"Daily conversation limit reached: You have already started "
                        f"{self.max_conversations_per_day} booking conversations today. "
                        f"Please try again tomorrow."
                    ),
                )
            threads.add(thread_id)

        # 2. Daily Total Requests Quota Check
        if rec["daily_requests"] >= self.max_requests_per_day:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Daily request limit reached: You have reached the maximum of "
                    f"{self.max_requests_per_day} requests for today. Please try again tomorrow."
                ),
            )

        # 3. Sliding Window Per-Minute (RPM) Check
        timestamps: deque = rec["minute_timestamps"]
        while timestamps and now - timestamps[0] > 60:
            timestamps.popleft()

        if len(timestamps) >= self.max_requests_per_minute:
            retry_after = int(60 - (now - timestamps[0])) + 1
            raise HTTPException(
                status_code=429,
                detail="Rate limit exceeded: You are sending requests too quickly. Please wait a moment.",
                headers={"Retry-After": str(max(1, retry_after))},
            )

        # Record successful request
        rec["daily_requests"] += 1
        timestamps.append(now)

    def get_usage(self, user_id: str) -> Dict[str, Any]:
        """Returns current daily and per-minute usage for a user."""
        rec = self._get_or_reset_user_record(user_id)
        now = time.time()
        timestamps = [t for t in rec["minute_timestamps"] if now - t <= 60]

        return {
            "user_id": user_id,
            "date": rec["date"],
            "conversations_used_today": len(rec["threads_today"]),
            "max_conversations_per_day": self.max_conversations_per_day,
            "requests_used_today": rec["daily_requests"],
            "max_requests_per_day": self.max_requests_per_day,
            "requests_last_minute": len(timestamps),
            "max_requests_per_minute": self.max_requests_per_minute,
        }

    def reset_user(self, user_id: str) -> None:
        """Resets rate limiting metrics for a specific user."""
        self._user_records.pop(user_id, None)

    def get_config(self) -> Dict[str, Any]:
        """Returns the current active rate limit configuration."""
        return {
            "max_conversations_per_day": self.max_conversations_per_day,
            "max_requests_per_day": self.max_requests_per_day,
            "max_requests_per_minute": self.max_requests_per_minute,
            "enabled": self.enabled,
        }

    def update_config(
        self,
        max_conversations_per_day: Optional[int] = None,
        max_requests_per_day: Optional[int] = None,
        max_requests_per_minute: Optional[int] = None,
        enabled: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Dynamically modifies rate limits at runtime (called by Admin API)."""
        if max_conversations_per_day is not None:
            self.max_conversations_per_day = max_conversations_per_day
        if max_requests_per_day is not None:
            self.max_requests_per_day = max_requests_per_day
        if max_requests_per_minute is not None:
            self.max_requests_per_minute = max_requests_per_minute
        if enabled is not None:
            self.enabled = enabled

        return self.get_config()


# Global singleton instance
rate_limiter = UserRateLimiter()
