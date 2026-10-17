export type Fetch = typeof fetch;

/** A Photon API answer that wasn't a success, with its problem code when it sent one. */
export class PhotonError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly operation: string;

  constructor(operation: string, status: number, code: string | null, detail: string | null) {
    super(`${operation} failed: HTTP ${status}${code ? ` ${code}` : ""}${detail ? ` — ${detail}` : ""}`);
    this.name = "PhotonError";
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

/** Reads a Photon problem response without ever echoing anything secret back. */
export async function photonError(operation: string, response: Response): Promise<PhotonError> {
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.code === "string") code = body.code;
    if (typeof body.detail === "string") detail = body.detail.slice(0, 300);
    else if (typeof body.title === "string") detail = body.title.slice(0, 300);
  } catch {
    // Not JSON; the status says enough.
  }
  return new PhotonError(operation, response.status, code, detail);
}

export async function photonJson<T>(
  fetchImpl: Fetch,
  operation: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: "application/json", ...(init.headers as Record<string, string>) },
  });
  if (!response.ok) throw await photonError(operation, response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
