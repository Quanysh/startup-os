// Writes convex/lib/osAgentDocs.ts from docs/agents/: the text of the four
// agents' files and of run.md, as the code's defaults of Startup OS's own
// agents (convex/lib/osAgentDefaults.ts). Convex cannot read a file at run
// time, so the text is carried in a module; convex/osAgentDefaults.test.ts
// fails when the module and the files differ.
//
//   pnpm gen:agent-docs
//
// Prints the files it read and nothing of their text.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OS_AGENT_DOC_FILES, renderDocsModule } from "./osAgentDocs";

const root = fileURLToPath(new URL("../", import.meta.url));
const texts = Object.fromEntries(
  OS_AGENT_DOC_FILES.map((file) => [file, readFileSync(`${root}docs/agents/${file}`, "utf8")]),
);
writeFileSync(`${root}convex/lib/osAgentDocs.ts`, renderDocsModule(texts));
console.log(`convex/lib/osAgentDocs.ts written from ${OS_AGENT_DOC_FILES.length} files in docs/agents/.`);
