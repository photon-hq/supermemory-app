import type { InstallationRow } from "./db.ts";
import type { CallbackOutcome } from "./installations.ts";

const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --bg: #fff; --line: #e5e5e5; --ok: #157f3b; --warn: #a15c00; --bad: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #999; --bg: #111; --line: #2a2a2a; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; }
  p { margin: 8px 0; } .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 8px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  a.button { display: inline-block; margin-top: 16px; padding: 10px 16px; border-radius: 999px; background: var(--fg); color: var(--bg); text-decoration: none; font-weight: 550; }
  code { font-size: 13px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const statusClass = (result: string) =>
  result === "active" || result === "done" ? "ok" : result === "inactive" || result === "failed" ? "bad" : "warn";

const SCOPE_NOTE =
  "Photon sends this App <code>message.received</code> from the projects the admin chose when installing. " +
  "Projects created later are included only if they chose All projects; they can change this under Integrations → Apps.";

export function homePage(options: {
  installations: InstallationRow[];
  deliveries: { status: string; count: number }[];
}): string {
  const rows = options.installations
    .map(
      (row) => `<tr>
  <td>${escape(row.organization_name ?? "Unknown organization")}<br><code class="muted">${escape(row.installation_id)}</code></td>
  <td class="${statusClass(row.status)}">${escape(row.organization_id ? row.status : "waiting for the first check")}${row.status_detail ? `<br><span class="muted">${escape(row.status_detail)}</span>` : ""}</td>
  <td class="muted">${escape(row.checked_at ?? "never")}</td>
</tr>`,
    )
    .join("");
  const deliveries =
    options.deliveries.map((d) => `<span class="${statusClass(d.status)}">${escape(d.status)} ${d.count}</span>`).join(" · ") ||
    "None yet";

  return page(
    "Supermemory App",
    `<h1>Supermemory for Photon</h1>
<p class="muted">An experimental Photon App: once an organization installs it, inbound messages in its projects become memories of the people who sent them, in <a href="https://supermemory.ai">Supermemory</a>.</p>
<a class="button" href="/install">Install on Photon</a>
<h2>Installations</h2>
${rows ? `<table><tr><th>Organization</th><th>Status</th><th>Last checked</th></tr>${rows}</table>` : `<p class="muted">Not installed anywhere yet.</p>`}
<h2>Messages relayed</h2>
<p>${deliveries}</p>
<p class="muted">${SCOPE_NOTE}</p>`,
  );
}

/** What each credential-less redeem answer means for the admin, per Photon's App guide. */
const NOT_DELIVERED: Record<Extract<CallbackOutcome, { kind: "not-delivered" }>["status"], { title: string; body: string }> = {
  delivery_consumed: {
    title: "Nothing new to collect",
    body: "Photon handed this installation's credential over once already and won't send it again.",
  },
  recovery_required: {
    title: "The installation needs repair",
    body: "Photon can't hand over this installation's credential. An Owner or Admin can repair it from Integrations → Apps in Photon, then install again from here.",
  },
  revocation_pending: {
    title: "This installation is being removed",
    body: "Photon is revoking this installation, so it isn't connected. Install again from here to reconnect.",
  },
  revoked: {
    title: "This installation was removed",
    body: "Photon has revoked this installation, so it isn't connected. Install again from here to reconnect.",
  },
};

export function callbackPage(outcome: CallbackOutcome): string {
  if (outcome.kind === "not-delivered") {
    const { title, body } = NOT_DELIVERED[outcome.status];
    const stored =
      outcome.status === "delivery_consumed" && outcome.stored
        ? "<p>This service already has it, so nothing is lost: the installation stays connected.</p>"
        : "";
    return page(
      title,
      `<h1>${escape(title)}</h1>
<p>${escape(body)}</p>${stored}
<p class="muted">Installation <code>${escape(outcome.installationId)}</code> · <code>${escape(outcome.status)}</code></p>
<a class="button" href="/">Back</a>`,
    );
  }
  const { installation, check } = outcome;
  return page(
    "Installed",
    `<h1>Installed${check.status === "active" ? ` in ${escape(check.organizationName)}` : ""}</h1>
<p>Installation <code>${escape(installation.installation_id)}</code>:
<span class="${statusClass(check.status)}">${escape(check.status)}</span>${"detail" in check ? ` — ${escape(check.detail)}` : ""}</p>
<p>${SCOPE_NOTE}</p>
<a class="button" href="/">Done</a>`,
  );
}

export function messagePage(title: string, message: string, status: "ok" | "warn" | "bad" = "warn"): string {
  return page(title, `<h1 class="${status}">${escape(title)}</h1><p>${escape(message)}</p><a class="button" href="/">Back</a>`);
}
