import type { BugReport } from "@/lib/bugreport/types";
import { CATEGORY_LABELS } from "@/lib/bugreport/types";
import type { BugReportSink } from "./index";

// Jira Cloud REST v3. Enabled only when all four env vars are set:
//   JIRA_BASE_URL     e.g. https://your-org.atlassian.net
//   JIRA_EMAIL        account the API token belongs to
//   JIRA_API_TOKEN    https://id.atlassian.com/manage-profile/security/api-tokens
//   JIRA_PROJECT_KEY  e.g. WEB
// Optional: JIRA_ISSUE_TYPE (default "Bug").

function config() {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/+$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT_KEY;
  if (!baseUrl || !email || !token || !project) return null;
  return {
    baseUrl, project,
    issueType: process.env.JIRA_ISSUE_TYPE ?? "Bug",
    auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
  };
}

const para = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const heading = (text: string) => ({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text }] });
const code = (text: string) => ({ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text }] });

export function jiraSummary(report: BugReport): string {
  const s = `[${CATEGORY_LABELS[report.category]}] ${report.description.replace(/\s+/g, " ").trim()}`;
  return s.length > 250 ? s.slice(0, 247) + "..." : s;
}

/** Atlassian Document Format body — readable in Jira without opening the attachment. */
export function jiraDescription(report: BugReport) {
  const el = report.element;
  const prov = el?.provenance;
  const content: unknown[] = [
    para(report.description),
    heading("Expected vs actual"),
    para(`Expected: ${report.expected || "—"}`),
    para(`Actual: ${report.actual || "—"}`),
    heading("Context"),
    para(`Reporter: ${report.reporter.displayName} (${report.reporter.role}) · ${report.createdAt}`),
    para(`Page: ${report.page.url}${report.page.tab ? ` (tab: ${report.page.tab})` : ""}`),
    para(`In-app report id: ${report.id}`),
  ];
  if (el) {
    content.push(heading("Element"), para(`${el.component ? `<${el.component}> ` : ""}${el.selector}`), para(`Text: ${el.text.slice(0, 300)}`));
  }
  if (prov) {
    content.push(
      heading("Data provenance"),
      para(`Operation: ${prov.op}${prov.field ? ` → ${prov.field}` : ""}${prov.entity ? ` (entity ${prov.entity})` : ""}`),
      para(`UI shows: ${prov.uiText}`),
      para(`API returned: ${prov.apiValueFound ? JSON.stringify(prov.apiValue) : "(no matching value in last response)"}`),
    );
  }
  const errors = report.console.filter((c) => c.level === "error");
  const failedCalls = report.calls.filter((c) => c.success === false);
  if (errors.length || failedCalls.length) {
    content.push(heading("Errors"));
    for (const e of errors.slice(-5)) content.push(para(`console.error: ${e.message.slice(0, 300)}`));
    for (const c of failedCalls.slice(-5)) content.push(para(`failed op: ${c.name}`));
  }
  if (report.calls.length) {
    content.push(heading("Business calls (replayable)"), code(JSON.stringify(report.calls.slice(-15), null, 2).slice(0, 8000)));
  }
  content.push(para("Full bundle (console, network, DOM, screenshot) attached."));
  return { type: "doc", version: 1, content };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",", 2);
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? "application/octet-stream";
  return new Blob([Buffer.from(b64, "base64")], { type: mime });
}

export const jiraSink: BugReportSink = {
  name: "jira",
  enabled: () => config() !== null,
  async send(report) {
    const cfg = config()!;
    const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: { Authorization: cfg.auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        fields: {
          project: { key: cfg.project },
          issuetype: { name: cfg.issueType },
          summary: jiraSummary(report),
          description: jiraDescription(report),
          labels: ["bug-report", `category-${report.category}`],
        },
      }),
    });
    if (!res.ok) throw new Error(`Jira create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { key } = (await res.json()) as { key: string };

    const form = new FormData();
    const { screenshot, ...rest } = report;
    form.append("file", new Blob([JSON.stringify(rest, null, 2)], { type: "application/json" }), `bug-report-${report.id}.json`);
    if (screenshot) form.append("file", dataUrlToBlob(screenshot), `screenshot-${report.id}.${screenshot.startsWith("data:image/png") ? "png" : "jpg"}`);
    const att = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${key}/attachments`, {
      method: "POST",
      headers: { Authorization: cfg.auth, "X-Atlassian-Token": "no-check" },
      body: form,
    });
    // The issue exists either way; a failed attachment shouldn't hide its key.
    if (!att.ok) console.warn(`Jira attachment upload failed for ${key}: ${att.status}`);

    return { ref: key, url: `${cfg.baseUrl}/browse/${key}` };
  },
};
