"""Server-sent events: every connected browser tab gets its own queue."""
import asyncio
import json
from collections.abc import AsyncIterator

HEARTBEAT_SECONDS = 15


class Broker:
    def __init__(self) -> None:
        self._clients: set[asyncio.Queue[tuple[str, dict]]] = set()

    def publish(self, event: str, data: dict) -> None:
        for queue in list(self._clients):
            if queue.full():  # a stalled tab drops its oldest events instead of growing without bound
                queue.get_nowait()
            queue.put_nowait((event, data))

    async def stream(self) -> AsyncIterator[str]:
        queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue(maxsize=1000)
        self._clients.add(queue)
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
        finally:
            self._clients.discard(queue)


broker = Broker()
