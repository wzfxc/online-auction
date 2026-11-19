let serverOffsetMs = 0;

/** Updates the client-to-server clock skew using an ISO timestamp sent by the API/socket server. */
export function syncServerTime(serverTimeIso: string): void {
  const serverMs = new Date(serverTimeIso).getTime();
  if (!Number.isNaN(serverMs)) {
    serverOffsetMs = serverMs - Date.now();
  }
}

export function getServerOffsetMs(): number {
  return serverOffsetMs;
}

/** Current server-aligned epoch milliseconds (invariant 10: ignores local clock skew). */
export function serverNowMs(): number {
  return Date.now() + serverOffsetMs;
}

export function serverNowDate(): Date {
  return new Date(serverNowMs());
}
