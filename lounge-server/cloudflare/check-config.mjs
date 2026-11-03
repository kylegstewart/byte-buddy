import { readFile } from "node:fs/promises";
import { allowedOrganizations } from "./relay.mjs";

const config = JSON.parse(await readFile(new URL("./wrangler.json", import.meta.url), "utf8"));
try {
    const organizations = allowedOrganizations(config.vars?.LOUNGE_ALLOWED_ORGS);
    console.log(`lounge: deployment allowlist: ${organizations}`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
