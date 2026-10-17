import httpx
from typing import Dict, Any, List, Optional
from config import settings


class LaravelApiClient:
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or settings.LARAVEL_API_BASE_URL).rstrip("/")

    def _headers(self, token: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def get_fixed_routes(
        self,
        lat: Optional[float] = None,
        lng: Optional[float] = None,
        q: Optional[str] = None,
        token: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch active fixed routes, optionally sorted by distance to user coordinates."""
        params: Dict[str, Any] = {"scope": "local"}
        if lat is not None and lng is not None:
            params["lat"] = lat
            params["lng"] = lng
        if q:
            params["q"] = q

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/fixed/routes",
                params=params,
                headers=self._headers(token),
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", [])

    async def get_route_departures(
        self, route_id: int, token: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Fetch available departures/vehicles for a specific fixed route."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/fixed/routes/{route_id}/departures",
                headers=self._headers(token),
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", [])

    async def get_departure_seat_map(
        self, departure_id: int, token: Optional[str] = None
    ) -> Dict[str, Any]:
        """Fetch the seat layout and per-seat availability for a departure."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/fixed/departures/{departure_id}/seat-map",
                headers=self._headers(token),
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json()

    async def create_seat_hold(
        self,
        route_departure_id: int,
        board_stop_id: int,
        drop_stop_id: int,
        seats: int = 1,
        seat_labels: Optional[List[str]] = None,
        has_extra_luggage: bool = False,
        extra_luggage_count: int = 0,
        payment_method: str = "razorpay",
        token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Request a seat hold from the assigned departure driver."""
        payload: Dict[str, Any] = {
            "route_departure_id": route_departure_id,
            "board_stop_id": board_stop_id,
            "drop_stop_id": drop_stop_id,
            "seats": seats,
            "payment_method": payment_method,
            "has_extra_luggage": has_extra_luggage,
            "extra_luggage_count": extra_luggage_count,
        }
        if seat_labels:
            payload["seat_labels"] = seat_labels

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/fixed/seat-holds",
                json=payload,
                headers=self._headers(token),
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json()

    async def get_seat_hold(
        self, seat_hold_id: int, token: Optional[str] = None
    ) -> Dict[str, Any]:
        """Inspect current status of a seat hold."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/fixed/seat-holds/{seat_hold_id}",
                headers=self._headers(token),
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json()

    async def create_razorpay_order(
        self, seat_hold_id: int, token: Optional[str] = None
    ) -> Dict[str, Any]:
        """Generate Razorpay order for an approved seat hold."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/fixed/seat-holds/{seat_hold_id}/razorpay-order",
                headers=self._headers(token),
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json()


api_client = LaravelApiClient()
