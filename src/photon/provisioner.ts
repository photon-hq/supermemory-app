import type { ManualDestination } from "../config.ts";
import { open, randomToken, seal } from "../crypto.ts";
import type { InstallationRow, Store } from "../db.ts";
import type { PhotonApi } from "./api.ts";
import { PhotonError } from "./http.ts";

/** Where a webhook arriving at `/webhooks/photon/:key` came from, and how to check it. */
export interface ResolvedDestination {
  organizationId: string;
  projectId: string;
  secret: string;
}

export interface ProjectOutcome {
  projectId: string;
  projectName: string;
  result: "created" | "existing" | "refused" | "error";
  detail?: string;
}

export interface ProvisionReport {
  mode: "manual" | "app";
  summary: string;
  projects: ProjectOutcome[];
}

/**
 * Gets `message.received` webhooks pointed at this service. The one seam
 * between what works today (`manual`) and what Photon doesn't allow an App
 * yet (`app`, ENG-4010).
 */
export interface WebhookProvisioner {
  mode: "manual" | "app";
  resolve(key: string): ResolvedDestination | null;
  /** After install, and on each health check while the installation is active. */
  ensure(installation: InstallationRow, token: string): Promise<ProvisionReport>;
  /** Once an installation is gone: stop accepting its webhooks. */
  release(installation: InstallationRow): void;
}

/** Destinations someone created by hand in Photon's Webhooks page, from config. */
export function createManualProvisioner(destinations: Record<string, ManualDestination>): WebhookProvisioner {
  return {
    mode: "manual",
    resolve: (key) => (Object.hasOwn(destinations, key) ? destinations[key]! : null),
    async ensure(installation) {
      const mine = Object.values(destinations).filter((d) => d.organizationId === installation.organization_id);
      return {
        mode: "manual",
        summary:
          mine.length > 0
            ? `${mine.length} hand-made webhook destination(s) are configured for this organization.`
            : "No webhook destination is configured for this organization yet. Create one by hand in a project's Webhooks page and add it to MANUAL_DESTINATIONS.",
        projects: mine.map((d) => ({ projectId: d.projectId, projectName: d.projectId, result: "existing" })),
      };
    },
    release() {},
  };
}

/**
 * The App creates a `message.received` destination in each of the
 * organization's projects with its own token. Photon refuses an App's token
 * on webhook destinations today, so expect `refused` until ENG-4010's backend
 * change lands.
 */
export function createAppProvisioner(options: {
  store: Store;
  api: PhotonApi;
  dataKey: Buffer;
  publicBaseUrl: string;
  webhookApiVersion: string;
}): WebhookProvisioner {
  const { store, api, dataKey } = options;

  return {
    mode: "app",
    resolve(key) {
      const row = store.getDestination(key);
      if (!row) return null;
      return { organizationId: row.organization_id, projectId: row.project_id, secret: open(dataKey, row.secret_sealed) };
    },

    async ensure(installation, token) {
      const organizationId = installation.organization_id;
      if (!organizationId) {
        return { mode: "app", summary: "The installation's organization isn't known yet.", projects: [] };
      }
      const have = new Set(store.destinationsFor(installation.installation_id).map((row) => row.project_id));
      const projects = await api.listProjects(token, organizationId);
      const outcomes: ProjectOutcome[] = [];

      for (const project of projects) {
        if (have.has(project.projectId)) {
          outcomes.push({ projectId: project.projectId, projectName: project.name, result: "existing" });
          continue;
        }
        const key = randomToken(18);
        try {
          const created = await api.createWebhookDestination(
            token,
            project.projectId,
            {
              name: "Supermemory",
              description: "Mirrors inbound messages to Supermemory (experimental App, ENG-4010).",
              url: new URL(`/webhooks/photon/${key}`, options.publicBaseUrl).href,
              apiVersion: options.webhookApiVersion,
            },
            // One destination per installation and project, even if this runs twice.
            `supermemory:${installation.installation_id}:${project.projectId}`,
          );
          store.insertDestination({
            key,
            organization_id: organizationId,
            project_id: project.projectId,
            installation_id: installation.installation_id,
            destination_id: created.destination.destinationId,
            secret_sealed: seal(dataKey, created.signingSecret),
          });
          outcomes.push({ projectId: project.projectId, projectName: project.name, result: "created" });
        } catch (error) {
          const refused = error instanceof PhotonError && (error.status === 401 || error.status === 403);
          outcomes.push({
            projectId: project.projectId,
            projectName: project.name,
            result: refused ? "refused" : "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const refused = outcomes.filter((o) => o.result === "refused").length;
      return {
        mode: "app",
        summary:
          refused > 0
            ? `Photon refused the App's token on webhook destinations in ${refused} of ${outcomes.length} project(s). ` +
              "Apps can't create webhooks yet; this is what ENG-4010 is blocked on."
            : `${outcomes.filter((o) => o.result !== "error").length} of ${outcomes.length} project(s) have a destination.`,
        projects: outcomes,
      };
    },

    release(installation) {
      // The App's token is revoked by now, so Photon's destinations can't be
      // deleted from here; forgetting them makes this service refuse their
      // webhooks. Removing them in Photon is part of the ENG-4010 ask.
      for (const row of store.destinationsFor(installation.installation_id)) store.deleteDestination(row.key);
    },
  };
}
