// Live tests use the real network but only FREE calls. Claude is pointed at an unreachable
// address so a test can never spend Anthropic credits, and state goes to a temp file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.STATE_PATH = join(mkdtempSync(join(tmpdir(), "scout-live-")), "state.json");
