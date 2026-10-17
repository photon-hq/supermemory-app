import { photonJson, type Fetch } from "./http.ts";

export interface CurrentOrganization {
  organizationId: string;
  name: string;
}

export interface Project {
  projectId: string;
  organizationId: string;
  name: string;
  deletedAt: string | null;
}

export interface CreatedWebhookDestination {
  destination: { destinationId: string; projectId: string; url: string };
  signingSecret: string;
}

/** The few Photon API calls this App makes, each with the App's bearer token. */
export function createPhotonApi(options: { apiOrigin: string; fetch?: Fetch }) {
  const fetchImpl = options.fetch ?? fetch;
  const url = (path: string) => new URL(path, options.apiOrigin).href;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  return {
    /** The organization the token belongs to. Needs `organization:read`. */
    currentOrganization(token: string) {
      return photonJson<CurrentOrganization>(fetchImpl, "Read current organization", url("/v1/organizations/current"), {
        headers: auth(token),
      });
    },

    /** Every live project in the organization. Needs `organization:read_projects`. */
    async listProjects(token: string, organizationId: string): Promise<Project[]> {
      const projects: Project[] = [];
      let pageToken: string | undefined;
      do {
        const page = new URL(url(`/v1/organizations/${encodeURIComponent(organizationId)}/projects`));
        page.searchParams.set("pageSize", "100");
        if (pageToken) page.searchParams.set("pageToken", pageToken);
        const body = await photonJson<{ projects: Project[]; nextPageToken?: string }>(
          fetchImpl,
          "List projects",
          page.href,
          { headers: auth(token) },
        );
        projects.push(...body.projects.filter((project) => !project.deletedAt));
        pageToken = body.nextPageToken || undefined;
      } while (pageToken);
      return projects;
    },

    /**
     * A `message.received` destination in one project. Needs `project:write`,
     * and Photon accepting an App's token on this route, which it does not yet
     * (ENG-4010).
     */
    createWebhookDestination(
      token: string,
      projectId: string,
      input: { name: string; url: string; apiVersion: string; description?: string },
      idempotencyKey: string,
    ) {
      return photonJson<CreatedWebhookDestination>(
        fetchImpl,
        "Create webhook destination",
        url(`/v1/projects/${encodeURIComponent(projectId)}/webhooks/destinations`),
        {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ ...input, enabledEvents: ["message.received"] }),
        },
      );
    },

    deleteWebhookDestination(token: string, projectId: string, destinationId: string, idempotencyKey: string) {
      return photonJson<unknown>(
        fetchImpl,
        "Delete webhook destination",
        url(
          `/v1/projects/${encodeURIComponent(projectId)}/webhooks/destinations/${encodeURIComponent(destinationId)}`,
        ),
        { method: "DELETE", headers: { ...auth(token), "idempotency-key": idempotencyKey } },
      );
    },
  };
}

export type PhotonApi = ReturnType<typeof createPhotonApi>;
