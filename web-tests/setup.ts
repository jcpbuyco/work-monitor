// RTL auto-cleanup only registers when a global `afterEach` exists. This project
// runs Vitest WITHOUT `globals: true` (tests import from "vitest" explicitly), so
// `@testing-library/react`'s built-in cleanup never fires on its own. Registering
// it here prevents rendered DOM from accumulating across tests in the same file.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
