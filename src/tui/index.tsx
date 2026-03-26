import { render } from "ink";

import { GhostboxTUI } from "./app";

export const runTui = async (): Promise<void> => {
  const app = render(<GhostboxTUI />);
  await app.waitUntilExit();
};

if (import.meta.main) {
  await runTui();
}
