import type { Fetch } from "../photon/http.ts";
import type { SupermemoryDocument } from "./map.ts";

/** A failed write, and whether trying again later could succeed. */
export class SupermemoryError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(status: number | null, retryable: boolean, detail: string) {
    super(`Supermemory ${status === null ? "request" : `HTTP ${status}`}: ${detail}`);
    this.name = "SupermemoryError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** Supermemory v5: `POST /ns/{namespace}/document`, Bearer auth. */
export function createSupermemoryClient(options: { apiOrigin: string; apiKey: string; fetch?: Fetch }) {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async addDocument(document: SupermemoryDocument): Promise<{ id: string; status: string }> {
      const { namespace, ...body } = document;
      let response: Response;
      try {
        response = await fetchImpl(
          new URL(`/ns/${encodeURIComponent(namespace)}/document`, options.apiOrigin).href,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ ...body, taskType: "memory" }),
            signal: AbortSignal.timeout(20_000),
          },
        );
      } catch (error) {
        throw new SupermemoryError(null, true, error instanceof Error ? error.name : "network error");
      }
      if (response.ok) return (await response.json()) as { id: string; status: string };

      let detail = response.statusText || "error";
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") detail = body.error.slice(0, 200);
      } catch {
        // Not JSON.
      }
      // 409: the same document id written concurrently; worth another try.
      const retryable = response.status === 409 || response.status === 429 || response.status >= 500;
      throw new SupermemoryError(response.status, retryable, detail);
    },
  };
}

export type SupermemoryClient = ReturnType<typeof createSupermemoryClient>;
