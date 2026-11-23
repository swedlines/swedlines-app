import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourcesConfig } from "../config/sources.ts";
import { enabledSources } from "../config/sources.ts";

const here = dirname(fileURLToPath(import.meta.url));

const PAYWALL_NOTE = {
  en: {
    partial: "some articles require a subscription",
    hard: "most articles require a subscription",
  },
  sv: {
    partial: "vissa artiklar kräver prenumeration",
    hard: "de flesta artiklar kräver prenumeration",
  },
} as const;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Publisher list for the About page, rendered from sources.yaml so it cannot drift from the feed. */
export function renderPublishers(config: SourcesConfig, locale: "en" | "sv"): string {
  const items = enabledSources(config).map((s) => {
    const note = s.paywall && s.paywall !== "none" ? PAYWALL_NOTE[locale][s.paywall] : undefined;
    const suffix = note ? ` <span class="muted">(${note})</span>` : "";
    return `<li><a href="${esc(s.homepage)}" rel="noopener">${esc(s.name)}</a>${suffix}</li>`;
  });
  return `<ul class="pubs">\n${items.join("\n")}\n</ul>`;
}

/** Footer version, placed before the About link: the package version only; empty when none is given. */
export function renderVersion(
  v: { version: string; commit?: string | undefined } | undefined,
): string {
  if (!v) return "";
  return `<span class="version">v${esc(v.version)}</span> · `;
}

/** Minimal plain page for /version: version, full commit and build time, with a link to version.json. */
export function renderVersionPage(info: {
  version: string;
  commit: string | null;
  built_at: string;
}): string {
  const rows: [string, string][] = [
    ["Version", info.version],
    ["Commit", info.commit ?? "unknown"],
    ["Built", info.built_at],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Swedlines version</title>
<style>
  body { margin: 0; padding: 32px 16px; font-family: "Helvetica Neue", Arial, sans-serif; color: #15202b; background: #f7f8fa; }
  @media (prefers-color-scheme: dark) { body { color: #e8edf2; background: #0b1218; } }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-variant-numeric: tabular-nums; }
  dt { font-weight: 700; } dd { margin: 0; word-break: break-all; }
  code { font-size: 14px; }
  p { font-size: 14px; margin: 16px 0 0; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>Swedlines version</h1>
<dl>
${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join("\n")}
</dl>
<p>Machine-readable: <a href="../version.json">version.json</a> · <a href="../">Back to the headlines</a></p>
</main>
</body>
</html>
`;
}

/** Copy the stream page, About page and logo assets into the output directory; write CNAME when a domain is set. */
export async function buildSite(opts: {
  publicDir: string;
  appRoot: string;
  domain?: string | undefined;
  config?: SourcesConfig | undefined;
  /** Shown in every footer, e.g. { version: "0.1.0", commit: "3ee85ea" }. */
  version?: { version: string; commit?: string | undefined } | undefined;
  /** Show the Top tab to everyone. Without it the Top view is only reachable at /#top. */
  topTab?: boolean | undefined;
}): Promise<string[]> {
  const written: string[] = [];
  const stamp = (html: string) => html.replace("<!--VERSION-->", renderVersion(opts.version));
  if (opts.domain) {
    await writeFile(join(opts.publicDir, "CNAME"), `${opts.domain}\n`, "utf8");
    written.push("CNAME");
  }
  const index = stamp(await readFile(join(here, "templates", "index.html"), "utf8")).replace(
    'data-top-tab="off"',
    `data-top-tab="${opts.topTab ? "on" : "off"}"`,
  );
  await writeFile(join(opts.publicDir, "index.html"), index, "utf8");
  written.push("index.html");

  let about = stamp(await readFile(join(here, "templates", "about.html"), "utf8"));
  for (const locale of ["en", "sv"] as const) {
    const list = opts.config
      ? renderPublishers(opts.config, locale)
      : `<p class="muted">${locale === "sv" ? "Publicistlistan är inte tillgänglig." : "Publisher list unavailable."}</p>`;
    about = about.replace(`<!--PUBLISHERS:${locale}-->`, list);
  }
  await mkdir(join(opts.publicDir, "about"), { recursive: true });
  await writeFile(join(opts.publicDir, "about", "index.html"), about, "utf8");
  written.push("about/index.html");

  const privacy = stamp(await readFile(join(here, "templates", "privacy.html"), "utf8"));
  await mkdir(join(opts.publicDir, "privacy"), { recursive: true });
  await writeFile(join(opts.publicDir, "privacy", "index.html"), privacy, "utf8");
  written.push("privacy/index.html");

  // /version (human) and /version.json (machine): what this deployment was built from.
  if (opts.version) {
    const info = {
      version: opts.version.version,
      commit: opts.version.commit ?? null,
      built_at: new Date().toISOString(),
    };
    await writeFile(
      join(opts.publicDir, "version.json"),
      `${JSON.stringify(info, null, 2)}\n`,
      "utf8",
    );
    written.push("version.json");
    await mkdir(join(opts.publicDir, "version"), { recursive: true });
    await writeFile(join(opts.publicDir, "version", "index.html"), renderVersionPage(info), "utf8");
    written.push("version/index.html");
  }

  await mkdir(join(opts.publicDir, "assets"), { recursive: true });
  const logo = join(opts.appRoot, "assets", "logo");
  // Rasterized sizes come from `npm run logo` / `npm run cover` (scripts/) and are committed.
  const copies: [string, string][] = [
    [join(logo, "mark.svg"), "assets/logo.svg"],
    [join(logo, "favicon.ico"), "favicon.ico"],
    [join(logo, "png", "mark-180.png"), "assets/icon-180.png"],
    [join(logo, "png", "mark-192.png"), "assets/icon-192.png"],
    [join(logo, "png", "mark-512.png"), "assets/icon-512.png"],
    [join(opts.appRoot, "assets", "social", "og-1200x630.png"), "assets/og.png"],
    [join(opts.appRoot, "assets", "social", "og-sv-1200x630.png"), "assets/og-sv.png"],
    // Self-hosted typeface (SIL OFL; licence shipped alongside), so no font service is contacted.
    [
      join(opts.appRoot, "assets", "fonts", "manrope", "Manrope[wght].ttf"),
      "assets/fonts/manrope.ttf",
    ],
    [join(opts.appRoot, "assets", "fonts", "manrope", "OFL.txt"), "assets/fonts/OFL.txt"],
  ];
  await mkdir(join(opts.publicDir, "assets", "fonts"), { recursive: true });
  for (const [from, rel] of copies) {
    await copyFile(from, join(opts.publicDir, rel));
    written.push(rel);
  }
  return written;
}
